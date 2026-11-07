/**
 * The sales queue on SQLite, for the desktop and Android apps.
 *
 * @typedef {Object} SqlExecutor
 * @property {(sql: string, params?: Array) => Promise<Array>} all
 * @property {(sql: string, params?: Array) => Promise<void>} run
 * @property {(statements: Array<{sql: string, params?: Array}>) => Promise<void>} batch
 *   Runs a list in one transaction. It takes a list, not a callback, because an
 *   interactive transaction across the Capacitor bridge is fragile.
 *
 * @module platform/sql/outbox
 */

import { ENTITY_INVOICE } from "@/utils/offline/entities"
import { placeholders } from "./searchText"

const STOCK_DOCTYPES_EXCLUDED = ["Sales Order"]

/**
 * Retire a sale, unless the server holds it: then the server decides how it ends, and it
 * keeps its stock until it does.
 */
function supersedeStatements(offlineId, replacedBy) {
	return [
		{
			sql: `UPDATE outbox SET state = 'superseded', superseded_by = ?
				WHERE offline_id = ? AND state = 'pending' AND void_reason IS NULL`,
			params: [replacedBy, offlineId],
		},
		{
			sql: `DELETE FROM stock_reservation WHERE offline_id = ?
				AND EXISTS (SELECT 1 FROM outbox WHERE offline_id = ? AND state = 'superseded')`,
			params: [offlineId, offlineId],
		},
	]
}

/** States the sync engine still has to send */
const SENDABLE = ["pending"]

/** States that no longer hold stock or count as queued */
const FINISHED = ["synced", "voided"]

/** States the app no longer lists as queued */
const CLOSED = [...FINISHED, "superseded"]

/** States the server knows nothing about */
const LOCAL_ONLY = ["pending", "superseded"]

function queueStatements({ offlineId, entity, payload, dependsOn, localNumber, shift, now }) {
	// The sequence moves inside the batch. Read first, two quick sales would get the same number.
	return [
		{
			sql: `INSERT INTO device_sequence (name, value) VALUES ('outbox', 1)
				ON CONFLICT(name) DO UPDATE SET value = value + 1`,
		},
		{
			sql: `INSERT INTO outbox (offline_id, seq, entity, entity_version, local_number, payload,
					depends_on, state, shift, created_at)
				VALUES (?, (SELECT value FROM device_sequence WHERE name = 'outbox'), ?, 1, ?, ?, ?,
					'pending', ?, ?)`,
			params: [
				offlineId,
				entity,
				localNumber ?? null,
				JSON.stringify(payload),
				JSON.stringify(dependsOn),
				shift ?? null,
				now,
			],
		},
	]
}

function reservationStatements(offlineId, invoice) {
	if (STOCK_DOCTYPES_EXCLUDED.includes(invoice.doctype)) return []

	const totals = new Map()
	for (const item of invoice.items || []) {
		if (!item.item_code || !item.warehouse) continue
		const key = `${item.item_code}\u0000${item.warehouse}`
		const qty = (Number(item.qty ?? item.quantity) || 0) * (Number(item.conversion_factor) || 1)
		totals.set(key, { ...item, stock_qty: (totals.get(key)?.stock_qty || 0) + qty })
	}

	return [...totals.values()].map((item) => ({
		sql: "INSERT INTO stock_reservation (offline_id, item_code, warehouse, stock_qty) VALUES (?, ?, ?, ?)",
		params: [offlineId, item.item_code, item.warehouse, item.stock_qty],
	}))
}

const withPayload = (row) => ({
	...row,
	payload: JSON.parse(row.payload),
	depends_on: JSON.parse(row.depends_on || "[]"),
})

/**
 * An outbox row in the shape the app reads
 * @param {Object} row - A row with its payload parsed
 * @returns {import("../store/methods").QueuedInvoice}
 */
export function toQueuedInvoice(row) {
	return {
		id: row.seq,
		offline_id: row.offline_id,
		entity: row.entity,
		depends_on: row.depends_on,
		data: row.payload,
		timestamp: row.created_at,
		synced: FINISHED.includes(row.state),
		retry_count: row.attempts,
		next_attempt_at: row.next_attempt_at,
		error: row.last_error,
		server_status: LOCAL_ONLY.includes(row.state) ? undefined : row.state,
		server_invoice: row.server_name,
		sync_failed: Boolean(row.sync_failed),
		superseded: row.state === "superseded",
		replaced_by: row.superseded_by,
		void_reason: row.void_reason,
	}
}

/**
 * @param {SqlExecutor} sql
 */
