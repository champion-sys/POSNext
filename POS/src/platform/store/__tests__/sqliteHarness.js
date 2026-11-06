import { createRequire } from "node:module"
import { createCapacitorExecutor } from "@/platform/capacitor/sqlExecutor"
import { createElectronExecutor } from "@/platform/electron/sqlExecutor"

const require = createRequire(import.meta.url)

// Vite cannot resolve node:sqlite through an import
const { DatabaseSync } = require("node:sqlite")
const { createHandler } = require("../../../../desktop/electron/db/handler.js")

const isRead = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql)

/**
 * A plain executor, as strict as better-sqlite3: all() and run() each refuse the other's
 * statements, which node:sqlite alone would let through.
 */
export function createNodeExecutor(db = new DatabaseSync(":memory:")) {
	return {
		db,
		statements: [],

		async all(sql, params = []) {
			if (!isRead(sql)) throw new Error(`all() got a write: ${sql}`)
			return db.prepare(sql).all(...params)
		},

		async run(sql, params = []) {
			if (isRead(sql)) throw new Error(`run() got a read: ${sql}`)
			db.prepare(sql).run(...params)
		},

		async batch(statements) {
			this.statements.push(...statements)
			db.exec("BEGIN")
			try {
				for (const { sql, params = [] } of statements) db.prepare(sql).run(...params)
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
	}
}

/** The renderer's executor, through what the utility process really runs */
export function createElectronHarness() {
	const db = new DatabaseSync(":memory:")
	const handler = createHandler(db)
	const overIpc = (value) => structuredClone(value)

	return createElectronExecutor({
		all: async (sql, params) => handler.all(sql, overIpc(params)),
		run: async (sql, params) => handler.run(sql, overIpc(params)),
		batch: async (statements) => handler.batch(overIpc(statements)),
	})
}

/**
 * An SQLiteDBConnection that keeps the rules read from the plugin's Android source: only
 * JSON crosses, a statement without values fails, and so does an empty set.
 */
export function createFakeConnection(db = new DatabaseSync(":memory:")) {
	const overBridge = (value) => JSON.parse(JSON.stringify(value))
	let inTransaction = false

	const connection = {
		sets: [],

		async query(statement, values = []) {
			return { values: db.prepare(statement).all(...overBridge(values)) }
		},

		async run(statement, values = [], transaction = true) {
			if (transaction && inTransaction) throw new Error("Already in transaction")
			db.prepare(statement).run(...overBridge(values))
			return { changes: { changes: 1 } }
		},

		async executeSet(set, transaction = true) {
			if (set.length === 0) throw new Error("lastId equals -1")
			if (transaction && inTransaction) throw new Error("Already in transaction")
			connection.sets.push({ size: set.length, transaction })

			const rows = overBridge(set)
			inTransaction = true
			db.exec("BEGIN")
			// Let another call arrive while the set runs, as it can across the bridge
			await Promise.resolve()
			try {
				for (const { statement, values } of rows) {
					if (!Array.isArray(values)) throw new Error("No value for values")
					db.prepare(statement).run(...values)
				}
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			} finally {
				inTransaction = false
			}
			return { changes: { changes: rows.length } }
		},
	}
	return connection
}

export function createCapacitorHarness() {
	return createCapacitorExecutor(createFakeConnection())
}
