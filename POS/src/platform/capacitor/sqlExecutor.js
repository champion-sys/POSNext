/**
 * The Android database, through @capacitor-community/sqlite.
 *
 * @module platform/capacitor/sqlExecutor
 */

const DATABASE = "pos_next"
const SCHEMA_VERSION = 1
const ENCRYPTED = false
const NO_ENCRYPTION = "no-encryption"
const READ_ONLY = false

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

/**
 * Open the database, or reuse the connection a reloaded WebView left in the plugin.
 * @param {Object} sqlite - A SQLiteConnection
 * @returns {Promise<Object>} An open SQLiteDBConnection
 */
export async function connect(sqlite) {
	const consistent = (await sqlite.checkConnectionsConsistency()).result
	const connected = (await sqlite.isConnection(DATABASE, READ_ONLY)).result

	const connection =
		consistent && connected
			? await sqlite.retrieveConnection(DATABASE, READ_ONLY)
			: await sqlite.createConnection(DATABASE, ENCRYPTED, NO_ENCRYPTION, SCHEMA_VERSION, READ_ONLY)

	await connection.open()
	return connection
}

export async function openExecutor() {
	const { CapacitorSQLite, SQLiteConnection } = await import("./plugin")
	return createCapacitorExecutor(await connect(new SQLiteConnection(CapacitorSQLite)))
}
