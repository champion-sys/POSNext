/**
 * Refreshes cached stock from the server on a timer. It runs in the worker on the web
 * and on the main thread on native builds, where the worker does not exist.
 *
 * @module platform/store/stockSync
 */

import { logger } from "@/utils/logger"

const log = logger.create("StockSync")

const MIN_INTERVAL_MS = 10000
const FETCH_TIMEOUT_MS = 5000

/**
 * @param {Object} deps
 * @param {string} deps.origin - Where the API is. Empty sends a relative request.
 * @param {() => string|null} deps.getCsrfToken
 * @param {() => boolean} deps.isConnected
 * @param {(updates: Array) => Promise<{updated: number}>} deps.updateStock
 * @param {(type: "STOCK_SYNC_COMPLETE"|"STOCK_SYNC_ERROR", payload: Object) => void} deps.notify
 */
export function createStockSync({ origin, getCsrfToken, isConnected, updateStock, notify }) {
	let timer = null
	let enabled = false
	let intervalMs = 60000
	let warehouse = null
	let trackedItemCodes = new Set()
	let lastSync = null
	let running = false

	async function fetchStock() {
		if (!warehouse || trackedItemCodes.size === 0) {
			log.debug("Stock sync skipped: No warehouse or items tracked")
			return []
		}

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

			const headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			}

			const csrfToken = getCsrfToken()
			if (csrfToken) {
				headers["X-Frappe-CSRF-Token"] = csrfToken
			}

			const response = await fetch(`${origin}/api/method/pos_next.api.items.get_stock_quantities`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					item_codes: JSON.stringify(Array.from(trackedItemCodes)),
					warehouse,
				}),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const data = await response.json()
			return data?.message || data || []
		} catch (error) {
			if (error.name === "AbortError") {
				log.warn("Stock fetch timeout")
			} else {
				log.error("Error fetching stock from server", error)
			}
			return []
		}
	}

	async function perform() {
		if (running) {
			log.debug("Stock sync already running, skipping")
			return
		}

		if (!isConnected()) {
			log.debug("Stock sync skipped: Server offline")
			return
		}

		try {
			running = true
			const startTime = Date.now()

			const stockUpdates = await fetchStock()

			if (stockUpdates.length > 0) {
				const result = await updateStock(stockUpdates)

				lastSync = Date.now()
				const duration = lastSync - startTime

				log.success(`Stock sync completed: ${result.updated}/${stockUpdates.length} items updated in ${duration}ms`)

				notify("STOCK_SYNC_COMPLETE", {
					updated: result.updated,
					total: stockUpdates.length,
					duration,
					timestamp: lastSync,
				})
			} else {
				log.debug("Stock sync: No updates received")
			}
		} catch (error) {
			log.error("Stock sync failed", error)
			notify("STOCK_SYNC_ERROR", { message: error.message, timestamp: Date.now() })
		} finally {
			running = false
		}
	}

	function start() {
		if (timer) {
			log.debug("Stock sync already running")
			return
		}

		enabled = true

		perform().catch((error) => log.error("Initial stock sync failed", error))

		timer = setInterval(() => {
			perform().catch((error) => log.error("Periodic stock sync failed", error))
		}, intervalMs)

		log.success(`Periodic stock sync started (interval: ${intervalMs}ms)`)
	}

	function stop() {
		if (timer) {
			clearInterval(timer)
			timer = null
			enabled = false
			log.info("Periodic stock sync stopped")
		}
	}

	function configure({ warehouse: newWarehouse, itemCodes, intervalMs: newIntervalMs }) {
		let restartNeeded = false

		if (newWarehouse !== undefined) {
			warehouse = newWarehouse
			log.debug(`Stock sync warehouse set: ${newWarehouse}`)
			restartNeeded = true
		}

		if (itemCodes !== undefined && Array.isArray(itemCodes)) {
			trackedItemCodes = new Set(itemCodes)
			log.debug(`Stock sync tracking ${itemCodes.length} items`)
			restartNeeded = true
		}

		if (newIntervalMs !== undefined && newIntervalMs >= MIN_INTERVAL_MS) {
			intervalMs = newIntervalMs
			log.debug(`Stock sync interval set: ${newIntervalMs}ms`)
			restartNeeded = true
		}

		if (restartNeeded && enabled) {
			stop()
			start()
		}

		return { warehouse, itemCount: trackedItemCodes.size, intervalMs, enabled, lastSync }
	}

	function getStatus() {
		return { enabled, warehouse, itemCount: trackedItemCodes.size, intervalMs, lastSync, running }
	}

	return { perform, start, stop, configure, getStatus }
}
