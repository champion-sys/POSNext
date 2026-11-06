/**
 * Receipts on SQLite. A sale's first receipt commits with the sale in the outbox, and
 * the fuller document the checkout builds afterwards replaces it here.
 *
 * @module platform/sql/receipts
 */

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createReceipts(sql) {
	return {
		async save(offlineId, doc) {
			await sql.run(
				`INSERT INTO receipt (offline_id, doc) VALUES (?, ?)
				ON CONFLICT(offline_id) DO UPDATE SET doc = excluded.doc`,
				[offlineId, JSON.stringify(doc)],
			)
		},

		async get(offlineId) {
			const [row] = await sql.all("SELECT doc FROM receipt WHERE offline_id = ?", [offlineId])
			return row ? JSON.parse(row.doc) : null
		},

		async markPrinted(offlineId) {
			await sql.run("UPDATE receipt SET printed_count = printed_count + 1 WHERE offline_id = ?", [offlineId])
		},

		async remove(offlineId) {
			await sql.run("DELETE FROM receipt WHERE offline_id = ?", [offlineId])
		},

		async clear() {
			await sql.run("DELETE FROM receipt")
		},
	}
}
