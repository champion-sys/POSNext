import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { CoalescingMutex } from "@/utils/mutex"
import { db } from "./db"
import { offlineState } from "./offlineState"
import {
	buildSyncEnvelope,
	classifySyncError,
	getQueueUpdateForResult,
	getRetryDelayMs,
	withOfflinePosting,
} from "./invoicePayload"
import { ENTITY_INVOICE, getEntity } from "./entities"
import { removeOfflineReceiptPayload } from "./offlineReceiptCache"
import { generateUUID } from "./uuid"

// Create namespaced logger for sync operations
const log = logger.create("Sync")

// Mutex for sync operations
const syncMutex = new CoalescingMutex({ timeout: 60000, name: "InvoiceSync" })

// ============================================================================
// CONSTANTS
// ============================================================================

const SYNC_CONFIG = {
	MAX_RETRY_COUNT: 3,
	CLEANUP_AGE_DAYS: 7,
	PING_TIMEOUT_MS: 3000,
	PROTOCOL_VERSION: 1,
	BATCH_SIZE: 20,
	STATUS_POLLS: 3,
	STATUS_POLL_DELAY_MS: 2000,
}

const DEVICE_ID_KEY = "pos_next_device_id"

// ============================================================================
// SERVER CONNECTIVITY
// ============================================================================

/**
 * Ping server to check connectivity
 * @returns {Promise<boolean>} Whether server is reachable
 */
export const pingServer = async () => {
	if (typeof window === "undefined") return true

	try {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), SYNC_CONFIG.PING_TIMEOUT_MS)

		const response = await fetch("/api/method/pos_next.api.ping", {
			method: "GET",
			signal: controller.signal,
		})

		clearTimeout(timeoutId)
		const isOnline = response.ok
		// Update centralized state (handles window sync automatically)
		offlineState.setServerOnline(isOnline)
		return isOnline
	} catch (error) {
		// Server unreachable
		offlineState.setServerOnline(false)
		return false
	}
}

/**
 * Check if currently offline
 * @returns {boolean}
 */
export const isOffline = () => {
	if (typeof window === "undefined") return false
	return offlineState.isOffline
}

// ============================================================================
// OFFLINE INVOICE QUEUE OPERATIONS
// ============================================================================

/**
 * Get all pending (unsynced) offline invoices
 * @returns {Promise<Array>}
 */
export const getOfflineInvoices = async () => {
	try {
		return await db.invoice_queue.filter((inv) => !inv.synced && !inv.superseded).toArray()
	} catch (error) {
		log.error("Failed to get offline invoices", error)
		return []
	}
}

/**
 * Look up a single queued offline invoice by its offline_id. Used to rebuild
 * a receipt payload after sessionStorage is wiped (e.g. a page refresh
 * between checkout and the auto-print).
 * @param {string} offlineId - pos_offline_<uuid>
 * @returns {Promise<Object|null>} The invoice data or null if not queued.
 */
export const getOfflineInvoiceByOfflineId = async (offlineId) => {
	if (!offlineId) return null
	try {
		const row = await db.invoice_queue.where("offline_id").equals(offlineId).first()
		return row?.data || null
	} catch (error) {
		log.error("Failed to look up offline invoice", { offlineId, error })
		return null
	}
}

/**
 * Wait for a specified duration
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ============================================================================
// SYNC OPERATIONS
// ============================================================================

/**
 * Increment retry count and optionally mark as failed
 * @param {Object} invoice - Invoice record
 * @param {string} errorMessage - Error message
 */
const handleSyncFailure = async (invoice, errorMessage) => {
	const newRetryCount = (invoice.retry_count || 0) + 1
	const updates = {
		retry_count: newRetryCount,
		error: errorMessage,
		next_attempt_at: Date.now() + getRetryDelayMs(newRetryCount),
	}

	if (newRetryCount >= SYNC_CONFIG.MAX_RETRY_COUNT) {
		updates.sync_failed = true
	}

	await db.invoice_queue.update(invoice.id, updates)
}

/**
 * Convert pricing_rules to comma-separated string.
 * Returns empty string for invalid/malformed values.
 */
const stringifyPricingRules = (value) => {
	if (!value) return ''
	if (Array.isArray(value)) return value.filter(Boolean).join(',')
	if (typeof value !== 'string') return ''

	const stripped = value.trim()
	if (!stripped.startsWith('[')) return stripped

	try {
		const parsed = JSON.parse(stripped)
		if (Array.isArray(parsed)) return parsed.filter(Boolean).join(',')
	} catch (e) {
		log.warn('Invalid pricing_rules JSON, clearing value', { value: stripped.slice(0, 100) })
		return ''
	}
	return ''
}

