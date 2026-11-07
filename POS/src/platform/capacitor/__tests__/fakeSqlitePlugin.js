import { existsSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

// Vite cannot resolve node:sqlite through an import
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")

const NOT_A_DATABASE = "file is not a database (code 26 SQLITE_NOTADB)"
const QUOTED_PATH = /^ATTACH DATABASE '(.+)' AS (\w+) KEY ''$/

/** What a kill leaves: nothing after this point runs, not even a clean-up. */
export class KilledError extends Error {}

/**
 * @capacitor-community/sqlite as its Android source behaves, on real files. A file is only
 * "encrypted" in that this remembers its secret and refuses any other, because node:sqlite
 * has no cipher, so this can prove the order of the steps and never the cipher itself.
 * @param {string} folder
 */
export function createFakeSqlitePlugin(folder) {
	const fileSecrets = new Map()
	const connections = new Map()
	const pathOf = (name) => join(folder, `${name}SQLite.db`)

	const plugin = {
		secret: null,
		secretLoaded: true,
		created: [],
		failOn: null,
		killOn: null,
		killed: false,
		dropRowsOnExport: false,
		secretOf: (name) => fileSecrets.get(name),

		/** Starts the app again on the same disk. The page's connections are gone. */
		restart() {
			for (const connection of connections.values()) connection.close()
			connections.clear()
			plugin.killed = false
			plugin.killOn = null
			plugin.failOn = null
		},

		guard(statement = "") {
			if (plugin.killed) throw new KilledError("The process is gone")
			if (plugin.killOn?.test(statement)) {
				plugin.killed = true
				throw new KilledError(`Killed at ${statement}`)
			}
			if (plugin.failOn?.test(statement)) throw new Error(`Failed at ${statement}`)
		},

		async isDatabase(name) {
			if (!plugin.secretLoaded) throw new Error("CapacitorSQLitePlugin: keystore failed")
			return { result: existsSync(pathOf(name)) }
		},

		async isSecretStored() {
			if (!plugin.secretLoaded) throw new Error("CapacitorSQLitePlugin: keystore failed")
			return { result: Boolean(plugin.secret) }
		},

		async setEncryptionSecret(secret) {
			plugin.guard("setEncryptionSecret")
			if (plugin.secret) throw new Error("a passphrase has already been set ")
			plugin.secret = secret
			for (const [name, fileSecret] of fileSecrets) {
				if (fileSecret !== secret) throw new Error(`State for: ${name}SQLite.db not correct`)
			}
		},

		async checkConnectionsConsistency() {
			plugin.guard()
			return { result: connections.size > 0 }
		},

		async isConnection(name) {
			return { result: connections.has(name) }
		},

		async retrieveConnection(name) {
			return connections.get(name)
		},

		async createConnection(name, encrypted, mode, version, readonly) {
			plugin.guard(`createConnection ${name}`)
			if (connections.has(name)) throw new Error(`Connection ${name} already exists`)
			plugin.created.push({ name, encrypted, mode, version, readonly })
			const connection = createConnection(name, encrypted, mode)
			connections.set(name, connection)
			return connection
		},

		async closeConnection(name) {
			plugin.guard(`closeConnection ${name}`)
			connections.get(name)?.close()
			connections.delete(name)
		},
	}

	function createConnection(name, encrypted, mode) {
		let db = null

		function exportFrom(source) {
			const objects = db
				.prepare(`SELECT type, name, sql FROM ${source}.sqlite_master WHERE sql IS NOT NULL`)
				.all()
			for (const { sql } of objects) db.exec(sql)
			for (const { type, name: table } of objects) {
				if (type !== "table") continue
				db.exec(`INSERT INTO main."${table}" SELECT * FROM ${source}."${table}"`)
				if (plugin.dropRowsOnExport) {
					db.exec(`DELETE FROM main."${table}" WHERE rowid = (SELECT MAX(rowid) FROM main."${table}")`)
				}
			}
		}

		return {
			async open() {
				plugin.guard(`open ${name}`)
				if (db) return

				const secret = encrypted ? plugin.secret : ""
				if (encrypted && !secret) throw new Error("No Passphrase stored")

				const isNew = !existsSync(pathOf(name))
				if (!isNew && (fileSecrets.get(name) ?? "") !== secret) {
					throw new Error(`Error in creating the database${NOT_A_DATABASE}`)
				}
				if (isNew && secret) fileSecrets.set(name, secret)
				db = new DatabaseSync(pathOf(name))
			},

			close() {
				db?.close()
				db = null
			},

			async getUrl() {
				return { url: `file://${pathOf(name)}` }
			},

			async execute(statement, transaction = true) {
				plugin.guard(statement)
				const attach = statement.match(QUOTED_PATH)
				if (attach) {
					if (transaction) throw new Error("cannot ATTACH database within transaction")
					const isEncrypted = [...fileSecrets.keys()].some((other) => pathOf(other) === attach[1])
					if (isEncrypted) throw new Error(NOT_A_DATABASE)
					db.exec(`ATTACH DATABASE '${attach[1]}' AS ${attach[2]}`)
					return { changes: { changes: 0 } }
				}
				db.exec(statement)
				return { changes: { changes: 0 } }
			},

			async query(statement, values = []) {
				plugin.guard(statement)
				const exported = statement.match(/^SELECT sqlcipher_export\('main', '(\w+)'\)$/)
				if (exported) {
					exportFrom(exported[1])
					return { values: [{ "sqlcipher_export('main', 'plain')": null }] }
				}
				return { values: db.prepare(statement).all(...values) }
			},

			async run(statement, values = []) {
				plugin.guard(statement)
				db.prepare(statement).run(...values)
				return { changes: { changes: 1 } }
			},

			async delete() {
				plugin.guard(`delete ${name}`)
				db?.close()
				db = null
				rmSync(pathOf(name), { force: true })
				fileSecrets.delete(name)
			},
		}
	}

	return plugin
}

/**
 * The secure storage plugin, which commits as it goes and so survives a kill.
 * @returns {import("../../secrets").SecretStore}
 */
export function createFakeSecrets() {
	const entries = new Map()
	return {
		entries,
		get: async (key) => entries.get(key) ?? null,
		set: async (key, value) => {
			entries.set(key, value)
		},
		remove: async (key) => {
			entries.delete(key)
		},
	}
}
