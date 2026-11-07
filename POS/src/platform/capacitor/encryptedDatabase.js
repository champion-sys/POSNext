/**
 * Opening the Android database, which the plugin encrypts with SQLCipher.
 *
 * The plugin keeps one secret for all its databases, in EncryptedSharedPreferences under a
 * Keystore key, and setEncryptionSecret must run before the first encrypted open. It saves
 * that secret with apply(), which reaches the disk some time after the call returns. A
 * process killed in between would strand a file encrypted with a secret nobody has, so
 * the secret goes to the secure storage plugin first: its set() commits, and a read back
 * proves it before anything is encrypted.
 *
 * The plugin's "encryption" mode is not used on an old plain file. It deletes the original
 * and then renames the new file into place, so a process killed between the two loses
 * every sale, and it would run again on each open of that connection. Instead the plain
 * file gets copied into a database of its own name. A row in the new file, written last,
 * is the point of no return, and the original stays untouched until then.
 *
 * @module platform/capacitor/encryptedDatabase
 */

import { DatabaseLockedError, LOCK } from "@/platform/store/databaseLock"
import { logger } from "@/utils/logger"

const log = logger.create("EncryptedDatabase")

const DATABASE = "pos_next_secure"
const PLAIN_DATABASE = "pos_next"
const SECRET_KEY = "pos_next_database_secret"
const SECRET_BYTES = 32
const SCHEMA_VERSION = 1
const READ_ONLY = false
const COPY_DONE_TABLE = "encrypted_copy_done"

function createSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function saveNewSecret(secrets) {
	const secret = createSecret()
	await secrets.set(SECRET_KEY, secret)
	// The storage plugin answers true even when the Keystore refused the write
	if ((await secrets.get(SECRET_KEY)) !== secret) throw new Error("The secret did not keep")
	return secret
}

/** Give the plugin the device's secret, making it the first time. */
async function prepareSecret(sqlite, secrets) {
	if ((await sqlite.isSecretStored()).result) return
	const secret = (await secrets.get(SECRET_KEY)) ?? (await saveNewSecret(secrets))
	await sqlite.setEncryptionSecret(secret)
}

/** The same, for a file that exists: a new secret would never open it. */
async function restoreSecret(sqlite, secrets) {
	try {
		if ((await sqlite.isSecretStored()).result) return
		const secret = await secrets.get(SECRET_KEY)
		if (!secret) throw new DatabaseLockedError(LOCK.KEY_MISSING)
		await sqlite.setEncryptionSecret(secret)
	} catch (error) {
		if (error instanceof DatabaseLockedError) throw error
		log.error("Could not read the database secret", error)
		throw new DatabaseLockedError(LOCK.KEY_UNREADABLE)
	}
}

/**
 * Open a database, or reuse the connection a reloaded WebView left in the plugin.
 * @returns {Promise<Object>} An open SQLiteDBConnection
 */
async function connect(sqlite, name, encrypted) {
	const consistent = (await sqlite.checkConnectionsConsistency()).result
	const connected = (await sqlite.isConnection(name, READ_ONLY)).result

	const connection =
		consistent && connected
			? await sqlite.retrieveConnection(name, READ_ONLY)
			: await sqlite.createConnection(
					name,
					encrypted,
					encrypted ? "secret" : "no-encryption",
					SCHEMA_VERSION,
					READ_ONLY,
				)

	await connection.open()
	return connection
}

