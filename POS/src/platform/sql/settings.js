/**
 * Settings and sync timestamps on SQLite.
 *
 * @module platform/sql/settings
 */

import { placeholders } from "./searchText"

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createSettings(sql) {
	const setStatement = (key, value) => ({
		sql: `INSERT INTO kv (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		params: [key, JSON.stringify(value) ?? "null"],
	})

	return {
		setStatement,

		async get(key, defaultValue = null) {
			const [row] = await sql.all("SELECT value FROM kv WHERE key = ?", [key])
			return row ? JSON.parse(row.value) : defaultValue
		},

		async set(key, value) {
			const { sql: statement, params } = setStatement(key, value)
			await sql.run(statement, params)
		},

		deleteStatement(keys) {
			return { sql: `DELETE FROM kv WHERE key IN (${placeholders(keys)})`, params: keys }
		},

		async deleteByPrefix(prefix) {
			await sql.run("DELETE FROM kv WHERE substr(key, 1, ?) = ?", [prefix.length, prefix])
		},

		clearStatements() {
			return [{ sql: "DELETE FROM kv" }]
		},
	}
}
