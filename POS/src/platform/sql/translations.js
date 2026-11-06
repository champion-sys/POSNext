/**
 * Translation bundles on SQLite, for starting in the cashier's language with no connection.
 *
 * @module platform/sql/translations
 */

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createTranslations(sql) {
	return {
		async get(locale) {
			const [row] = await sql.all("SELECT locale, messages, timestamp FROM translation WHERE locale = ?", [locale])
			return row ? { ...row, messages: JSON.parse(row.messages) } : null
		},

		async put({ locale, messages, timestamp }) {
			await sql.run(
				`INSERT INTO translation (locale, messages, timestamp) VALUES (?, ?, ?)
				ON CONFLICT(locale) DO UPDATE SET messages = excluded.messages, timestamp = excluded.timestamp`,
				[locale, JSON.stringify(messages), timestamp ?? null],
			)
		},

		/** @param {string} [locale] - Every locale when omitted */
		async remove(locale) {
			if (locale) {
				await sql.run("DELETE FROM translation WHERE locale = ?", [locale])
			} else {
				await sql.run("DELETE FROM translation")
			}
		},
	}
}
