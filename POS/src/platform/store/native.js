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
import { DatabaseLockedError } from "./databaseLock"
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
	return { store: createSqlStore(sql), encrypted: sql.encrypted }
}

/**
 * @param {() => Promise<T>} open
 * @returns {() => Promise<T>} Opens once, and again only after a failure
 * @template T
 */
function openOnce(open) {
	let opening = null

	return () => {
		if (!opening) {
			opening = open().catch((error) => {
				opening = null
				throw error
			})
		}
		return opening
	}
}

/**
 * @param {() => Promise<Object>} open - Opens the SQLite store
 * @returns {Object} The store, degrading on reads when the database fails
 */
export function createNativeStore(open) {
	const getDatabase = openOnce(open)

	return Object.fromEntries(
		STORE_METHODS.map((name) => [
			name,
			async (...args) => {
				try {
					return await (await getDatabase())[name](...args)
				} catch (error) {
					// Locked is not empty: an answer of "no sales" would be a lie
					if (!FALLBACKS[name] || error instanceof DatabaseLockedError) throw error
					log.error(`Local database failed on ${name}`, error)
					return FALLBACKS[name](...args)
				}
			},
		]),
	)
}

const openLocalDatabase = openOnce(openDatabase)
const store = createNativeStore(async () => (await openLocalDatabase()).store)

export function openStore() {
	return store
}

/**
 * For the app's start, which must not go on over a database that exists and will not open.
 * @param {() => Promise<{encrypted: boolean}>} [open]
 * @returns {Promise<{locked: string|null, encrypted: boolean}>}
 */
export async function checkDatabase(open = openLocalDatabase) {
	try {
		const { encrypted } = await open()
		return { locked: null, encrypted }
	} catch (error) {
		if (error instanceof DatabaseLockedError) return { locked: error.reason, encrypted: false }
		log.error("Failed to open the local database", error)
		return { locked: null, encrypted: false }
	}
}