/**
 * Normalize invoice data for server sync.
 * Items should already be formatted by formatItemsForSubmission() when saved.
 * This provides a safety net for legacy data.
 */
const normalizeInvoiceForSync = (invoiceData, offlineId, queuedAt) => ({
	...withOfflinePosting(invoiceData, queuedAt),
	offline_id: offlineId || invoiceData.offline_id,
	items: invoiceData.items?.map((item) => ({
		...item,
		qty: item.qty || item.quantity || 1,
		pricing_rules: stringifyPricingRules(item.pricing_rules),
	})),
})

/**
 * A stable id for this browser, until device enrollment replaces it.
 * @returns {string}
 */
const getDeviceId = () => {
	let deviceId = localStorage.getItem(DEVICE_ID_KEY)
	if (!deviceId) {
		deviceId = generateUUID()
		localStorage.setItem(DEVICE_ID_KEY, deviceId)
	}
	return deviceId
}

/**
 * Apply the server's answer about one sale to its queue row
 * @param {Object} row - Queue row
 * @param {Object} result - Server result
 * @returns {Promise<string|null>} The row's new status
 */
const applyResult = async (row, result) => {
	const updates = getQueueUpdateForResult(result)
	if (!updates) return null

	await db.invoice_queue.update(row.id, updates)
	if (updates.synced) {
		removeOfflineReceiptPayload(row.offline_id)
		window.dispatchEvent(new CustomEvent("offlineEntitySynced", {
			detail: { row, status: updates.server_status, name: updates.server_invoice },
		}))
	}
	return updates.server_status
}

/**
 * Hand a batch of sales to the server. Once stored there, a sale's fate is the
 * server's job: this device only follows it.
 * @param {Array} rows - Queue rows
 * @returns {Promise<Map<string, Object>>} Results by offline_id
 */
const pushBatch = async (rows) => {
	const items = rows.map((row) => {
		const offlineId = row.offline_id || row.data?.offline_id
		const payload = getEntity(row) === ENTITY_INVOICE
			? normalizeInvoiceForSync(row.data, offlineId, row.timestamp)
			: { ...row.data, offline_id: offlineId }
		return buildSyncEnvelope(row, payload)
	})

	const response = await call("pos_next.api.sync.push", {
		items,
		device_id: getDeviceId(),
		client_version: typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : null,
		protocol_version: SYNC_CONFIG.PROTOCOL_VERSION,
	})

	return new Map((response?.results || []).map((result) => [result.offline_id, result]))
}

/**
 * Update rows the server already holds with how they ended
 * @param {Array} rows - Queue rows
 * @param {Object} result - Totals to update
 * @returns {Promise<number>} How many are still being processed
 */
const refreshServerStatus = async (rows, result) => {
	const byOfflineId = new Map(rows.map((row) => [row.offline_id, row]))
	const statuses = await call("pos_next.api.sync.get_status", {
		offline_ids: Array.from(byOfflineId.keys()),
	})

	let waiting = rows.length - (statuses?.length || 0)
	for (const status of statuses || []) {
		const row = byOfflineId.get(status.offline_id)
		const newStatus = row ? await applyResult(row, status) : null

		if (newStatus === "synced" && row.server_status !== "synced") {
			result.success++
		} else if (newStatus === "received" || newStatus === "processing") {
			waiting++
		} else if (newStatus === "needs_review" && row.server_status !== "needs_review") {
			result.failed++
			result.errors.push({
				invoiceId: row.id,
				offlineId: row.offline_id,
				customer: row.data?.customer || "Walk-in Customer",
				error: new Error(status.message || "Needs review"),
			})
		}
	}
	return waiting
}

/**
 * Push queued sales and collect the results of earlier ones.
 * Uses a mutex to ensure only one sync operation runs at a time.
 * Concurrent callers will wait for the ongoing sync and receive its result.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - Retry invoices still waiting out a backoff
 * @returns {Promise<{success: number, failed: number, skipped: number, errors: Array}>}
 */
