/**
 * The open shift on SQLite, so a restart with no connection can carry on selling.
 *
 * @module platform/sql/shifts
 */

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createShifts(sql) {
	return {
		async save(data) {
			await sql.run(
				`INSERT INTO current_shift (slot, doc) VALUES (1, ?)
				ON CONFLICT(slot) DO UPDATE SET doc = excluded.doc`,
				[JSON.stringify(data)],
			)
		},

		async get() {
			const [row] = await sql.all("SELECT doc FROM current_shift")
			return row ? JSON.parse(row.doc) : null
		},

		async clear() {
			await sql.run("DELETE FROM current_shift")
		},
	}
}