async function plainPath(sqlite) {
	const connection = await connect(sqlite, PLAIN_DATABASE, false)
	const { url } = await connection.getUrl()
	await sqlite.closeConnection(PLAIN_DATABASE, READ_ONLY)
	return url.replace(/^file:\/\//, "")
}

async function queryOne(connection, statement) {
	return (await connection.query(statement)).values[0]
}

/** Fails unless every row and every schema object of the plain file reached the copy. */
async function assertSameData(connection) {
	const { integrity_check: integrity } = await queryOne(connection, "PRAGMA main.integrity_check")
	if (integrity !== "ok") throw new Error(`The copy is damaged: ${integrity}`)

	const lost = await queryOne(
		connection,
		`SELECT COUNT(*) AS count FROM (
			SELECT type, name, sql FROM plain.sqlite_master
			EXCEPT SELECT type, name, sql FROM main.sqlite_master
		)`,
	)
	if (lost.count) throw new Error("The copy lost part of the schema")

	const { values: tables } = await connection.query(
		"SELECT name FROM plain.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
	)
	for (const { name } of tables) {
		const table = `"${name.replaceAll('"', '""')}"`
		const { source, target, missing } = await queryOne(
			connection,
			`SELECT
				(SELECT COUNT(*) FROM plain.${table}) AS source,
				(SELECT COUNT(*) FROM main.${table}) AS target,
				(SELECT COUNT(*) FROM (
					SELECT * FROM plain.${table} EXCEPT SELECT * FROM main.${table}
				)) AS missing`,
		)
		if (source !== target || missing) {
			throw new Error(`The copy of ${name} differs from the original`)
		}
	}
}

async function copyPlainInto(connection, path) {
	// The plugin leaves this on normal, and the original goes away on the strength of this
	await connection.execute("PRAGMA synchronous = FULL", false)
	await connection.execute(`ATTACH DATABASE '${path.replaceAll("'", "''")}' AS plain KEY ''`, false)
	await connection.query("SELECT sqlcipher_export('main', 'plain')")
	await assertSameData(connection)
	await connection.execute("DETACH DATABASE plain", false)
}

/** Remove a partial copy. Without this, a later start could take it for the real thing. */
async function discardCopy(sqlite, connection) {
	try {
		await connection.delete()
		await sqlite.closeConnection(DATABASE, READ_ONLY)
	} catch (error) {
		log.error("Could not remove a partial copy of the database", error)
		throw new DatabaseLockedError(LOCK.OPEN_FAILED)
	}
}

async function encryptPlain(sqlite) {
	const path = await plainPath(sqlite)
	const connection = await connect(sqlite, DATABASE, true)
	try {
		await copyPlainInto(connection, path)
		await connection.execute(`CREATE TABLE ${COPY_DONE_TABLE} (done INTEGER)`)
	} catch (error) {
		await discardCopy(sqlite, connection)
		throw error
	}
	return connection
}

/** Best effort: once the copy is whole, the next start removes what is left of this one. */
async function removePlain(sqlite) {
	try {
		const connection = await sqlite.createConnection(
			PLAIN_DATABASE,
			false,
			"no-encryption",
			SCHEMA_VERSION,
			READ_ONLY,
		)
		await connection.delete()
		await sqlite.closeConnection(PLAIN_DATABASE, READ_ONLY)
	} catch (error) {
		log.error("Could not remove the plain database", error)
	}
}

async function stayOnPlain(sqlite) {
	try {
		return { connection: await connect(sqlite, PLAIN_DATABASE, false), encrypted: false }
	} catch (error) {
		log.error("Could not open the plain database", error)
		throw new DatabaseLockedError(LOCK.OPEN_FAILED)
	}
}

/**
 * A conversion that fails leaves the app on the plain file, as it was before, and the next
 * start tries again: no sale is at risk and a shop should not lose its till to a full disk.
 */
async function convertPlain(sqlite, secrets) {
	let connection
	try {
		await prepareSecret(sqlite, secrets)
		connection = await encryptPlain(sqlite)
	} catch (error) {
		if (error instanceof DatabaseLockedError) throw error
		log.error("The database stays plain until the next start", error)
		return stayOnPlain(sqlite)
	}
	await removePlain(sqlite)
	return { connection, encrypted: true }
}

async function openExisting(sqlite, secrets) {
	await restoreSecret(sqlite, secrets)
	try {
		return await connect(sqlite, DATABASE, true)
	} catch (error) {
		log.error("Could not open the encrypted database", error)
		throw new DatabaseLockedError(LOCK.KEY_REJECTED)
	}
}

async function isCopyDone(connection) {
	try {
		const { values } = await connection.query(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${COPY_DONE_TABLE}'`,
		)
		return values.length > 0
	} catch (error) {
		log.error("Could not read the encrypted database", error)
		throw new DatabaseLockedError(LOCK.OPEN_FAILED)
	}
}

async function databaseExists(sqlite, name) {
	try {
		return (await sqlite.isDatabase(name)).result
	} catch (error) {
		// The plugin answers nothing at all when it could not load its secure preferences
		log.error("The database plugin did not load", error)
		throw new DatabaseLockedError(LOCK.NO_SECURE_STORAGE)
	}
}

/**
 * @param {Object} sqlite - A SQLiteConnection
 * @param {import("../secrets").SecretStore} secrets
 * @returns {Promise<{connection: Object, encrypted: boolean}>}
 * @throws {DatabaseLockedError} When data may be there and it cannot be reached
 */
export async function openDatabase(sqlite, secrets) {
	const hasEncrypted = await databaseExists(sqlite, DATABASE)
	const hasPlain = await databaseExists(sqlite, PLAIN_DATABASE)

	if (hasEncrypted) {
		const connection = await openExisting(sqlite, secrets)
		if (!hasPlain) return { connection, encrypted: true }

		if (await isCopyDone(connection)) {
			await removePlain(sqlite)
			return { connection, encrypted: true }
		}
		await discardCopy(sqlite, connection)
	}

	if (hasPlain) return convertPlain(sqlite, secrets)

	try {
		await prepareSecret(sqlite, secrets)
		return { connection: await connect(sqlite, DATABASE, true), encrypted: true }
	} catch (error) {
		log.error("Could not create the encrypted database", error)
		throw new DatabaseLockedError(LOCK.NO_SECURE_STORAGE)
	}
}