export const syncOfflineInvoices = async ({ force = false } = {}) => {
	if (isOffline()) {
		log.debug("Cannot sync while offline")
		return { success: 0, failed: 0, skipped: 0, errors: [] }
	}

	return await syncMutex.withLock(async () => {
		const pendingInvoices = await getOfflineInvoices()

		if (!pendingInvoices.length) {
			return { success: 0, failed: 0, skipped: 0, errors: [] }
		}

		log.info(`Starting sync of ${pendingInvoices.length} invoice(s)`)

		const result = { success: 0, failed: 0, skipped: 0, waiting: 0, errors: [] }
		// A manual sync does not wait for a failed invoice's backoff
		const now = Date.now()
		const unsent = pendingInvoices.filter(
			(row) => !row.server_status && (force || (row.next_attempt_at || 0) <= now),
		)

		for (let i = 0; i < unsent.length; i += SYNC_CONFIG.BATCH_SIZE) {
			const batch = unsent.slice(i, i + SYNC_CONFIG.BATCH_SIZE)

			try {
				const results = await pushBatch(batch)
				for (const row of batch) {
					const answer = results.get(row.offline_id)
					if (answer?.status === "rejected") {
						await handleSyncFailure(row, answer.message)
						result.failed++
					} else if (answer) {
						await applyResult(row, answer)
					}
				}
			} catch (error) {
				log.error("Failed to push invoices", { error })

				// The connection or session failed, not these invoices. The rest of the
				// queue would fail the same way, so stop without counting a failure.
				if (classifySyncError(error) !== "invoice") {
					log.warn("Sync paused", { reason: classifySyncError(error) })
					break
				}

				for (const row of batch) {
					await handleSyncFailure(row, error.message)
					result.errors.push({
						invoiceId: row.id,
						offlineId: row.offline_id,
						customer: row.data?.customer || "Walk-in Customer",
						error,
					})
					result.failed++
				}
			}
		}

		// Give the background job a moment, the rest is picked up by the next sync
		for (let poll = 0; poll < SYNC_CONFIG.STATUS_POLLS; poll++) {
			const held = (await getOfflineInvoices()).filter((row) => row.server_status)
			if (!held.length) break

			try {
				result.waiting = await refreshServerStatus(held, result)
				if (result.waiting === 0) break
			} catch (error) {
				log.warn("Could not read sync status", { error })
				break
			}
			await sleep(SYNC_CONFIG.STATUS_POLL_DELAY_MS)
		}

		// Let the POS replace local batch and serial figures with server values
		if (result.success > 0 && typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("offlineInvoicesSynced", { detail: result }))
		}

		// Cleanup old synced invoices
		await cleanupSyncedInvoices()

		log.info("Sync completed", {
			success: result.success,
			skipped: result.skipped,
			failed: result.failed,
		})

		return result
	}, log.debug.bind(log))
}

/**
 * Clean up synced invoices older than configured days
 */
const cleanupSyncedInvoices = async () => {
	const cutoff = Date.now() - SYNC_CONFIG.CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000
	await db.invoice_queue
		.filter((inv) => inv.synced && inv.timestamp < cutoff)
		.delete()
}

// ============================================================================
// INVOICE HISTORY CACHE OPERATIONS
// ============================================================================

/**
 * Cache invoice history for offline viewing
 * @param {Array} invoices - Array of invoice objects
 * @param {string} posProfile - POS Profile name
 * @returns {Promise<boolean>}
 */
export const cacheInvoiceHistory = async (invoices, posProfile) => {
	if (!invoices || invoices.length === 0) return false

	try {
		// Clean data and add pos_profile for filtering
		const invoicesToCache = invoices.map((invoice) => ({
			...JSON.parse(JSON.stringify(invoice)),
			pos_profile: posProfile,
			cached_at: Date.now(),
		}))

		await db.invoice_history.bulkPut(invoicesToCache)
		log.info(`Cached ${invoices.length} invoices for offline viewing`)
		return true
	} catch (error) {
		log.error("Failed to cache invoice history", error)
		return false
	}
}

/**
 * Get cached invoice history for offline viewing
 * @param {string} posProfile - POS Profile name (optional filter)
 * @param {Object} options - Query options
 * @param {number} options.limit - Max number of invoices to return
 * @param {string} options.customer - Filter by customer name
 * @param {string} options.fromDate - Filter by posting_date >= fromDate
 * @param {string} options.toDate - Filter by posting_date <= toDate
 * @returns {Promise<Array>}
 */
