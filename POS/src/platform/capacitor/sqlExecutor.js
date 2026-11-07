/**
 * The Android database, through @capacitor-community/sqlite.
 *
 * @module platform/capacitor/sqlExecutor
 */

import { CapacitorSQLite, SQLiteConnection } from "@/platform/capacitor"
import { openSecretStore } from "../secrets"
import { openDatabase } from "./encryptedDatabase"

/**
 * @param {Object} connection - An open SQLiteDBConnection
 * @returns {import("../sql/outbox").SqlExecutor}
 */
export function createCapacitorExecutor(connection) {
	// One call at a time: a run during a batch would fail with "Already in transaction"
	let last = Promise.resolve()
	function inTurn(call) {
		const result = last.then(call, call)
		last = result.catch(() => {})
		return result
	}

	return {
		async all(sql, params = []) {
			const { values } = await inTurn(() => connection.query(sql, params))
			return values ?? []
		},

		async run(sql, params = []) {
			await inTurn(() => connection.run(sql, params, true))
		},

		async batch(statements) {
			// The plugin fails an empty set, and needs values on every statement
			if (statements.length === 0) return

			const set = statements.map(({ sql, params = [] }) => ({ statement: sql, values: params }))
			await inTurn(() => connection.executeSet(set, true))
		},
	}
}

export async function openExecutor() {
	const sqlite = new SQLiteConnection(CapacitorSQLite)
	const { connection, encrypted } = await openDatabase(sqlite, openSecretStore())
	return { ...createCapacitorExecutor(connection), encrypted }
}
