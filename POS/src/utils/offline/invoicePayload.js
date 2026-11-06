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

/**
 * Wrap a queue row for the sync API.
 * @param {Object} row - Queue row
 * @param {Object} payload - The row's invoice, normalized for the server
 * @returns {Object}
 */
export function buildSyncEnvelope(row, payload) {
	const payments = payload.payments || []
	return {
		offline_id: payload.offline_id,
		entity: "invoice",
		entity_version: 1,
		seq: row.id,
		cashier: payload.cashier,
		pos_profile: payload.pos_profile,
		created_at_device: row.timestamp ? new Date(row.timestamp).toISOString() : null,
		client_totals: {
			grand_total: payload.grand_total,
			paid: payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0),
		},
		depends_on: [],
		payload,
	}
}

/**
 * Turn the server's answer about a sale into changes to its queue row.
 * @param {{status: string, invoice?: string, message?: string}} result
 * @returns {Object|null} Row changes, or null when the row should stay as it is
 */
export function getQueueUpdateForResult(result) {
	switch (result.status) {
		case "synced":
		case "duplicate":
			return {
				synced: true,
				server_invoice: result.invoice || null,
				server_status: "synced",
				sync_failed: false,
				error: null,
			}
		case "voided":
			return { synced: true, server_status: "voided", sync_failed: false, error: null }
		case "received":
		case "processing":
			return { server_status: result.status, sync_failed: false, error: null }
		case "needs_review":
		case "conflict":
			return { server_status: "needs_review", sync_failed: true, error: result.message || null }
		default:
			return null
	}
}

const BASE_RETRY_DELAY_MS = 5000
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000

/**
 * How long a failed invoice waits before the next attempt. The random spread stops a
 * whole shop of devices retrying at the same moment after an outage.
 * @param {number} attempts - Failed attempts so far
 * @param {() => number} [random]
 * @returns {number} Milliseconds
 */
export function getRetryDelayMs(attempts, random = Math.random) {
	const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 3 ** attempts)
	return Math.round(delay * (0.7 + random() * 0.6))
}