export const getCachedInvoiceHistory = async (posProfile, options = {}) => {
	try {
		const { limit = 100, customer, fromDate, toDate } = options

		let query = db.invoice_history

		// Filter by POS profile if provided
		if (posProfile) {
			query = query.where("pos_profile").equals(posProfile)
		}

		let invoices = await query.toArray()

		// Apply additional filters
		if (customer) {
			invoices = invoices.filter((inv) =>
				inv.customer?.toLowerCase().includes(customer.toLowerCase()),
			)
		}

		if (fromDate) {
			invoices = invoices.filter((inv) => inv.posting_date >= fromDate)
		}

		if (toDate) {
			invoices = invoices.filter((inv) => inv.posting_date <= toDate)
		}

		// Sort by posting_date descending (newest first)
		invoices.sort((a, b) => {
			const dateA = new Date(b.posting_date + " " + (b.posting_time || "00:00:00"))
			const dateB = new Date(a.posting_date + " " + (a.posting_time || "00:00:00"))
			return dateA - dateB
		})

		return invoices.slice(0, limit)
	} catch (error) {
		log.error("Failed to get cached invoice history", error)
		return []
	}
}

/**
 * Clear cached invoice history
 * @param {string} posProfile - Optional POS Profile to clear (clears all if not provided)
 * @returns {Promise<boolean>}
 */
export const clearInvoiceHistoryCache = async (posProfile) => {
	try {
		if (posProfile) {
			await db.invoice_history.where("pos_profile").equals(posProfile).delete()
		} else {
			await db.invoice_history.clear()
		}
		log.info("Invoice history cache cleared")
		return true
	} catch (error) {
		log.error("Failed to clear invoice history cache", error)
		return false
	}
}

// ============================================================================
// UNPAID INVOICES CACHE OPERATIONS
// ============================================================================

/**
 * Cache unpaid invoices for offline viewing
 * @param {Array} invoices - Array of unpaid invoice objects
 * @param {string} posProfile - POS Profile name
 * @returns {Promise<boolean>}
 */
export const cacheUnpaidInvoices = async (invoices, posProfile) => {
	if (!invoices || invoices.length === 0) {
		// Clear existing cache if no invoices
		try {
			await db.unpaid_invoices.where("pos_profile").equals(posProfile).delete()
		} catch (e) {
			// Ignore errors on clear
		}
		return true
	}

	try {
		// Clean data and add pos_profile for filtering
		const invoicesToCache = invoices.map((invoice) => ({
			...JSON.parse(JSON.stringify(invoice)),
			pos_profile: posProfile,
			cached_at: Date.now(),
		}))

		// Clear existing cache for this profile first
		await db.unpaid_invoices.where("pos_profile").equals(posProfile).delete()

		// Add new data
		await db.unpaid_invoices.bulkPut(invoicesToCache)
		log.info(`Cached ${invoices.length} unpaid invoices for offline viewing`)
		return true
	} catch (error) {
		log.error("Failed to cache unpaid invoices", error)
		return false
	}
}

/**
 * Get cached unpaid invoices for offline viewing
 * @param {string} posProfile - POS Profile name
 * @param {Object} options - Query options
 * @param {number} options.limit - Max number of invoices to return
 * @returns {Promise<Array>}
 */
export const getCachedUnpaidInvoices = async (posProfile, options = {}) => {
	try {
		const { limit = 100 } = options

		if (!posProfile) {
			return []
		}

		let invoices = await db.unpaid_invoices
			.where("pos_profile")
			.equals(posProfile)
			.toArray()

		// Sort by outstanding_amount descending (highest first)
		invoices.sort((a, b) => {
			const amountA = parseFloat(b.outstanding_amount || 0)
			const amountB = parseFloat(a.outstanding_amount || 0)
			return amountA - amountB
		})

		return invoices.slice(0, limit)
	} catch (error) {
		log.error("Failed to get cached unpaid invoices", error)
		return []
	}
}

/**
 * Cache unpaid invoice summary for offline viewing
 * @param {Object} summary - Summary object with count, total_outstanding, total_paid
 * @param {string} posProfile - POS Profile name
 * @returns {Promise<boolean>}
 */
export const cacheUnpaidSummary = async (summary, posProfile) => {
	try {
		await db.settings.put({
			key: `unpaid_summary_${posProfile}`,
			value: {
				...summary,
				cached_at: Date.now(),
			},
		})
		log.debug("Cached unpaid invoice summary")
		return true
	} catch (error) {
		log.error("Failed to cache unpaid summary", error)
		return false
	}
}

/**
 * Get cached unpaid invoice summary
 * @param {string} posProfile - POS Profile name
 * @returns {Promise<Object>}
 */
export const getCachedUnpaidSummary = async (posProfile) => {
	try {
		const result = await db.settings.get(`unpaid_summary_${posProfile}`)
		return result?.value || { count: 0, total_outstanding: 0, total_paid: 0 }
	} catch (error) {
		log.error("Failed to get cached unpaid summary", error)
		return { count: 0, total_outstanding: 0, total_paid: 0 }
	}
}
