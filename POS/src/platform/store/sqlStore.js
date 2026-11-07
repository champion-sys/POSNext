/**
 * The local store on SQLite, behind the same methods the web has. Each method answers
 * in the shape the app already reads, whatever the repositories keep underneath.
 *
 * @module platform/store/sqlStore
 */

import { PULL_ENTITIES, pullStateKey } from "@/core/sync/pullEngine"
import { createCatalog, extractBarcodes } from "@/platform/sql/catalog"
import { createCustomers } from "@/platform/sql/customers"
import { createInvoiceDocuments, createProfileDocuments } from "@/platform/sql/documents"
import { createDrafts } from "@/platform/sql/drafts"
import { createOutbox, toQueuedInvoice } from "@/platform/sql/outbox"
import { createPrintJobs } from "@/platform/sql/printJobs"
import { createReceipts } from "@/platform/sql/receipts"
import { chunk } from "@/platform/sql/searchText"
import { createSettings } from "@/platform/sql/settings"
import { createShifts } from "@/platform/sql/shifts"
import { createTranslations } from "@/platform/sql/translations"
import { logger } from "@/utils/logger"
import { getInvoiceDependencies } from "@/utils/offline/entities"
import { offlineState } from "@/utils/offline/offlineState"
import { generateOfflineId } from "@/utils/offline/uuid"
import { createStockSync } from "./stockSync"

const log = logger.create("SqlStore")

const BATCH_SIZE = 500
const PING_TIMEOUT_MS = 3000
const STOCK_EVENTS = { STOCK_SYNC_COMPLETE: "stockSyncComplete", STOCK_SYNC_ERROR: "stockSyncError" }

/**
 * @param {import("@/platform/sql/outbox").SqlExecutor} sql
 */
