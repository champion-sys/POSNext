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

const STOCK_DOCTYPES_EXCLUDED = ["Sales Order"]

/** States the sync engine still has to send */
const SENDABLE = ["pending"]

/** States that no longer hold stock or count as queued */
const FINISHED = ["synced", "voided"]

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
		 */
		async enqueueSale({ offlineId, invoice, receipt, localNumber, shift, now = Date.now(), supersedes }) {
			const [{ seq }] = await sql.all(
				"SELECT COALESCE((SELECT value FROM device_sequence WHERE name = 'outbox'), 0) + 1 AS seq",
			)

			const statements = [
				{
					sql: `INSERT INTO device_sequence (name, value) VALUES ('outbox', ?)
						ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
					params: [seq],
				},
				{
					sql: `INSERT INTO outbox (offline_id, seq, entity, entity_version, local_number, payload,
							state, shift, created_at)
						VALUES (?, ?, 'invoice', 1, ?, ?, 'pending', ?, ?)`,
					params: [offlineId, seq, localNumber ?? null, JSON.stringify(invoice), shift ?? null, now],
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
			return seq
		},

		/** Sales due for sending, oldest first */
		async nextBatch(limit, now = Date.now()) {
			const rows = await sql.all(
				`SELECT * FROM outbox
				WHERE state IN (${SENDABLE.map(() => "?").join(",")}) AND next_attempt_at <= ?
				ORDER BY seq LIMIT ?`,
				[...SENDABLE, now, limit],
			)
			return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
		},

		/** Record a failed send, for the backoff */
		async markFailed(offlineId, message, nextAttemptAt) {
			await sql.run(
				"UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE offline_id = ?",
				[message, nextAttemptAt, offlineId],
			)
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
							acked_at = COALESCE(acked_at, ?), synced_at = ?
						WHERE offline_id = ?`,
					params: [state, serverName, error, now, FINISHED.includes(state) ? now : null, offlineId],
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
