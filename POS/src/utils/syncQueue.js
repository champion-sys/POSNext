/**
 * How a queued invoice reads to a person. The header, the store and the queue
 * dialog share these so they cannot disagree about a sale.
 *
 * @module utils/syncQueue
 */

import { SALE_STANDS, formatLocalPosting, isVoidPending } from "@/utils/offline/invoicePayload"

export const QUEUE_WAITING = "waiting"
export const QUEUE_SENDING = "sending"
export const QUEUE_RECEIVED = "received"
export const QUEUE_REVIEW = "needs_review"
export const QUEUE_FAILED = "failed"
export const QUEUE_VOIDING = "voiding"
export const QUEUE_SALE_STANDS = "sale_stands"

/**
 * @param {Object} row - Queue row
 * @param {boolean} [isSyncing] - Whether a sync is running now
 * @returns {string} One of the QUEUE_ states
 */
export function getQueueRowState(row, isSyncing = false) {
	if (row.server_status === SALE_STANDS) return QUEUE_SALE_STANDS
	if (isVoidPending(row)) return QUEUE_VOIDING
	if (row.server_status === "needs_review") return QUEUE_REVIEW
	if (row.server_status) return QUEUE_RECEIVED
	if (row.sync_failed) return QUEUE_FAILED
	return isSyncing ? QUEUE_SENDING : QUEUE_WAITING
}

/**
 * Whether a person has to look at this invoice. It stays in the queue until
 * someone does, so it does not count as waiting.
 * @param {Object} row - Queue row
 * @returns {boolean}
 */
export function needsAttention(row) {
	const state = getQueueRowState(row)
	return (
		state === QUEUE_REVIEW ||
		state === QUEUE_FAILED ||
		state === QUEUE_SALE_STANDS ||
		(state === QUEUE_VOIDING && Boolean(row.sync_failed))
	)
}

/**
 * Whether this invoice exists only on this device. Once the server holds a
 * sale, it is the server's job, so such a sale no longer counts. A void still has to
 * reach the server, whatever the server holds.
 * @param {Object} row - Queue row
 * @returns {boolean}
 */
export function isWaitingToSend(row) {
	const state = getQueueRowState(row)
	return state === QUEUE_WAITING || (state === QUEUE_VOIDING && !row.sync_failed)
}

/**
 * Put invoices that need a person first, then the oldest first.
 * @param {Array} rows - Queue rows
 * @returns {Array} A new list
 */
export function sortQueueRows(rows) {
	return [...rows].sort(
		(a, b) =>
			needsAttention(b) - needsAttention(a) ||
			(a.timestamp || 0) - (b.timestamp || 0),
	)
}

/**
 * A sync time as the clock time today and with its date before that. Digits stay
 * Western, as in the rest of the POS, and the date cannot be read two ways.
 * @param {number} timestamp - Milliseconds since the epoch
 * @param {number} [now]
 * @returns {string}
 */
export function formatSyncTime(timestamp, now = Date.now()) {
	const { posting_date: date, posting_time: time } =
		formatLocalPosting(timestamp)
	const clock = time.slice(0, 5)
	return date === formatLocalPosting(now).posting_date
		? clock
		: `${date} ${clock}`
}