export function createSqlStore(sql) {
	const outbox = createOutbox(sql)
	const catalog = createCatalog(sql)
	const customers = createCustomers(sql)
	const settings = createSettings(sql)
	const paymentMethods = createProfileDocuments(sql, "payment_method", "mode_of_payment")
	const salesPersons = createProfileDocuments(sql, "sales_person")
	const offers = createProfileDocuments(sql, "offer")
	const invoiceHistory = createInvoiceDocuments(sql, "invoice_history")
	const unpaidInvoices = createInvoiceDocuments(sql, "unpaid_invoice")
	const translations = createTranslations(sql)
	const drafts = createDrafts(sql)
	const shifts = createShifts(sql)
	const receipts = createReceipts(sql)
	const printJobs = createPrintJobs(sql)

	let showVariantsAsItems = false
	let csrfToken = null

	// A change that reads a row first must not interleave with another one on the same row
	let lastChange = Promise.resolve()
	function inOrder(change) {
		const result = lastChange.then(change, change)
		lastChange = result.catch(() => {})
		return result
	}

	const offlineIdOf = async (id) => (await outbox.getBySeq(id))?.offline_id

	async function updateStockQuantities(stockUpdates) {
		if (!stockUpdates || stockUpdates.length === 0) {
			return { success: true, updated: 0 }
		}

		const updated = await catalog.updateStock(stockUpdates)
		if (updated > 0) {
			await settings.set("items_last_sync", Date.now())
		}
		return { success: true, updated }
	}

	// Forget how far entities were pulled, so emptied tables are filled again
	const resetPullState = (entities) => settings.deleteStatement(entities.map(pullStateKey))

	const stockSync = createStockSync({
		// Relative: the fetch bridge adds the server and the cashier's grant on this thread
		serverUrl: (path) => path,
		getHeaders: () => (csrfToken ? { "X-Frappe-CSRF-Token": csrfToken } : {}),
		isConnected: () => offlineState.serverOnline && !offlineState.manualOffline,
		updateStock: updateStockQuantities,
		notify(type, payload) {
			window.dispatchEvent(new CustomEvent(STOCK_EVENTS[type], { detail: payload }))
		},
	})

	const store = {
		async pingServer() {
			try {
				const controller = new AbortController()
				const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
				const response = await fetch("/api/method/pos_next.api.ping", { signal: controller.signal })
				clearTimeout(timeoutId)
				offlineState.setServerOnline(response.ok)
				return response.ok
			} catch {
				offlineState.setServerOnline(false)
				return false
			}
		},

		checkOffline(browserOnline) {
			return offlineState.manualOffline || !browserOnline || !offlineState.serverOnline
		},

		getOfflineInvoiceCount() {
			return outbox.countQueued()
		},

		async getOfflineInvoices() {
			return (await outbox.listQueued()).map(toQueuedInvoice)
		},

		listUnsyncedInvoices() {
			return store.getOfflineInvoices()
		},

		/**
		 * Keep a sale. Its receipt starts as the invoice itself, so a printable copy exists
		 * from the moment the sale does.
		 */
		async saveOfflineInvoice(invoiceData, options = {}) {
			if (!invoiceData.items || invoiceData.items.length === 0) {
				throw new Error("Cannot save empty invoice")
			}

			// Keep the id of a failed online attempt so the server can dedupe it
			const offlineId = invoiceData.offline_id || generateOfflineId()
			const invoice = { ...invoiceData, offline_id: offlineId }

			return inOrder(async () => {
				const existing = await outbox.get(offlineId)
				if (existing) return { success: true, id: existing.seq, offline_id: offlineId }

				// An original that is already gone must not cost the sale
				const supersedes = options.supersedesId ? await offlineIdOf(options.supersedesId) : undefined

				const id = await outbox.enqueueSale({
					offlineId,
					invoice,
					receipt: invoice,
					shift: invoice.posa_pos_opening_shift,
					supersedes,
					dependsOn: getInvoiceDependencies(invoice),
				})

				log.info(`Invoice saved to offline queue with offline_id: ${offlineId}`)
				return { success: true, id, offline_id: offlineId }
			})
		},

		async saveQueueEntity(entity, data, dependsOn = []) {
			const offlineId = data.offline_id || generateOfflineId()

			return inOrder(async () => {
				const existing = await outbox.get(offlineId)
				if (existing) return { success: true, id: existing.seq, offline_id: offlineId }

				const id = await outbox.enqueueEntity({
					offlineId,
					entity,
					data: { ...data, offline_id: offlineId },
					dependsOn,
					shift: data.posa_pos_opening_shift ?? data.pos_opening_shift,
				})

				log.info(`Queued ${entity} with offline_id: ${offlineId}`)
				return { success: true, id, offline_id: offlineId }
			})
		},

		async getQueueRows() {
			return (await outbox.listKept()).map(toQueuedInvoice)
		},

		async deleteOfflineInvoice(id) {
			const offlineId = await offlineIdOf(id)
			if (offlineId) await outbox.remove(offlineId)
			return { success: true }
		},

		async supersedeOfflineInvoice(id, replacedBy) {
			const offlineId = await offlineIdOf(id)
			if (offlineId) await outbox.supersede(offlineId, replacedBy)
			return { success: true }
		},

		async requestVoid(id, reason) {
			const offlineId = await offlineIdOf(id)
			return { success: Boolean(offlineId) && (await outbox.requestVoid(offlineId, reason)) }
		},

		markOfflineInvoicePrinted(offlineId) {
			if (!offlineId) return { success: false }

			return inOrder(async () => {
				const row = await outbox.get(offlineId)
				if (!row) return { success: false, reason: "not found" }

				await outbox.updatePayload(offlineId, { ...row.payload, was_printed: true, last_printed_at: Date.now() })
				await receipts.markPrinted(offlineId)
				return { success: true }
			})
		},

		async getQueuedInvoice(offlineId) {
			const row = await outbox.get(offlineId)
			return row ? toQueuedInvoice(row) : undefined
		},

		/**
		 * Apply a sync result or a failed attempt.
		 * @param {number} id
		 * @param {Partial<import("./methods").QueuedInvoice>} changes
		 */
		async updateQueuedInvoice(id, changes) {
			const offlineId = await offlineIdOf(id)
			if (!offlineId) return

			if (changes.server_status) {
				await outbox.applyResult(offlineId, {
					state: changes.server_status,
					serverName: changes.server_invoice,
					error: changes.error,
				})
			} else {
				await outbox.markFailed(offlineId, changes.error, changes.next_attempt_at, {
					gaveUp: changes.sync_failed,
					attempts: changes.retry_count,
				})
			}
		},

		async resendQueuedInvoice(id) {
			const offlineId = await offlineIdOf(id)
			if (offlineId) await outbox.returnToPending(offlineId)
		},

		deleteSyncedInvoices(cutoff) {
			return outbox.purgeFinished(cutoff)
		},

		searchCachedItems(searchTerm = "", limit = 50, offset = 0) {
			return searchTerm?.trim()
				? catalog.search(searchTerm, limit)
				: catalog.browse({ limit, offset, showVariantsAsItems })
		},

		searchCachedItemsByGroup(itemGroups = [], limit = 50, offset = 0) {
			return itemGroups?.length
				? catalog.searchByGroups(itemGroups, { limit, offset, showVariantsAsItems })
				: store.searchCachedItems("", limit, offset)
		},

		searchCachedItemsByBrand(brand, limit = 50, offset = 0) {
			return brand
				? catalog.searchByBrand(brand, { limit, offset, showVariantsAsItems })
				: store.searchCachedItems("", limit, offset)
		},

		countCachedItemsByGroup(itemGroups = []) {
			return catalog.countVisible(itemGroups, showVariantsAsItems)
		},

		async cacheItems(items, batchSize) {
			if (!items || items.length === 0) {
				return { success: true, count: 0, duration: 0 }
			}

			const startTime = Date.now()
			const now = Date.now()
			for (const page of chunk(items, Math.min(batchSize || BATCH_SIZE, BATCH_SIZE))) {
				const prices = page
					.filter((item) => item.item_code && (item.rate || item.price_list_rate))
					.map((item) => ({
						price_list: item.selling_price_list || item.price_list || "Standard",
						item_code: item.item_code,
						rate: item.rate || item.price_list_rate || 0,
					}))

				await sql.batch([
					...catalog.putStatements(page, now),
					...catalog.priceStatements(prices, now),
					settings.setStatement("items_last_sync", now),
				])
			}

			return { success: true, count: items.length, duration: Date.now() - startTime }
		},

		async mergeCachedItems(items, priceList) {
			const now = Date.now()
			for (const page of chunk(items, BATCH_SIZE)) {
				const merged = page.map((item) => ({
					...item,
					batch_no_data: undefined,
					serial_no_data: undefined,
					barcodes: extractBarcodes({ item_barcode: item.item_barcode }),
				}))
				const prices = priceList
					? page.map((item) => ({
							price_list: priceList,
							item_code: item.item_code,
							rate: item.rate || item.price_list_rate || 0,
						}))
					: []

				await sql.batch([
					...catalog.putStatements(merged, now),
					...catalog.priceStatements(prices, now),
					settings.setStatement("items_last_sync", now),
				])
			}
		},

		/**
		 * @param {Array<string>} itemCodes
		 * @param {(item: Object) => {batch_no_data?: Array, serial_no_data?: Array}|null} mutate
		 * @returns {Promise<number>} How many items changed
		 */
		updateItemBatchSerial(itemCodes, mutate) {
			return inOrder(async () => {
				const changes = []
				for (const itemCode of itemCodes) {
					const item = await catalog.get(itemCode)
					// Avoid phantom rows (no item_name/barcodes) that blank the product grid
					if (!item) continue

					const change = mutate(item)
					if (change) changes.push({ item_code: itemCode, ...change })
				}

				await catalog.updateBatchSerial(changes)
				return changes.length
			})
		},

		getCachedItem(itemCode) {
			return catalog.get(itemCode)
		},

		getCachedItemByBarcode(barcode) {
			return catalog.getByBarcode(barcode)
		},

		getCachedVariants(templateItemCode) {
			return catalog.getVariants(templateItemCode)
		},

		getCachedItemPrice(priceList, itemCode) {
			return catalog.getPrice(priceList, itemCode)
		},

		updateStockQuantities,

		async clearItemsCache() {
			await sql.batch([
				...catalog.clearStatements(),
				settings.setStatement("items_last_sync", null),
				resetPullState(["items", "item_prices"]),
			])
			return { success: true }
		},

		async removeItemsByGroups(itemGroups) {
			if (!itemGroups || itemGroups.length === 0) {
				return { success: true, removed: 0, pricesRemoved: 0 }
			}

			const startTime = Date.now()
			const result = await catalog.removeGroups(itemGroups)
			return { success: true, ...result, duration: Date.now() - startTime }
		},

		searchCachedCustomers(searchTerm = "", limit = 20) {
			return customers.search(searchTerm, limit)
		},

		getCachedCustomer(customerName) {
			return customers.get(customerName)
		},

		async cacheCustomers(list) {
			if (!list || list.length === 0) {
				return { success: true, count: 0, duration: 0 }
			}

			const startTime = Date.now()
			for (const page of chunk(list, BATCH_SIZE)) {
				await sql.batch([
					...customers.putStatements(page),
					settings.setStatement("customers_last_sync", Date.now()),
				])
			}
			return { success: true, count: list.length, duration: Date.now() - startTime }
		},

		async deleteCustomers(customerNames) {
			if (!customerNames || customerNames.length === 0) return true
			await customers.remove(customerNames)
			return true
		},

		async clearCustomersCache() {
			await sql.batch([
				...customers.clearStatements(),
				settings.setStatement("customers_last_sync", null),
				resetPullState(["customers"]),
			])
			return { success: true }
		},

		async cachePaymentMethods(list) {
			await sql.batch([
				...paymentMethods.putStatements(list),
				settings.setStatement("payment_methods_last_sync", Date.now()),
			])
			return { success: true, count: list.length }
		},

		getCachedPaymentMethods(posProfile) {
			return paymentMethods.list(posProfile)
		},

		async cacheSalesPersons(list) {
			await sql.batch([
				...salesPersons.putStatements(list),
				settings.setStatement("sales_persons_last_sync", Date.now()),
			])
			return { success: true, count: list.length }
		},

		getCachedSalesPersons(posProfile) {
			return salesPersons.list(posProfile)
		},

		async cacheOffers(list, posProfile) {
			if (!Array.isArray(list) || !posProfile) {
				return { success: false, count: 0 }
			}

			const now = Date.now()
			await sql.batch([
				offers.deleteStatement(posProfile),
				...offers.putStatements(list.map((offer) => ({ ...offer, pos_profile: posProfile, _cached_at: now }))),
				settings.setStatement(`offers_last_sync_${posProfile}`, now),
			])
			return { success: true, count: list.length }
		},

		async getCachedOffers(posProfile) {
			if (!posProfile) return []

			const today = new Date().toISOString().split("T")[0]
			return (await offers.list(posProfile)).filter((offer) => !offer.valid_upto || offer.valid_upto >= today)
		},

		async clearOffersCache(posProfile = null) {
			await sql.batch([offers.deleteStatement(posProfile)])
			return { success: true }
		},

		/**
		 * Store one page from the pull engine. Throws on failure, so its cursor is not saved.
		 * Applying a page twice is harmless, which is what makes that safe.
		 */
		async applyPullPage(entity, { rows, deleted }, posProfile) {
			switch (entity) {
				case "items":
				case "item_prices":
					await store.cacheItems(rows)
					await catalog.remove(deleted)
					break

				case "customers":
					await store.cacheCustomers(rows)
					await store.deleteCustomers(deleted)
					break

				case "taxes":
					await settings.set(`tax_rules_${posProfile}`, rows)
					break

				case "payment_methods":
					await sql.batch([
						paymentMethods.deleteStatement(posProfile),
						...paymentMethods.putStatements(rows.map((method) => ({ ...method, pos_profile: posProfile }))),
					])
					break

				case "pos_profile": {
					const [data] = rows
					await settings.set(`pos_profile_data:${posProfile}`, {
						profileItemGroups: data.pos_profile?.item_groups || [],
						itemGroups: data.item_groups_hierarchy || [],
					})
					break
				}

				case "offers": {
					const result = await store.cacheOffers(rows, posProfile)
					if (!result.success) throw new Error("Could not cache offers")
					break
				}

				default:
					throw new Error(`Unknown pull entity: ${entity}`)
			}

			return { success: true }
		},

		async isCacheReady() {
			return (await catalog.count()) > 0
		},

		async getCacheStats() {
			const [total, hidden, customerCount, queuedInvoices, lastSync] = await Promise.all([
				catalog.count(),
				catalog.countHidden(showVariantsAsItems),
				customers.count(),
				outbox.countQueued(),
				settings.get("items_last_sync"),
			])
			const items = total - hidden

			return {
				items,
				customers: customerCount,
				queuedInvoices,
				cacheReady: items > 0,
				lastSync: lastSync || null,
			}
		},

		setManualOffline(value) {
			offlineState.setManualOffline(value)
			return { success: true, manualOffline: value }
		},

		setCSRFToken(token) {
			csrfToken = token
			return { success: true }
		},

		// For the web worker's benefit. Here every request goes through the fetch bridge.
		setServerAccess() {
			return { success: true }
		},

		setShowVariantsAsItems(value) {
			showVariantsAsItems = Boolean(value)
			return { success: true, showVariantsAsItems }
		},

		startStockSync() {
			stockSync.start()
			return { success: true, status: stockSync.getStatus() }
		},

		stopStockSync() {
			stockSync.stop()
			return { success: true, status: stockSync.getStatus() }
		},

		configureStockSync(config) {
			return stockSync.configure(config)
		},

		getStockSyncStatus() {
			return stockSync.getStatus()
		},

		async triggerStockSync() {
			await stockSync.perform()
			return { success: true, status: stockSync.getStatus() }
		},

		terminate() {
			stockSync.stop()
		},

		getSetting(key, defaultValue = null) {
			return settings.get(key, defaultValue)
		},

		setSetting(key, value) {
			return settings.set(key, value)
		},

		deleteSettingsByPrefix(prefix) {
			return settings.deleteByPrefix(prefix)
		},

		async clearCachedData({
			preserveInvoices = true,
			preserveDrafts = true,
			preserveSettings = true,
			preservePaymentMethods = false,
		} = {}) {
			try {
				await sql.batch([
					...catalog.clearStatements(),
					...customers.clearStatements(),
					salesPersons.deleteStatement(),
					resetPullState(PULL_ENTITIES),
					...(preservePaymentMethods ? [] : [paymentMethods.deleteStatement()]),
					...(preserveInvoices
						? []
						: ["outbox", "stock_reservation", "receipt"].map((table) => ({ sql: `DELETE FROM ${table}` }))),
					...(preserveInvoices ? [] : printJobs.clearStatements()),
					...(preserveDrafts ? [] : [{ sql: "DELETE FROM draft" }]),
					...(preserveSettings ? [] : settings.clearStatements()),
				])
				return { success: true, cleared: {} }
			} catch (error) {
				log.error("Error clearing cached data", error)
				return { success: false, error: error.message, cleared: {} }
			}
		},

		// SQLite files are the app's own, nothing evicts them
		requestPersistentStorage() {
			return true
		},

		async putInvoiceHistory(invoices) {
			await sql.batch(invoiceHistory.putStatements(invoices))
		},

		listInvoiceHistory(posProfile) {
			return invoiceHistory.list(posProfile)
		},

		async deleteInvoiceHistory(posProfile) {
			await sql.batch([invoiceHistory.deleteStatement(posProfile)])
		},

		async replaceUnpaidInvoices(invoices, posProfile) {
			await sql.batch([unpaidInvoices.deleteStatement(posProfile), ...unpaidInvoices.putStatements(invoices)])
		},

		listUnpaidInvoices(posProfile) {
			return unpaidInvoices.list(posProfile)
		},

		getTranslations(locale) {
			return translations.get(locale)
		},

		putTranslations(entry) {
			return translations.put(entry)
		},

		deleteTranslations(locale) {
			return translations.remove(locale)
		},

		putPrintJob(job) {
			return printJobs.put(job)
		},

		deletePrintJob(jobId) {
			return printJobs.remove(jobId)
		},

		listPrintJobs() {
			return printJobs.list()
		},

		addDraft(draft) {
			return drafts.add(draft)
		},

		putDraft(draft) {
			return drafts.put(draft)
		},

		getDraft(draftId) {
			return drafts.get(draftId)
		},

		listDrafts() {
			return drafts.list()
		},

		deleteDraft(draftId) {
			return drafts.remove(draftId)
		},

		clearDrafts() {
			return drafts.clear()
		},

		countDrafts() {
			return drafts.count()
		},

		saveShift(data) {
			return shifts.save(data)
		},

		getShift() {
			return shifts.get()
		},

		clearShift() {
			return shifts.clear()
		},

		saveReceipt(offlineId, doc) {
			return receipts.save(offlineId, doc)
		},

		getReceipt(offlineId) {
			return receipts.get(offlineId)
		},

		deleteReceipt(offlineId) {
			return receipts.remove(offlineId)
		},

		clearReceipts() {
			return receipts.clear()
		},
	}

	return store
}
