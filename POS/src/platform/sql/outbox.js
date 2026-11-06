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

import { placeholders } from "./searchText"

const STOCK_DOCTYPES_EXCLUDED = ["Sales Order"]

/** States the sync engine still has to send */
const SENDABLE = ["pending"]

/** States that no longer hold stock or count as queued */
const FINISHED = ["synced", "voided"]

/** States the app no longer lists as queued */
const CLOSED = [...FINISHED, "superseded"]

/** States the server knows nothing about */
const LOCAL_ONLY = ["pending", "superseded"]

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

const withPayload = (row) => ({ ...row, payload: JSON.parse(row.payload) })

/**
 * An outbox row in the shape the app reads
 * @param {Object} row - A row with its payload parsed
 * @returns {import("../store/methods").QueuedInvoice}
 */
export function toQueuedInvoice(row) {
	return {
		id: row.seq,
		offline_id: row.offline_id,
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
	}
}

/**
 * @param {SqlExecutor} sql
 */
export function createOutbox(sql) {
	return {
		/**
		 * Store a sale. The queue row, its receipt, its stock hold and the sequence move
		 * together, and an edit retires the original in the same transaction.
		 * @param {{offlineId: string, invoice: Object, receipt?: Object, localNumber?: string,
		 *   shift?: string, now?: number, supersedes?: string}} sale
		 * @returns {Promise<number>} The sale's place in the queue
		 */
		async enqueueSale({ offlineId, invoice, receipt, localNumber, shift, now = Date.now(), supersedes }) {
			// The sequence moves inside the batch. Read first, two quick sales would get the same number.
			const statements = [
				{
					sql: `INSERT INTO device_sequence (name, value) VALUES ('outbox', 1)
						ON CONFLICT(name) DO UPDATE SET value = value + 1`,
				},
				{
					sql: `INSERT INTO outbox (offline_id, seq, entity, entity_version, local_number, payload,
							state, shift, created_at)
						VALUES (?, (SELECT value FROM device_sequence WHERE name = 'outbox'), 'invoice', 1, ?, ?,
							'pending', ?, ?)`,
					params: [offlineId, localNumber ?? null, JSON.stringify(invoice), shift ?? null, now],
				},
				...reservationStatements(offlineId, invoice),
			]

			if (receipt) {
				statements.push({
					sql: "INSERT INTO receipt (offline_id, doc) VALUES (?, ?)",
					params: [offlineId, JSON.stringify(receipt)],
				})
			}

			if (supersedes) {
				statements.push(
					{
						sql: `UPDATE outbox SET state = 'superseded', superseded_by = ?
							WHERE offline_id = ? AND state = 'pending'`,
						params: [offlineId, supersedes],
					},
					{ sql: "DELETE FROM stock_reservation WHERE offline_id = ?", params: [supersedes] },
				)
			}

			await sql.batch(statements)
			const [{ seq }] = await sql.all("SELECT seq FROM outbox WHERE offline_id = ?", [offlineId])
			return seq
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
		 * @param {boolean} [gaveUp] - Automatic retries are over, a person has to look
		 */
		async markFailed(offlineId, message, nextAttemptAt, gaveUp = false) {
			await sql.run(
				`UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
					sync_failed = MAX(sync_failed, ?)
				WHERE offline_id = ?`,
				[message ?? null, nextAttemptAt ?? 0, gaveUp ? 1 : 0, offlineId],
			)
		},

		async updatePayload(offlineId, payload) {
			await sql.run("UPDATE outbox SET payload = ? WHERE offline_id = ?", [JSON.stringify(payload), offlineId])
		},

		/** Retire a replaced sale. Once sent, the server decides how it ends. */
		async supersede(offlineId, replacedBy = null) {
			await sql.batch([
				{
					sql: `UPDATE outbox SET state = 'superseded', superseded_by = ?
						WHERE offline_id = ? AND state = 'pending'`,
					params: [replacedBy, offlineId],
				},
				{
					sql: `DELETE FROM stock_reservation WHERE offline_id = ?
						AND EXISTS (SELECT 1 FROM outbox WHERE offline_id = ? AND state = 'superseded')`,
					params: [offlineId, offlineId],
				},
			])
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