export function createOutbox(sql) {
	async function seqOf(offlineId) {
		const [{ seq }] = await sql.all("SELECT seq FROM outbox WHERE offline_id = ?", [offlineId])
		return seq
	}

	return {
		/**
		 * Store a sale. The queue row, its receipt, its stock hold and the sequence move
		 * together, and an edit retires the original in the same transaction.
		 * @param {{offlineId: string, invoice: Object, receipt?: Object, localNumber?: string,
		 *   shift?: string, now?: number, supersedes?: string, dependsOn?: string[]}} sale
		 * @returns {Promise<number>} The sale's place in the queue
		 */
		async enqueueSale({
			offlineId,
			invoice,
			receipt,
			localNumber,
			shift,
			now = Date.now(),
			supersedes,
			dependsOn = [],
		}) {
			const statements = [
				...queueStatements({
					offlineId,
					entity: ENTITY_INVOICE,
					payload: invoice,
					dependsOn,
					localNumber,
					shift,
					now,
				}),
				...reservationStatements(offlineId, invoice),
			]

			if (receipt) {
				statements.push({
					sql: "INSERT INTO receipt (offline_id, doc) VALUES (?, ?)",
					params: [offlineId, JSON.stringify(receipt)],
				})
			}

			if (supersedes) {
				statements.push(...supersedeStatements(supersedes, offlineId))
			}

			await sql.batch(statements)
			return seqOf(offlineId)
		},

		/**
		 * Store a record that is not a sale, in the same queue so that its order keeps it
		 * ahead of the sales that need it. It holds no stock and has no receipt.
		 * @param {{offlineId: string, entity: string, data: Object, dependsOn?: string[],
		 *   shift?: string, now?: number}} record
		 * @returns {Promise<number>} Its place in the queue
		 */
		async enqueueEntity({ offlineId, entity, data, dependsOn = [], shift, now = Date.now() }) {
			await sql.batch(queueStatements({ offlineId, entity, payload: data, dependsOn, shift, now }))
			return seqOf(offlineId)
		},

		/** Sales due for sending, oldest first */
		async nextBatch(limit, now = Date.now()) {
			const rows = await sql.all(
				`SELECT * FROM outbox
				WHERE state IN (${placeholders(SENDABLE)}) AND next_attempt_at <= ?
				ORDER BY seq LIMIT ?`,
				[...SENDABLE, now, limit],
			)
			return rows.map(withPayload)
		},

		/** Sales still on their way, oldest first */
		async listQueued() {
			const rows = await sql.all(
				`SELECT * FROM outbox WHERE state NOT IN (${placeholders(CLOSED)}) ORDER BY seq`,
				CLOSED,
			)
			return rows.map(withPayload)
		},

		/** Every row still on the device, including those that have synced */
		async listKept() {
			const rows = await sql.all("SELECT * FROM outbox WHERE state != 'superseded' ORDER BY seq")
			return rows.map(withPayload)
		},

		async countQueued() {
			const [{ count }] = await sql.all(
				`SELECT COUNT(*) AS count FROM outbox WHERE state NOT IN (${placeholders(CLOSED)})`,
				CLOSED,
			)
			return count
		},

		async get(offlineId) {
			const [row] = await sql.all("SELECT * FROM outbox WHERE offline_id = ?", [offlineId])
			return row ? withPayload(row) : null
		},

		async getBySeq(seq) {
			const [row] = await sql.all("SELECT * FROM outbox WHERE seq = ?", [seq])
			return row ? withPayload(row) : null
		},

		/**
		 * Record a failed send, for the backoff
		 * @param {string} offlineId
		 * @param {string} message
		 * @param {number} nextAttemptAt
		 * @param {Object} [options]
		 * @param {boolean} [options.gaveUp] - Automatic retries are over, a person has to look
		 * @param {number} [options.attempts] - How many there have been, one more when omitted
		 */
		async markFailed(offlineId, message, nextAttemptAt, { gaveUp = false, attempts = null } = {}) {
			await sql.run(
				`UPDATE outbox SET attempts = COALESCE(?, attempts + 1), last_error = ?, next_attempt_at = ?,
					sync_failed = MAX(sync_failed, ?)
				WHERE offline_id = ?`,
				[attempts, message ?? null, nextAttemptAt ?? 0, gaveUp ? 1 : 0, offlineId],
			)
		},

		async updatePayload(offlineId, payload) {
			await sql.run("UPDATE outbox SET payload = ? WHERE offline_id = ?", [JSON.stringify(payload), offlineId])
		},

		/** Retire a replaced sale */
		async supersede(offlineId, replacedBy = null) {
			await sql.batch(supersedeStatements(offlineId, replacedBy))
		},

		/**
		 * Ask for a record to be voided. It stays until the server answers, but its stock
		 * hold ends in the same transaction. A first request's reason stands.
		 * @param {string} offlineId
		 * @param {string} reason
		 * @returns {Promise<boolean>} Whether the record is waiting to be voided
		 */
		async requestVoid(offlineId, reason) {
			await sql.batch([
				{
					sql: `UPDATE outbox SET void_reason = ?, attempts = 0, next_attempt_at = 0, last_error = NULL,
							sync_failed = 0
						WHERE offline_id = ? AND void_reason IS NULL AND state NOT IN (${placeholders(CLOSED)})`,
					params: [reason, offlineId, ...CLOSED],
				},
				{ sql: "DELETE FROM stock_reservation WHERE offline_id = ?", params: [offlineId] },
			])
			const [row] = await sql.all("SELECT void_reason FROM outbox WHERE offline_id = ?", [offlineId])
			return Boolean(row?.void_reason)
		},

		/**
		 * Give a record back to the queue after the server refused to void it. Its stock
		 * hold returns in the same transaction.
		 * @param {string} offlineId
		 * @returns {Promise<boolean>} Whether a void was waiting
		 */
		async cancelVoid(offlineId) {
			const [row] = await sql.all(
				`SELECT payload FROM outbox
				WHERE offline_id = ? AND void_reason IS NOT NULL AND state NOT IN (${placeholders(CLOSED)})`,
				[offlineId, ...CLOSED],
			)
			if (!row) return false

			await sql.batch([
				{
					sql: `UPDATE outbox SET void_reason = NULL, attempts = 0, next_attempt_at = 0, last_error = NULL,
							sync_failed = 0
						WHERE offline_id = ?`,
					params: [offlineId],
				},
				...reservationStatements(offlineId, JSON.parse(row.payload)),
			])
			return true
		},

		/** Delete a sale with everything that hangs off it */
		async remove(offlineId) {
			await sql.batch(
				["outbox", "stock_reservation", "receipt"].map((table) => ({
					sql: `DELETE FROM ${table} WHERE offline_id = ?`,
					params: [offlineId],
				})),
			)
		},

		/** @param {number} cutoff - Finished sales queued before this go, with their receipts */
		async purgeFinished(cutoff) {
			const finished = `state IN (${placeholders(FINISHED)}) AND created_at < ?`
			const params = [...FINISHED, cutoff]
			await sql.batch([
				{ sql: `DELETE FROM receipt WHERE offline_id IN (SELECT offline_id FROM outbox WHERE ${finished})`, params },
				{ sql: `DELETE FROM outbox WHERE ${finished}`, params },
			])
		},

		/**
		 * Apply the server's answer. A finished sale releases its stock hold in the same
		 * transaction, so the two can never disagree.
		 * @param {string} offlineId
		 * @param {{state: string, serverName?: string, error?: string}} result
		 */
		async applyResult(offlineId, { state, serverName = null, error = null }, now = Date.now()) {
			const statements = [
				{
					sql: `UPDATE outbox SET state = ?, server_name = COALESCE(?, server_name), last_error = ?,
							sync_failed = ?, acked_at = COALESCE(acked_at, ?), synced_at = ?
						WHERE offline_id = ?`,
					params: [
						state,
						serverName,
						error,
						state === "needs_review" ? 1 : 0,
						now,
						FINISHED.includes(state) ? now : null,
						offlineId,
					],
				},
			]
			if (FINISHED.includes(state)) {
				statements.push({ sql: "DELETE FROM stock_reservation WHERE offline_id = ?", params: [offlineId] })
			}
			await sql.batch(statements)
		},

		/** The server has no record of a sale it held, so it waits to be sent again */
		async returnToPending(offlineId) {
			await sql.run(
				`UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL,
					server_name = NULL, sync_failed = 0, acked_at = NULL
				WHERE offline_id = ? AND state NOT IN (${placeholders(CLOSED)})`,
				[offlineId, ...CLOSED],
			)
		},

		/** After a crash, sends in flight are unknown. Retrying is safe: the server dedupes. */
		async recoverInterrupted() {
			await sql.run("UPDATE outbox SET state = 'pending' WHERE state = 'sending'")
		},

		async countsByState() {
			const rows = await sql.all("SELECT state, COUNT(*) AS count FROM outbox GROUP BY state")
			return Object.fromEntries(rows.map((row) => [row.state, row.count]))
		},

		/** Stock on hand after sales the server has not counted yet */
		async availableStock(itemCode, warehouse) {
			const [row] = await sql.all(
				`SELECT COALESCE((SELECT qty FROM stock_base WHERE item_code = ? AND warehouse = ?), 0)
					- COALESCE((SELECT SUM(stock_qty) FROM stock_reservation WHERE item_code = ? AND warehouse = ?), 0)
					AS qty`,
				[itemCode, warehouse, itemCode, warehouse],
			)
			return row.qty
		},
	}
}
