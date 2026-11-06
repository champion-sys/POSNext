/**
 * Draft invoices on SQLite.
 *
 * @module platform/sql/drafts
 */

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createDrafts(sql) {
	return {
		async add(draft) {
			await sql.run("INSERT INTO draft (draft_id, doc) VALUES (?, ?)", [draft.draft_id, JSON.stringify(draft)])
		},

		async put(draft) {
			await sql.run(
				`INSERT INTO draft (draft_id, doc) VALUES (?, ?)
				ON CONFLICT(draft_id) DO UPDATE SET doc = excluded.doc`,
				[draft.draft_id, JSON.stringify(draft)],
			)
		},

		async get(draftId) {
			const [row] = await sql.all("SELECT doc FROM draft WHERE draft_id = ?", [draftId])
			return row ? JSON.parse(row.doc) : undefined
		},

		async list() {
			const rows = await sql.all("SELECT doc FROM draft")
			return rows.map((row) => JSON.parse(row.doc))
		},

		async remove(draftId) {
			await sql.run("DELETE FROM draft WHERE draft_id = ?", [draftId])
		},

		async clear() {
			await sql.run("DELETE FROM draft")
		},

		async count() {
			const [{ count }] = await sql.all("SELECT COUNT(*) AS count FROM draft")
			return count
		},
	}
}
