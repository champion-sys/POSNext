/**
 * What the web's main thread does with Dexie directly, without going through the worker.
 *
 * @module platform/store/web/dexie
 */

import { clearCachedData, db, getSetting, setSetting } from "@/utils/offline/db"

const SHIFT_KEY = "pos_shift_data"

async function requestPersistentStorage() {
	const storage = typeof navigator !== "undefined" ? navigator.storage : null
	if (!storage?.persist) return false
	return (await storage.persisted()) || (await storage.persist())
}

async function deleteSettingsByPrefix(prefix) {
	await db.settings.where("key").startsWith(prefix).delete()
}

function listUnsyncedInvoices() {
	return db.invoice_queue.filter((inv) => !inv.synced && !inv.superseded).toArray()
}

/**
 * What an export takes. It has its own name because the queue's other reads answer with an
 * empty list when they fail, and an empty file would say a broken device had nothing to save.
 */
const listUnconfirmedRows = listUnsyncedInvoices

function getQueuedInvoice(offlineId) {
	return db.invoice_queue.where("offline_id").equals(offlineId).first()
}

function updateQueuedInvoice(id, changes) {
	return db.invoice_queue.update(id, changes)
}

/** The server has no record of a sale it held, so it waits to be sent again */
async function resendQueuedInvoice(id) {
	const row = await db.invoice_queue.get(id)
	if (!row || row.synced || row.superseded) return

	await db.invoice_queue.update(id, {
		server_status: undefined,
		server_invoice: undefined,
		sync_failed: false,
		error: null,
		retry_count: 0,
		next_attempt_at: 0,
	})
}

function deleteSyncedInvoices(cutoff) {
	return db.invoice_queue.filter((inv) => inv.synced && inv.timestamp < cutoff).delete()
}

function getCachedItem(itemCode) {
	return db.items.get(itemCode)
}

function getCachedItemByBarcode(barcode) {
	return db.items.where("barcodes").equals(barcode).first()
}

function getCachedVariants(templateItemCode) {
	return db.items.where("variant_of").equals(templateItemCode).toArray()
}

async function getCachedItemPrice(priceList, itemCode) {
	return (await db.item_prices.get({ price_list: priceList, item_code: itemCode }))?.rate
}

/**
 * Cache items from a server response that carries no batch or serial data, so what is
 * cached already stays.
 * @param {Array<Object>} items
 * @param {string|null} priceList
 */
async function mergeCachedItems(items, priceList) {
	await db.transaction("rw", db.items, async () => {
		const existing = await db.items.bulkGet(items.map((item) => item.item_code))

		const processedItems = items.map((item, index) => ({
			...item,
			batch_no_data: existing[index]?.batch_no_data,
			serial_no_data: existing[index]?.serial_no_data,
			barcodes: item.item_barcode
				? Array.isArray(item.item_barcode)
					? item.item_barcode.map((b) => b.barcode).filter(Boolean)
					: [item.item_barcode]
				: [],
		}))

		await db.items.bulkPut(processedItems)
	})

	if (priceList) {
		const prices = items.map((item) => ({
			price_list: priceList,
			item_code: item.item_code,
			rate: item.rate || item.price_list_rate || 0,
			timestamp: Date.now(),
		}))
		await db.item_prices.bulkPut(prices)
	}

	await setSetting("items_last_sync", Date.now())
}

/**
 * Change cached items in one transaction.
 * @param {Array<string>} itemCodes
 * @param {(item: Object) => Object|null} mutate - Returns the fields to change, or null to skip
 * @returns {Promise<number>} How many items changed
 */
function updateItemBatchSerial(itemCodes, mutate) {
	return db.transaction("rw", db.items, async () => {
		let updated = 0
		for (const itemCode of itemCodes) {
			const item = await db.items.get(itemCode)
			// Avoid phantom rows (no item_name/barcodes) that blank the product grid
			if (!item) continue

			const changes = mutate(item)
			if (!changes) continue

			await db.items.update(itemCode, changes)
			updated++
		}
		return updated
	})
}

function getCachedCustomer(customerName) {
	return db.customers.get(customerName)
}

function putInvoiceHistory(invoices) {
	return db.invoice_history.bulkPut(invoices)
}

function listInvoiceHistory(posProfile) {
	return (posProfile ? db.invoice_history.where("pos_profile").equals(posProfile) : db.invoice_history).toArray()
}

async function deleteInvoiceHistory(posProfile) {
	if (posProfile) {
		await db.invoice_history.where("pos_profile").equals(posProfile).delete()
	} else {
		await db.invoice_history.clear()
	}
}

async function replaceUnpaidInvoices(invoices, posProfile) {
	await db.unpaid_invoices.where("pos_profile").equals(posProfile).delete()
	if (invoices.length > 0) {
		await db.unpaid_invoices.bulkPut(invoices)
	}
}

function listUnpaidInvoices(posProfile) {
	return db.unpaid_invoices.where("pos_profile").equals(posProfile).toArray()
}

async function getTranslations(locale) {
	return (await db.translations.get(locale)) || null
}

function putTranslations(entry) {
	return db.translations.put(entry)
}

async function deleteTranslations(locale) {
	if (locale) {
		await db.translations.delete(locale)
	} else {
		await db.translations.clear()
	}
}

function putPrintJob(job) {
	return db.table("print_queue").put(job)
}

function deletePrintJob(jobId) {
	return db.table("print_queue").delete(jobId)
}

function listPrintJobs() {
	return db.table("print_queue").toArray()
}

function saveShift(data) {
	localStorage.setItem(SHIFT_KEY, JSON.stringify(data))
}

function getShift() {
	const cached = localStorage.getItem(SHIFT_KEY)
	return cached ? JSON.parse(cached) : null
}

function clearShift() {
	localStorage.removeItem(SHIFT_KEY)
}

// Receipts stay in sessionStorage on the web, see utils/offline/offlineReceiptCache
const saveReceipt = () => {}
const getReceipt = () => null
const deleteReceipt = () => {}
const clearReceipts = () => {}

export const dexieStore = {
	getSetting: (...args) => getSetting(...args),
	setSetting: (...args) => setSetting(...args),
	deleteSettingsByPrefix,
	clearCachedData: (...args) => clearCachedData(...args),
	requestPersistentStorage,
	listUnsyncedInvoices,
	listUnconfirmedRows,
	getQueuedInvoice,
	updateQueuedInvoice,
	resendQueuedInvoice,
	deleteSyncedInvoices,
	getCachedItem,
	getCachedItemByBarcode,
	getCachedVariants,
	getCachedItemPrice,
	mergeCachedItems,
	updateItemBatchSerial,
	getCachedCustomer,
	putInvoiceHistory,
	listInvoiceHistory,
	deleteInvoiceHistory,
	replaceUnpaidInvoices,
	listUnpaidInvoices,
	getTranslations,
	putTranslations,
	deleteTranslations,
	putPrintJob,
	deletePrintJob,
	listPrintJobs,
	saveShift,
	getShift,
	clearShift,
	saveReceipt,
	getReceipt,
	deleteReceipt,
	clearReceipts,
}
