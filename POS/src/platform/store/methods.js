/**
 * What the app can ask of the device's storage. Every platform provides all of these.
 *
 * A queued sale always reaches the app in one shape, whatever keeps it on the device:
 *
 * @typedef {Object} QueuedInvoice
 * @property {number} id - Device order, also what deletes and edits refer to
 * @property {string} offline_id - Stable across every retry
 * @property {string} [entity] - invoice, customer, payment, shift_close or shift_open. Rows
 *   queued before the queue had entities have none, and are sales.
 * @property {Array<string>} [depends_on] - Offline IDs the server must finish first
 * @property {Object} data - The record
 * @property {number} timestamp - When it was queued
 * @property {boolean} synced
 * @property {number} retry_count
 * @property {number} [next_attempt_at]
 * @property {string|null} [error]
 * @property {string} [server_status] - received, processing, needs_review, synced or voided.
 *   Missing until the server holds the sale.
 * @property {string|null} [server_invoice]
 * @property {boolean} [sync_failed]
 * @property {boolean} [superseded]
 * @property {string|null} [replaced_by]
 *
 * @module platform/store/methods
 */

/** Names the app has always called on offlineWorker */
export const WORKER_METHODS = [
	"pingServer",
	"checkOffline",
	"getOfflineInvoiceCount",
	"getOfflineInvoices",
	"saveOfflineInvoice",
	"saveQueueEntity",
	"getQueueRows",
	"searchCachedItems",
	"searchCachedItemsByGroup",
	"searchCachedItemsByBrand",
	"countCachedItemsByGroup",
	"searchCachedCustomers",
	"cacheItems",
	"cacheCustomers",
	"deleteCustomers",
	"cachePaymentMethods",
	"getCachedPaymentMethods",
	"cacheSalesPersons",
	"getCachedSalesPersons",
	"isCacheReady",
	"getCacheStats",
	"deleteOfflineInvoice",
	"markOfflineInvoicePrinted",
	"supersedeOfflineInvoice",
	"setManualOffline",
	"setCSRFToken",
	"setServerAccess",
	"setShowVariantsAsItems",
	"updateStockQuantities",
	"clearItemsCache",
	"clearCustomersCache",
	"removeItemsByGroups",
	"applyPullPage",
	"startStockSync",
	"stopStockSync",
	"configureStockSync",
	"getStockSyncStatus",
	"triggerStockSync",
	"cacheOffers",
	"getCachedOffers",
	"clearOffersCache",
	"terminate",
]

/** Storage the main thread reached directly on the web */
export const DIRECT_METHODS = [
	"getSetting",
	"setSetting",
	"deleteSettingsByPrefix",
	"clearCachedData",
	"requestPersistentStorage",

	"listUnsyncedInvoices",
	"getQueuedInvoice",
	"updateQueuedInvoice",
	"resendQueuedInvoice",
	"deleteSyncedInvoices",

	"getCachedItem",
	"getCachedItemByBarcode",
	"getCachedVariants",
	"getCachedItemPrice",
	"mergeCachedItems",
	"updateItemBatchSerial",
	"getCachedCustomer",

	"putInvoiceHistory",
	"listInvoiceHistory",
	"deleteInvoiceHistory",
	"replaceUnpaidInvoices",
	"listUnpaidInvoices",

	"getTranslations",
	"putTranslations",
	"deleteTranslations",

	"putPrintJob",
	"deletePrintJob",
	"listPrintJobs",

	"addDraft",
	"putDraft",
	"getDraft",
	"listDrafts",
	"deleteDraft",
	"clearDrafts",
	"countDrafts",

	"saveShift",
	"getShift",
	"clearShift",

	"saveReceipt",
	"getReceipt",
	"deleteReceipt",
	"clearReceipts",
]

export const STORE_METHODS = [...WORKER_METHODS, ...DIRECT_METHODS]
