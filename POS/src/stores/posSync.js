/**
 * POS Sync Store
 *
 * Manages offline synchronization state and operations for the POS system.
 * Handles invoice caching, sync operations, and offline state management.
 *
 * Key Design Decision:
 * This store subscribes directly to offlineState instead of using the useOffline()
 * composable. This is intentional because Pinia stores are singletons that persist
 * across component remounts (e.g., when changing language). Using Vue lifecycle
 * hooks (onMounted/onUnmounted) from composables would cause the subscription to
 * break when components remount.
 *
 * @module stores/posSync
 */

import {
	abandonLocalShift,
	adoptServerShift,
	clearShiftClosing,
	markShiftClosing,
	openLocalShift,
} from "@/composables/useShift"
import { useToast } from "@/composables/useToast"
import { STOCK_ENTITIES } from "@/core/sync/pullEngine"
import { pullChanges } from "@/core/sync/webPull"
import { isPastOfflineSaleLimit } from "@/platform/auth"
import { isNative } from "@/platform/runtime"
import {
	cacheCustomersFromServer,
	cachePaymentMethodsFromServer,
	cacheSalesPersonsFromServer,
	syncOfflineInvoices,
	cacheInvoiceHistory,
	cacheUnpaidInvoices,
	cacheUnpaidSummary,
	announceRecordEnded,
} from "@/utils/offline"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { getSetting, setSetting } from "@/utils/offline/settings"
import {
	ENTITY_CUSTOMER,
	ENTITY_PAYMENT,
	ENTITY_SHIFT_CLOSE,
	ENTITY_SHIFT_OPEN,
	applyQueuedPayments,
	buildCustomerPayload,
	buildLocalCustomer,
	buildLocalShift,
	buildPaymentPayload,
	buildReturnDocFromQueue,
	buildShiftClosePayload,
	buildShiftOpenPayload,
	countQueuedCouponUses,
	exceedsOutstanding,
	getCachedCouponProblem,
	getDependentRows,
	getEntity,
	getShiftManifest,
	getUnfinishedCloses,
	isLocalName,
	isReturnableQueueRow,
	subtractQueuedReturns,
} from "@/utils/offline/entities"
import {
	SALE_STANDS,
	SYNC_PERIODIC,
	formatLocalPosting,
	getQueueUpdateForResult,
	sumQueuedStock,
} from "@/utils/offline/invoicePayload"
import { offlineState } from "@/utils/offline/offlineState"
import { generateOfflineId } from "@/utils/offline/uuid"
import { offlineWorker } from "@/utils/offline/workerClient"
import { isWaitingToSend, needsAttention } from "@/utils/syncQueue"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSShiftStore } from "@/stores/posShift"
import { useStockStore } from "@/stores/stock"
import { defineStore } from "pinia"
import { computed, ref } from "vue"

const log = logger.create('POSSync')

/** How often to check whether the periodic sync from POS Settings is due */
const SYNC_TICK_MS = 60 * 1000

/** Wait for the app to settle before the sync on opening */
const STARTUP_SYNC_DELAY_MS = 5000

/** How often to ask the server what changed */
const PULL_INTERVAL_MS = 15 * 60 * 1000

/** How often the apps, which have no socket, ask whether stock moved */
const STOCK_PULL_INTERVAL_MS = 60 * 1000

const STORAGE_WARNING_KEY = "pos_next_storage_warning_shown"
const LAST_SYNC_KEY = "pos_next_last_invoice_sync"

const COUPONS_CACHE_PREFIX = "offline_coupons_"
const RETURN_DOCUMENTS_CACHE_PREFIX = "offline_return_documents_"
const RETURN_DOCUMENTS_LIMIT = 100

