/**
 * Hands out the local invoice numbers (see ./localNumber) and keeps their counters in the
 * device's storage, so they survive a restart and work offline.
 *
 * The server says, for each shift it knows, which series apply, the shift's number and the
 * next counter for sales and for returns (local_numbering). A counter continues from the
 * larger of the device's own and the server's, so a device that starts mid-shift goes on
 * from the numbers the server already holds. A server that sends no local_numbering gets
 * no local numbers, as before.
 *
 * @module utils/offline/localNumbering
 */

import { localStore } from "@/platform/store"
import { logger } from "@/utils/logger"
import { formatLocalPosting } from "./invoicePayload"
import { RETURN, SALE, buildNumberPrefix, formatLocalNumber, getShiftNumber } from "./localNumber"

const log = logger.create("LocalNumbering")

const SHIFT_KEY_PREFIX = "local_numbering_shift:"
const PROFILE_KEY_PREFIX = "local_numbering_profile:"
const NEXT_KEY_PREFIX = "local_numbering_next:"
const LOCK_NAME = "pos_next_local_number"

const shiftKey = (shift) => `${SHIFT_KEY_PREFIX}${shift}`
const profileKey = (profile) => `${PROFILE_KEY_PREFIX}${profile}`
const nextKey = (shift, kind) => `${NEXT_KEY_PREFIX}${shift}:${kind}`

const toCounter = (value) => {
	const number = Number.parseInt(value, 10)
	return Number.isFinite(number) && number > 0 ? number : 1
}

let queue = Promise.resolve()

/**
 * One allocation at a time: in this tab through the queue, across tabs and windows through
 * the Web Locks API where the platform has it.
 */
function withLock(task) {
	const run = () =>
		typeof navigator !== "undefined" && navigator.locks?.request
			? navigator.locks.request(LOCK_NAME, task)
			: task()
	const result = queue.then(run, run)
	queue = result.catch(() => {})
	return result
}

/**
 * Keep what the server said about a shift's numbering. The series are also kept for the
 * POS Profile, for a shift opened offline that the server has said nothing about.
 * @param {Object|null} info - local_numbering: {sale_series, return_series, shift_number, next: {sale, return}}
 * @param {{shift: string, posProfile?: string}} where
 */
export async function rememberLocalNumbering(info, { shift, posProfile } = {}) {
	if (!info || typeof info !== "object" || !shift) return
	try {
		const series = { sale_series: info.sale_series || null, return_series: info.return_series || null }
		// In the queue, so a sale made right after the answer arrived already numbers by it
		await withLock(async () => {
			await localStore.setSetting(shiftKey(shift), {
				...series,
				shift_number: info.shift_number ?? null,
				next: { [SALE]: toCounter(info.next?.[SALE]), [RETURN]: toCounter(info.next?.[RETURN]) },
			})
			if (posProfile && series.sale_series) await localStore.setSetting(profileKey(posProfile), series)
		})
	} catch (error) {
		log.warn("Could not keep the shift's numbering:", error)
	}
}

/**
 * The local_numbering an answer carries, wherever the server put it.
 * @param {Object|null} data - bootstrap, check_opening_shift or create_opening_shift
 * @returns {Object|null}
 */
export function readLocalNumbering(data) {
	if (!data || typeof data !== "object") return null
	return data.local_numbering || data.shift?.local_numbering || data.pos_opening_shift?.local_numbering || null
}

/**
 * Keep the numbering a shift's answer carries.
 * @param {Object|null} data - check_opening_shift or create_opening_shift
 */
export function rememberShiftNumbering(data) {
	const shift = data?.pos_opening_shift
	return rememberLocalNumbering(readLocalNumbering(data), {
		shift: shift?.name,
		posProfile: shift?.pos_profile || data?.pos_profile?.name,
	})
}

/**
 * The next local number for an invoice, used up as it is handed out. It is never handed
 * out twice, even to two sales started at once.
 * @param {Object} invoice - With posa_pos_opening_shift, pos_profile, is_return, posting_date
 * @returns {Promise<string|null>} null when the server never said how to number, or the
 *   device storage failed: the sale goes on without one
 */
export async function allocateLocalNumber(invoice) {
	const shift = invoice?.posa_pos_opening_shift
	if (!shift) return null
	const kind = invoice.is_return ? RETURN : SALE
	const date = invoice.posting_date || formatLocalPosting().posting_date

	try {
		return await withLock(async () => {
			const info = await localStore.getSetting(shiftKey(shift))
			const series =
				info?.sale_series || !invoice.pos_profile
					? info
					: await localStore.getSetting(profileKey(invoice.pos_profile))
			const prefix = buildNumberPrefix({
				saleSeries: series?.sale_series,
				returnSeries: series?.return_series,
				kind,
				shiftNumber: getShiftNumber(shift, info?.shift_number),
				date,
			})
			if (!prefix) return null

			const counter = Math.max(
				toCounter(await localStore.getSetting(nextKey(shift, kind))),
				toCounter(info?.next?.[kind]),
			)
			await localStore.setSetting(nextKey(shift, kind), counter + 1)
			return formatLocalNumber(prefix, counter)
		})
	} catch (error) {
		log.warn("No local number for this invoice:", error)
		return null
	}
}
