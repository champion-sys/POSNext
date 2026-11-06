/**
 * The desktop and Android implementation. The store runs on the main thread, because
 * neither Electron's preload API nor Capacitor plugins reach a Web Worker. The SQLite
 * work itself happens outside the UI thread: in a utility process on Electron, and on
 * the plugin's own thread on Android.
 *
 * @module platform/store/native
 */

import { logger } from "@/utils/logger"
import { ELECTRON, PLATFORM } from "../runtime"
import { migrate } from "../sql/migrations"
import { createOutbox } from "../sql/outbox"
import { STORE_METHODS } from "./methods"
import { createSqlStore } from "./sqlStore"

const log = logger.create("NativeStore")

const loadExecutor =
	PLATFORM === ELECTRON ? () => import("../electron/sqlExecutor") : () => import("../capacitor/sqlExecutor")

const EMPTY_STATS = { items: 0, customers: 0, queuedInvoices: 0, cacheReady: false, lastSync: null }

/**
 * What a call answers when the database cannot. The web degrades the same way, so the
 * screens stay up. Saving a sale is not here: it must fail where the cashier can see it.
 */
const FALLBACKS = {
	getOfflineInvoiceCount: () => 0,
	getOfflineInvoices: () => [],
	getQueueRows: () => [],
	listUnsyncedInvoices: () => [],
	searchCachedItems: () => [],
	searchCachedItemsByGroup: () => [],
	searchCachedItemsByBrand: () => [],
	countCachedItemsByGroup: () => 0,
	searchCachedCustomers: () => [],
	getCachedPaymentMethods: () => [],
	getCachedSalesPersons: () => [],
	getCachedOffers: () => [],
	isCacheReady: () => false,
	getCacheStats: () => ({ ...EMPTY_STATS }),
	getSetting: (_key, defaultValue = null) => defaultValue,
	setSetting: () => {},
}

async function openDatabase() {
	const { openExecutor } = await loadExecutor()
	const sql = await openExecutor()
	await migrate(sql)
	await createOutbox(sql).recoverInterrupted()
	return createSqlStore(sql)
}

/**
 * @param {() => Promise<Object>} open - Opens the SQLite store
 * @returns {Object} The store, degrading on reads when the database fails
 */
export function createNativeStore(open) {
	let opening = null

	function getDatabase() {
		if (!opening) {
			opening = open().catch((error) => {
				opening = null
				throw error
			})
		}
		return opening
	}

	return Object.fromEntries(
		STORE_METHODS.map((name) => [
			name,
			async (...args) => {
				try {
					return await (await getDatabase())[name](...args)
				} catch (error) {
					if (!FALLBACKS[name]) throw error
					log.error(`Local database failed on ${name}`, error)
					return FALLBACKS[name](...args)
				}
			},
		]),
	)
}

const store = createNativeStore(openDatabase)

export function openStore() {
	return store
}
