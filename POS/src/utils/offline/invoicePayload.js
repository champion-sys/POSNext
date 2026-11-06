/**
 * Pure helpers for building and classifying queued invoices.
 * No store or database imports, so they can be tested directly and shared
 * with the worker.
 *
 * @module utils/offline/invoicePayload
 */

const POSTING_DOCTYPES = ["Sales Invoice", "POS Invoice"]
const AUTH_ERROR_TYPES = ["AuthenticationError", "SessionExpired", "CSRFTokenError"]
const GATEWAY_STATUSES = [502, 503, 504]

const pad = (value) => String(value).padStart(2, "0")

/**
 * Date and time of a sale on the device clock. Uses local parts because
 * toISOString() gives the UTC date, which is the previous day shortly after
 * midnight in Saudi Arabia.
 * @param {number} [timestamp] - Milliseconds since the epoch
 * @returns {{posting_date: string, posting_time: string}}
 */
export function formatLocalPosting(timestamp = Date.now()) {
	const date = new Date(timestamp)
	return {
		posting_date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
		posting_time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
	}
}

/**
 * Whether the server can dedupe this doctype by offline_id.
 * @param {string} doctype
 * @returns {boolean}
 */
export function supportsOfflineId(doctype) {
	return POSTING_DOCTYPES.includes(doctype)
}

/**
 * Pin an invoice to the moment of the sale. Without set_posting_time, ERPNext
 * replaces the date with the time of the sync. A stamped invoice stays as it
 * is, and older queue rows fall back to the time they were queued.
 * @param {Object} invoice - Invoice payload
 * @param {number} [timestamp] - When the sale happened
 * @returns {Object} A new payload
 */
export function withOfflinePosting(invoice, timestamp = Date.now()) {
	const doctype = invoice.doctype || "Sales Invoice"
	if (!POSTING_DOCTYPES.includes(doctype) || invoice.set_posting_time) {
		return invoice
	}
	return { ...invoice, ...formatLocalPosting(timestamp), set_posting_time: 1 }
}

/**
 * Fingerprint of what is being sold, used to tell a retry from a new sale.
 * @param {Object} invoice - Invoice payload
 * @returns {string}
 */
export function getSaleSignature(invoice) {
	return JSON.stringify({
		customer: invoice.customer,
		discount: invoice.discount_amount || 0,
		items: (invoice.items || []).map((item) => [item.item_code, item.qty, item.rate, item.uom]),
		payments: (invoice.payments || []).map((row) => [row.mode_of_payment, row.amount]),
	})
}

const getStatus = (error) => error?.httpStatus || error?.status || error?.response?.status

/**
 * True when the request may never have reached the server, or the outcome is
 * unknown. A response from the application itself is not a network failure.
 * @param {Error|Object} error
 * @returns {boolean}
 */
export function isNetworkFailure(error) {
	if (!error || error.exc_type) return false

	const status = getStatus(error)
	if (status) return GATEWAY_STATUSES.includes(status)

	const message = String(error.message || error)
	return (
		error.name === "TypeError" ||
		error.name === "AbortError" ||
		/failed to fetch|networkerror|load failed|network request failed/i.test(message)
	)
}

/**
 * Decide who a sync failure belongs to.
 * @param {Error|Object} error
 * @returns {"network"|"auth"|"invoice"} network and auth pause the queue;
 *   invoice counts against that invoice only
 */
export function classifySyncError(error) {
	if (isNetworkFailure(error)) return "network"
	if (getStatus(error) === 401 || AUTH_ERROR_TYPES.includes(error?.exc_type)) return "auth"
	return "invoice"
}

/**
 * Stock held by queued sales, in stock units, per item. Derived from the queue
 * itself, so it survives a restart and clears as invoices leave the queue.
 * @param {Array} rows - Queue rows, already filtered to pending ones
 * @param {string|null} warehouse - Limit to this warehouse
 * @returns {Map<string, number>}
 */
export function sumQueuedStock(rows, warehouse = null) {
	const totals = new Map()
	for (const row of rows) {
		if (row.data?.doctype === "Sales Order") continue
		for (const item of row.data?.items || []) {
			if (!item.item_code) continue
			if (warehouse && item.warehouse && item.warehouse !== warehouse) continue
			const qty = Number(item.qty ?? item.quantity) || 0
			const stockQty = qty * (Number(item.conversion_factor) || 1)
			totals.set(item.item_code, (totals.get(item.item_code) || 0) + stockQty)
		}
	}
	return totals
}

/**
 * Whether a shift may close with these invoices still queued. Sales still on
 * their way block the close. Invoices that keep failing need a person's
 * decision, otherwise one bad invoice would stop the shift from ever closing.
 * @param {Array} pendingRows - Queue rows, already filtered to pending ones
 * @param {boolean} offline - Whether the device is offline
 * @returns {"allow"|"confirm"|"block"}
 */
export function getShiftCloseDecision(pendingRows, offline) {
	if (pendingRows.length === 0) return "allow"
	if (offline) return "block"
	return pendingRows.every((row) => row.sync_failed) ? "confirm" : "block"
}
