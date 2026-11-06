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

import { useToast } from "@/composables/useToast"
import {
	cacheCustomersFromServer,
	cachePaymentMethodsFromServer,
	cacheSalesPersonsFromServer,
	syncOfflineInvoices,
	cacheInvoiceHistory,
	cacheUnpaidInvoices,
	cacheUnpaidSummary,
} from "@/utils/offline"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { sumQueuedStock } from "@/utils/offline/invoicePayload"
import { offlineState } from "@/utils/offline/offlineState"
import { offlineWorker } from "@/utils/offline/workerClient"
import { useStockStore } from "@/stores/stock"
import { defineStore } from "pinia"
import { computed, ref } from "vue"

const log = logger.create('POSSync')

/** Safety net: queued invoices go out on this interval whatever else happens */
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000

/** Wait for the app to settle before the sync on opening */
const STARTUP_SYNC_DELAY_MS = 5000

const STORAGE_WARNING_KEY = "pos_next_storage_warning_shown"

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

	let isListeningForResults = false

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
		}

		wasOffline = nowOffline
	})

	// =========================================================================
	// COMPUTED
	// =========================================================================

	/** Whether there are any pending invoices to sync */
	const hasPendingInvoices = computed(() => pendingInvoicesCount.value > 0)

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
	 * Hold stock for queued sales, so the same units cannot be sold twice
	 */
	async function refreshQueuedStock() {
		const stockStore = useStockStore()
		stockStore.setQueued(sumQueuedStock(await getPending(), stockStore.warehouse))
	}

	/**
	 * Ask the browser not to evict the queue under storage pressure
	 * @returns {Promise<boolean>} Whether the storage is protected
	 */
	async function ensurePersistentStorage() {
		const storage = typeof navigator !== "undefined" ? navigator.storage : null
		if (!storage?.persist) return false
		try {
			return (await storage.persisted()) || (await storage.persist())
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
	 * Sync pending invoices to the server
	 * @throws {Error} If called while offline
	 */
	async function syncPending() {
		if (isOffline.value) {
			throw new Error("Cannot sync while offline")
		}

		isSyncing.value = true
		try {
			const stockStore = useStockStore()
			const soldCodes = Array.from(stockStore.queued.keys())
			const result = await syncOfflineInvoices()
			await updatePendingCount()

			// The server's numbers now include these sales
			if (result.success > 0 && soldCodes.length > 0) {
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
	 * Delete a pending invoice by ID
	 * @param {string} id - Invoice ID to delete
	 */
	async function deletePending(id) {
		await offlineWorker.deleteOfflineInvoice(id)
		await updatePendingCount()
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
			log.info('Invoice saved offline successfully')
			return result || { success: true }
		} catch (error) {
			log.error('Failed to save invoice offline', error)
			throw error
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
	 * Delete an offline invoice by ID with user feedback
	 * @param {string} invoiceId - Invoice ID to delete
	 */
	async function deleteOfflineInvoice(invoiceId) {
		try {
			await deletePending(invoiceId)
			await loadPendingInvoices()
			showSuccess(__("Offline invoice deleted successfully"))
		} catch (error) {
			log.error('Failed to delete offline invoice', error)
			showError(error.message || __("Failed to delete offline invoice"))
			throw error
		}
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
			const result = await syncPending()

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

	// Initialize pending count on store creation
	updatePendingCount()
	ensurePersistentStorage()

	// Yesterday's queue must not wait for a reconnect that never comes
	setTimeout(autoSync, STARTUP_SYNC_DELAY_MS)
	setInterval(autoSync, AUTO_SYNC_INTERVAL_MS)

	// =========================================================================
	// EXPORTS
	// =========================================================================

	return {
		// State
		isOffline,
		pendingInvoicesCount,
		isSyncing,
		pendingInvoicesList,

		// Computed
		hasPendingInvoices,

		// Actions
		saveInvoiceOffline,
		loadPendingInvoices,
		updatePendingCount,
		deleteOfflineInvoice,
		syncAllPending,
		preloadDataForOffline,
		checkOfflineCacheAvailability,
		checkCacheReady,
		getCacheStats,
	}
})