export const usePOSSyncStore = defineStore("posSync", () => {
	// =========================================================================
	// STATE
	// =========================================================================

	/** Current offline status - synced with offlineState singleton */
	const isOffline = ref(offlineState.isOffline)

	/** Number of invoices pending sync */
	const pendingInvoicesCount = ref(0)

	/** Whether a sync operation is in progress */
	const isSyncing = ref(false)

	/** Current connection quality metrics */
	const connectionQuality = ref(offlineState.getConnectionQuality())

	/** List of pending invoices for display */
	const pendingInvoicesList = ref([])

	/** When a sale last reached the server from this device */
	const lastSyncedAt = ref(Number(localStorage.getItem(LAST_SYNC_KEY)) || null)

	let isListeningForResults = false
	let lastAutoSyncAt = Date.now()
	let isWaitingForServer = false

	/** Track previous offline state for detecting online/offline transitions */
	let wasOffline = offlineState.isOffline

	// =========================================================================
	// TOAST NOTIFICATIONS
	// =========================================================================

	const { showSuccess, showError, showWarning } = useToast()

	// =========================================================================
	// OFFLINE STATE SUBSCRIPTION
	// =========================================================================

	/**
	 * Subscribe to offlineState changes at the store level.
	 * This subscription persists for the app's lifetime since Pinia stores are singletons.
	 */
	offlineState.subscribe(async (state) => {
		const nowOffline = state.isOffline

		// Update reactive state
		isOffline.value = nowOffline
		connectionQuality.value = state.quality || offlineState.getConnectionQuality()

		// Auto-sync when transitioning from offline to online
		if (wasOffline && !nowOffline) {
			log.info('Transition to online detected, auto-syncing pending invoices')
			await autoSync()
			pullServerChanges()
		}

		wasOffline = nowOffline
	})

	// =========================================================================
	// COMPUTED
	// =========================================================================

	/** Whether there are any pending invoices to sync */
	const hasPendingInvoices = computed(() => pendingInvoicesCount.value > 0)

	/** Sales that exist only on this device, on their way to the server */
	const queuedCount = computed(() => pendingInvoicesList.value.filter(isWaitingToSend).length)

	/** Invoices that will not clear until a person looks at them */
	const reviewCount = computed(() => pendingInvoicesList.value.filter(needsAttention).length)

	// =========================================================================
	// INTERNAL HELPERS
	// =========================================================================

	/**
	 * Update the pending invoices count from the worker
	 */
	async function updatePendingCount() {
		try {
			pendingInvoicesCount.value = await offlineWorker.getOfflineInvoiceCount()
			await refreshQueuedStock()
		} catch (error) {
			log.error('Failed to get pending invoice count', error)
		}
	}

	/**
	 * Keep the rows current and hold stock for queued sales, so the same units
	 * cannot be sold twice
	 */
	async function refreshQueuedStock() {
		const stockStore = useStockStore()
		const rows = await getPending()
		pendingInvoicesList.value = rows
		stockStore.setQueued(sumQueuedStock(rows, stockStore.warehouse))
	}

	function markSynced() {
		lastSyncedAt.value = Date.now()
		localStorage.setItem(LAST_SYNC_KEY, String(lastSyncedAt.value))
	}

	/**
	 * Ask the platform not to evict the queue under storage pressure
	 * @returns {Promise<boolean>} Whether the storage is protected
	 */
	async function ensurePersistentStorage() {
		try {
			return await offlineWorker.requestPersistentStorage()
		} catch (error) {
			log.warn('Could not request persistent storage', error)
			return false
		}
	}

	/**
	 * Warn once per session when queued sales sit in evictable storage
	 */
	async function warnIfStorageNotPersistent() {
		if (await ensurePersistentStorage()) return
		if (sessionStorage.getItem(STORAGE_WARNING_KEY)) return
		sessionStorage.setItem(STORAGE_WARNING_KEY, "1")
		showWarning(__("This browser may clear offline invoices when storage is low. Connect soon to sync them."))
	}

	/**
	 * The server reports how a held sale ended. The next sync would find out
	 * anyway, this only makes it quicker.
	 */
	function listenForServerResults() {
		const realtime = window.frappe?.realtime
		if (isListeningForResults || !realtime?.on) return
		isListeningForResults = true
		realtime.on("pos_sync_status", () => autoSync())
	}

	/**
	 * Sync in the background. Web Locks keeps it to one tab, and the server
	 * still dedupes if a browser lacks them.
	 */
	async function autoSync() {
		const { session } = await import("@/data/session")
		if (!session.isLoggedIn || isOffline.value || isSyncing.value) return

		lastAutoSyncAt = Date.now()
		listenForServerResults()

		await updatePendingCount()
		if (pendingInvoicesCount.value === 0) return

		const run = async () => {
			try {
				await syncPending()
			} catch (error) {
				log.error('Auto-sync failed', error)
			}
		}

		if (navigator.locks) {
			await navigator.locks.request(
				"pos_next_invoice_sync",
				{ ifAvailable: true },
				async (lock) => {
					if (lock) await run()
				},
			)
		} else {
			await run()
		}
	}

	/**
	 * Bring down what changed on the server
	 * @param {string[]} [only] - Pull just these instead of everything
	 */
	async function pullServerChanges(only) {
		try {
			const { session } = await import("@/data/session")
			if (!session.isLoggedIn || isOffline.value) return

			await pullChanges(usePOSShiftStore().profileName, only)
		} catch (error) {
			log.warn('Pull from the server failed', error)
		}
	}

	/**
	 * Sync pending invoices to the server
	 * @throws {Error} If called while offline
	 */
	async function syncPending(options = {}) {
		if (isOffline.value) {
			throw new Error("Cannot sync while offline")
		}

		isSyncing.value = true
		try {
			const stockStore = useStockStore()
			// A void the server refuses leaves a sale that holds nothing here any more
			const voidCodes = pendingInvoicesList.value
				.filter((row) => row.void_reason)
				.flatMap((row) => row.data?.items?.map((item) => item.item_code) || [])
			const soldCodes = [...stockStore.queued.keys(), ...voidCodes]
			const result = await syncOfflineInvoices(options)
			isWaitingForServer = result.waiting > 0
			await updatePendingCount()

			// A sale the server took has left the device, even if it is still working on it
			if (result.success > 0 || result.delivered > 0) markSynced()

			if (result.voided > 0) showSuccess(__("{0} record(s) voided", [result.voided]))
			if (result.saleStands > 0) {
				showWarning(__("{0} record(s) were already on the server, so they were not voided", [result.saleStands]))
			}

			// The server's numbers now include these sales
			if ((result.success > 0 || result.saleStands > 0) && soldCodes.length > 0) {
				stockStore.refresh(soldCodes, stockStore.warehouse).catch((error) => {
					log.warn('Stock refresh after sync failed', error)
				})
			}
			return result
		} catch (error) {
			log.error('Failed to sync invoices', error)
			throw error
		} finally {
			isSyncing.value = false
		}
	}

	/**
	 * Get all pending invoices from the worker
	 */
	async function getPending() {
		return await offlineWorker.getOfflineInvoices()
	}

	/**
	 * Cache items and customers for offline use
	 * @param {Array} items - Items to cache
	 * @param {Array} customers - Customers to cache
	 */
	async function cacheData(items, customers) {
		try {
			if (items?.length > 0) {
				await offlineWorker.cacheItems(items)
			}
			if (customers?.length > 0) {
				await offlineWorker.cacheCustomers(customers)
			}
			return true
		} catch (error) {
			log.error('Failed to cache data', error)
			return false
		}
	}

	// =========================================================================
	// PUBLIC ACTIONS
	// =========================================================================

	/**
	 * Refuse a return or payment this device may no longer take offline, as a sale is
	 * refused. Only without a connection: work in a shift opened offline queues online too.
	 * @param {string} message - What was not saved
	 */
	function assertWithinOfflineLimit(message) {
		if (!isOffline.value || !isPastOfflineSaleLimit()) return
		throw Object.assign(new Error(message), { title: __("Offline limit reached") })
	}

	/**
	 * Save an invoice offline for later sync
	 * @param {Object} invoiceData - Invoice data to save
	 * @param {Object} [options]
	 * @param {number} [options.supersedesId] - Queue row this invoice replaces
	 */
	async function saveInvoiceOffline(invoiceData, options = {}) {
		try {
			const result = await offlineWorker.saveOfflineInvoice(invoiceData, options)
			await updatePendingCount()
			warnIfStorageNotPersistent()

			// Periodic mode batches sales on purpose, for weak connections
			if (usePOSSettingsStore().syncMode !== SYNC_PERIODIC) {
				autoSync().catch((error) => log.error('Sync after saving failed', error))
			}
			log.info('Invoice saved offline successfully')
			return result || { success: true }
		} catch (error) {
			log.error('Failed to save invoice offline', error)
			throw error
		}
	}

	/**
	 * Queue a return. The dialog stays open on a refusal, so nothing typed is lost.
	 * @param {Object} invoiceData - Return invoice
	 * @returns {Promise<{offline_id: string}>}
	 */
	async function saveReturnOffline(invoiceData) {
		assertWithinOfflineLimit(
			__("This device has been offline too long, so this return was not saved. Connect to the server and sign in with your password to finish it."),
		)
		return saveInvoiceOffline(invoiceData)
	}

	/**
	 * Queue a record that is not a sale
	 * @param {string} entity - One of the ENTITY constants
	 * @param {Object} data - Its payload
	 * @param {string[]} [dependsOn] - Offline IDs that must finish first
	 * @returns {Promise<{id: number, offline_id: string}>}
	 */
	async function saveQueueEntity(entity, data, dependsOn = []) {
		// Chosen here, so a save the store re-sends cannot become a second record
		const record = { ...data, offline_id: data.offline_id || generateOfflineId() }
		const result = await offlineWorker.saveQueueEntity(entity, record, dependsOn)
		await updatePendingCount()
		warnIfStorageNotPersistent()

		if (usePOSSettingsStore().syncMode !== SYNC_PERIODIC) {
			autoSync().catch((error) => log.error("Sync after queueing failed", error))
		}
		return result
	}

	/**
	 * Queue a new customer. Its offline_id is its name until the server gives it one.
	 * @param {Object} customer - The form's values
	 * @param {{posProfile: string, company: string}} context
	 * @returns {Promise<Object>} The customer to sell to meanwhile
	 */
	async function saveCustomerOffline(customer, { posProfile, company }) {
		const { session } = await import("@/data/session")
		const payload = buildCustomerPayload(customer, {
			offlineId: generateOfflineId(),
			posProfile,
			company,
			cashier: session.user,
		})
		await saveQueueEntity(ENTITY_CUSTOMER, payload)
		return buildLocalCustomer(payload)
	}

	/**
	 * Queue a payment on an invoice the server already has
	 * @param {Object} invoice - The invoice, as withQueuedPayments reports it
	 * @param {Array} payments - The payment dialog's entries
	 * @returns {Promise<{id: number, offline_id: string}>}
	 */
	async function savePaymentOffline(invoice, payments) {
		assertWithinOfflineLimit(
			__("This device has been offline too long, so this payment was not saved. Connect to the server and sign in with your password to finish it."),
		)

		if (exceedsOutstanding(invoice, payments)) {
			throw new Error(__("Total payment amount exceeds the outstanding amount of {0}", [invoice.name]))
		}

		const { session } = await import("@/data/session")
		const shiftStore = usePOSShiftStore()
		const shift = shiftStore.currentShift?.name
		return saveQueueEntity(
			ENTITY_PAYMENT,
			buildPaymentPayload({
				invoice,
				payments,
				posProfile: shiftStore.profileName,
				shift,
				cashier: session.user,
			}),
			[shift].filter(isLocalName),
		)
	}

	/**
	 * Show unpaid invoices as they will be once queued payments have reached the server
	 * @param {Array} invoices
	 * @returns {Promise<Array>}
	 */
	async function withQueuedPayments(invoices) {
		return applyQueuedPayments(invoices, await getPending())
	}

	/**
	 * Check a coupon against the last copy from the server and this device's queue
	 * @param {string} code
	 * @param {{posProfile: string, customer: string, company: string}} context
	 * @returns {Promise<{coupon: Object|undefined, problem: string|null}>}
	 */
	async function checkCouponOffline(code, { posProfile, customer, company }) {
		const coupons = (await getSetting(`${COUPONS_CACHE_PREFIX}${posProfile}`)) || []
		const coupon = coupons.find((row) => row.coupon_code?.toUpperCase() === code.toUpperCase())
		const problem = getCachedCouponProblem(coupon, {
			customer,
			company,
			today: formatLocalPosting().posting_date,
			...countQueuedCouponUses(await getPending(), code, customer),
		})
		return { coupon, problem }
	}

	/**
	 * Keep prepared returns of recent invoices on this device. Empty on the
	 * server unless POS Settings allows offline returns.
	 * @param {string} posProfile
	 */
	async function refreshReturnDocuments(posProfile) {
		const documents = await call("pos_next.api.invoices.get_offline_return_documents", {
			pos_profile: posProfile,
			pos_opening_shift: usePOSShiftStore().currentShift?.name,
			limit: RETURN_DOCUMENTS_LIMIT,
		})
		await setSetting(`${RETURN_DOCUMENTS_CACHE_PREFIX}${posProfile}`, {
			cached_at: Date.now(),
			documents: documents || [],
		})
	}

	/**
	 * What can be returned with no server to ask: the kept documents, and sales
	 * still in the queue. Returns already queued are taken off both.
	 * @param {string} posProfile
	 * @returns {Promise<Array>} Prepared returns, by return_against
	 */
	async function getOfflineReturnDocuments(posProfile) {
		const settingsStore = usePOSSettingsStore()
		const rows = await offlineWorker.getQueueRows()
		const cached = await getSetting(`${RETURN_DOCUMENTS_CACHE_PREFIX}${posProfile}`)

		const kept = (cached?.documents || []).map((doc) => ({ ...doc, _cached_at: cached.cached_at }))
		const keptNames = new Set(kept.map((doc) => doc.return_against))
		const rules = {
			allow_return: settingsStore.allowReturn,
			return_validity_days: settingsStore.settings.return_validity_days,
		}
		const queued = rows
			.filter(isReturnableQueueRow)
			.map((row) => buildReturnDocFromQueue(row, rules))
			.filter((doc) => !keptNames.has(doc.return_against))

		return [...queued, ...kept].map((doc) => subtractQueuedReturns(doc, rows))
	}

	/**
	 * Queue a shift close behind every sale of the shift. The server finalizes it
	 * once they have all arrived, and works out the totals itself.
	 * @param {Object} closing - The draft from buildClosingDraft, with what was counted
	 * @returns {Promise<{id: number, offline_id: string}>}
	 */
	async function saveShiftCloseOffline(closing) {
		const { session } = await import("@/data/session")
		const shift = closing.pos_opening_shift
		const manifest = getShiftManifest(await offlineWorker.getQueueRows(), shift, closing.opening_offline_id)
		const payload = buildShiftClosePayload({ closing, manifest, cashier: session.user })

		const result = await saveQueueEntity(ENTITY_SHIFT_CLOSE, payload, [...[shift].filter(isLocalName), ...manifest])
		markShiftClosing(shift)
		return result
	}

	/**
	 * Open a shift with no server to ask. It sells under a local name, the way a customer
	 * added offline does, and everything in it depends on this record.
	 * @param {{pos_profile: Object, company: Object}} cached - From getCachedShiftProfiles
	 * @param {Array} balanceDetails - The dialog's opening amounts
	 */
	async function saveShiftOpenOffline(cached, balanceDetails) {
		if (usePOSShiftStore().hasOpenShift) {
			throw new Error(__("A shift is already open on this device"))
		}

		const { session } = await import("@/data/session")
		const payload = buildShiftOpenPayload({
			offlineId: generateOfflineId(),
			posProfile: cached.pos_profile.name,
			company: cached.pos_profile.company,
			cashier: session.user,
			balanceDetails,
		})

		const closes = getUnfinishedCloses(await offlineWorker.getQueueRows())
		await saveQueueEntity(ENTITY_SHIFT_OPEN, payload, closes)
		await openLocalShift(buildLocalShift(payload, cached))
	}

	/**
	 * The server finished with a shift opened on this device.
	 * @param {{row: Object, status: string, name: string}} detail - From offlineEntitySynced
	 */
	async function settleLocalShift({ row, status, name }) {
		if (status === "voided") {
			if (await abandonLocalShift(row.offline_id)) {
				showWarning(__("A manager voided the shift opened on this device. Open a new shift to keep selling."))
			}
			return
		}

		// A manager may have linked it to a colleague's shift, and only the server can say
		if (await adoptServerShift(row.offline_id, name)) {
			usePOSShiftStore().checkOpeningShift.fetch().catch((error) => {
				log.warn("Could not read the shift back from the server", error)
			})
		}
	}

	/**
	 * Load the list of pending invoices for display
	 */
	async function loadPendingInvoices() {
		try {
			pendingInvoicesList.value = await getPending()
		} catch (error) {
			log.error('Failed to load pending invoices', error)
			pendingInvoicesList.value = []
		}
	}

	/**
	 * Ask the server to void a queued record. A receipt may be with the customer and the
	 * server may already hold it, so it stays here, holding nothing, until the server answers.
	 * @param {number} id - Queue row
	 * @param {string} reason - Why, which the server keeps
	 */
	async function requestVoid(id, reason) {
		try {
			const why = reason?.trim()
			if (!why) throw new Error(__("A reason is required"))

			const rows = await getPending()
			const row = rows.find((candidate) => candidate.id === id)
			if (row && [ENTITY_SHIFT_CLOSE, ENTITY_SHIFT_OPEN].includes(getEntity(row))) {
				throw new Error(__("A shift cannot be voided"))
			}
			if (row && getDependentRows(rows, row.offline_id).length > 0) {
				throw new Error(__("Other queued records depend on this one, so it cannot be voided"))
			}

			const { success } = await offlineWorker.requestVoid(id, why)
			if (!success) throw new Error(__("This record can no longer be voided. It may already have finished"))

			// No new sale may come to need a customer that is on its way out
			if (row && getEntity(row) === ENTITY_CUSTOMER) announceRecordEnded(row, "voided")

			await updatePendingCount()
			showSuccess(__("Void requested. It stays in the queue until the server answers"))

			if (usePOSSettingsStore().syncMode !== SYNC_PERIODIC) {
				autoSync().catch((error) => log.error("Sync after a void request failed", error))
			}
		} catch (error) {
			log.error("Failed to request a void", error)
			showError(error.message || __("Could not request the void"))
			throw error
		}
	}

	/**
	 * The cashier has seen that a void came too late, so the record can leave the queue
	 * like any other that reached the server
	 * @param {number} id - Queue row
	 */
	async function acknowledgeSaleStands(id) {
		const row = (await getPending()).find((candidate) => candidate.id === id)
		if (row?.server_status !== SALE_STANDS) return

		await offlineWorker.updateQueuedInvoice(
			id,
			getQueueUpdateForResult({ status: "synced", invoice: row.server_invoice }),
		)
		await updatePendingCount()
	}

	/**
	 * Sync all pending invoices with user feedback
	 * @returns {Object} Sync result with success/failed counts
	 */
	async function syncAllPending() {
		if (isOffline.value) {
			showWarning(__("Cannot sync while offline"))
			return { success: 0, failed: 0, errors: [] }
		}

		try {
			const result = await syncPending({ force: true })

			if (result.success > 0) {
				showSuccess(__('{0} invoice(s) synced successfully', [result.success]))
				await loadPendingInvoices()
			}

			return result
		} catch (error) {
			log.error('Sync all pending failed', error)
			throw error
		}
	}

	/**
	 * Preload data for offline use (payment methods, customers)
	 * @param {Object} currentProfile - Current POS profile
	 */
	let _preloadingProfile = null
	async function preloadDataForOffline(currentProfile) {
		if (!currentProfile || isOffline.value) {
			return
		}

		// Prevent duplicate concurrent preloads (e.g., from component remounts
		// triggered by language/translation version changes)
		if (_preloadingProfile === currentProfile.name) {
			log.debug('Preload already in progress for this profile, skipping duplicate')
			return
		}
		_preloadingProfile = currentProfile.name

		try {
			const cacheReady = await checkCacheReady()
			const stats = await getCacheStats()
			const needsRefresh = !stats.lastSync || Date.now() - stats.lastSync > 24 * 60 * 60 * 1000

			// Always load payment methods for reliable offline support
			log.info('Loading payment methods for offline use')
			try {
				const paymentMethodsData = await cachePaymentMethodsFromServer(currentProfile.name)

				if (paymentMethodsData.payment_methods?.length > 0) {
					const methodsWithProfile = paymentMethodsData.payment_methods.map((method) => ({
						...method,
						pos_profile: currentProfile.name,
					}))
					await offlineWorker.cachePaymentMethods(methodsWithProfile)
					log.success(`Cached ${methodsWithProfile.length} payment methods`)
				}
			} catch (error) {
				log.error('Failed to load payment methods', error)
				// Continue with other data loading
			}

			// Cache sales persons for offline use
			try {
				const salesPersonsData = await cacheSalesPersonsFromServer(currentProfile.name)
				if (salesPersonsData.sales_persons?.length > 0) {
					const personsWithProfile = salesPersonsData.sales_persons.map((person) => ({
						...person,
						pos_profile: currentProfile.name,
					}))
					await offlineWorker.cacheSalesPersons(personsWithProfile)
					log.success(`Cached ${personsWithProfile.length} sales persons`)
				}
			} catch (error) {
				log.error('Failed to load sales persons', error)
			}

			// Load customers if cache needs refresh
			if (!cacheReady || needsRefresh) {
				showSuccess(__("Loading customers for offline use..."))

				const customersData = await cacheCustomersFromServer(currentProfile.name)
				await cacheData([], customersData.customers || [])

				showSuccess(__("Data is ready for offline use"))
			}

			refreshReturnDocuments(currentProfile.name).catch((error) => {
				log.error("Failed to load returnable invoices", error)
			})

			try {
				const coupons = await call("pos_next.api.offers.get_offline_coupons", {
					pos_profile: currentProfile.name,
				})
				await setSetting(`${COUPONS_CACHE_PREFIX}${currentProfile.name}`, coupons || [])
			} catch (error) {
				log.error("Failed to load coupons", error)
			}

			// Preload invoice history and unpaid invoices in parallel for faster startup
			log.info('Loading invoice data for offline use')
			try {
				const [invoices, unpaidInvoices, unpaidSummary] = await Promise.all([
					call("pos_next.api.invoices.get_invoices", {
						pos_profile: currentProfile.name,
						limit: 100,
					}).catch(err => {
						log.error('Failed to load invoice history', err)
						return []
					}),
					call("pos_next.api.partial_payments.get_unpaid_invoices", {
						pos_profile: currentProfile.name,
						limit: 100,
					}).catch(err => {
						log.error('Failed to load unpaid invoices', err)
						return []
					}),
					call("pos_next.api.partial_payments.get_unpaid_summary", {
						pos_profile: currentProfile.name,
					}).catch(err => {
						log.error('Failed to load unpaid summary', err)
						return null
					}),
				])

				// Cache results in parallel
				await Promise.all([
					invoices?.length > 0
						? cacheInvoiceHistory(invoices, currentProfile.name).then(() =>
							log.success(`Cached ${invoices.length} invoices for offline viewing`)
						)
						: Promise.resolve(),
					unpaidInvoices?.length > 0
						? cacheUnpaidInvoices(unpaidInvoices, currentProfile.name).then(() =>
							log.success(`Cached ${unpaidInvoices.length} unpaid invoices for offline viewing`)
						)
						: Promise.resolve(),
					unpaidSummary
						? cacheUnpaidSummary(unpaidSummary, currentProfile.name).then(() =>
							log.debug('Cached unpaid invoice summary')
						)
						: Promise.resolve(),
				])
			} catch (error) {
				log.error('Failed to load invoice data for offline', error)
				// Continue - not critical for POS operation
			}
		} catch (error) {
			log.error('Failed to preload offline data', error)
			showWarning(__("Some data may not be available offline"))
		} finally {
			_preloadingProfile = null
		}

		// Not awaited: the sale page waits for this function, and a first pull can take minutes
		pullServerChanges()
	}

	/**
	 * Check if offline cache is available and warn user if not
	 * @returns {boolean} Whether cache is ready
	 */
	async function checkOfflineCacheAvailability() {
		const cacheReady = await checkCacheReady()
		if (!cacheReady && isOffline.value) {
			showWarning(__("POS is offline without cached data. Please connect to sync."))
		}
		return cacheReady
	}

	/**
	 * Check if the offline cache is ready
	 */
	async function checkCacheReady() {
		return await offlineWorker.isCacheReady()
	}

	/**
	 * Get cache statistics
	 */
	async function getCacheStats() {
		return await offlineWorker.getCacheStats()
	}

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	window.addEventListener("offlineEntitySynced", ({ detail }) => {
		if (detail.row.entity === ENTITY_SHIFT_CLOSE) {
			clearShiftClosing(detail.row.data.pos_opening_shift)
		}
		if (detail.row.entity === ENTITY_SHIFT_OPEN) {
			settleLocalShift(detail).catch((error) => log.error("Failed to settle the local shift", error))
		}
	})

	// Initialize pending count on store creation
	updatePendingCount()
	ensurePersistentStorage()

	// Yesterday's queue must not wait for a reconnect that never comes
	setTimeout(autoSync, STARTUP_SYNC_DELAY_MS)
	setInterval(() => {
		const intervalMs = usePOSSettingsStore().syncIntervalMinutes * 60 * 1000
		// Without a socket, this is how a sale the server is working on gets its result
		if (isWaitingForServer || Date.now() - lastAutoSyncAt >= intervalMs) autoSync()
	}, SYNC_TICK_MS)
	setInterval(pullServerChanges, PULL_INTERVAL_MS)
	if (isNative) {
		// Out of step with the full pull, which gives up when it finds another one running
		setTimeout(() => {
			setInterval(() => pullServerChanges(STOCK_ENTITIES), STOCK_PULL_INTERVAL_MS)
		}, STOCK_PULL_INTERVAL_MS / 2)
	}

	// =========================================================================
	// EXPORTS
	// =========================================================================

	return {
		// State
		isOffline,
		pendingInvoicesCount,
		isSyncing,
		pendingInvoicesList,
		lastSyncedAt,

		// Computed
		hasPendingInvoices,
		queuedCount,
		reviewCount,

		// Actions
		saveInvoiceOffline,
		saveCustomerOffline,
		saveReturnOffline,
		savePaymentOffline,
		withQueuedPayments,
		saveShiftCloseOffline,
		saveShiftOpenOffline,
		checkCouponOffline,
		refreshReturnDocuments,
		getOfflineReturnDocuments,
		loadPendingInvoices,
		updatePendingCount,
		requestVoid,
		acknowledgeSaleStands,
		autoSync,
		syncAllPending,
		preloadDataForOffline,
		checkOfflineCacheAvailability,
		checkCacheReady,
		getCacheStats,
	}
})
