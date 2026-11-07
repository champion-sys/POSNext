/**
 * The encryption of the database file. Nothing here depends on Electron, so it can be
 * tested against the real cipher build in plain Node.
 */

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const DATABASE_KEY = "pos_next_database_key"
const KEY_BYTES = 32
const TEMPORARY_SUFFIX = ".encrypting"
const SIDE_FILES = ["-wal", "-shm", "-journal"]

const PLAIN_HEADER = Buffer.from("SQLite format 3\0", "latin1")
const NOT_A_DATABASE = "SQLITE_NOTADB"

const STATE = { MISSING: "missing", PLAIN: "plain", ENCRYPTED: "encrypted" }

/** Why the app must stop instead of opening. The stop page shows these to quote to support. */
const LOCK = {
	KEY_MISSING: "key-missing",
	KEY_UNREADABLE: "key-unreadable",
	KEY_REJECTED: "key-rejected",
	NO_SECURE_STORAGE: "no-secure-storage",
	OPEN_FAILED: "open-failed",
}

const createKey = () => crypto.randomBytes(KEY_BYTES).toString("hex")

// Named, because a future default of the library must not lock a file written under this
// one. SQLCipher's own format, so that the standard tools can open a file with its key.
function selectCipher(db) {
	db.pragma("cipher='sqlcipher'")
	db.pragma("legacy=4")
}

// The key is random, so x'' skips the stretching that a typed password needs
const rawKey = (key) => Buffer.from(`x'${key}'`)

/** @returns {string} A value of STATE, read from the file's first bytes */
function readState(filePath, files = fs) {
	if (!files.existsSync(filePath)) return STATE.MISSING

	const header = Buffer.alloc(PLAIN_HEADER.length)
	const descriptor = files.openSync(filePath, "r")
	try {
		const read = files.readSync(descriptor, header, 0, header.length, 0)
		if (read === 0) return STATE.MISSING
	} finally {
		files.closeSync(descriptor)
	}
	return header.equals(PLAIN_HEADER) ? STATE.PLAIN : STATE.ENCRYPTED
}

/**
 * Find this device's key, generating it the first time. A new key is only ever made when
 * no encrypted file exists: one would not open that file, and it would replace the entry
 * that a restored secrets file could still fill.
 *
 * @param {string} filePath - The database
 * @param {{get: Function, set: Function}} secrets - The device's secret store
 * @param {() => string} [newKey]
 * @returns {{key: string|null}|{locked: string}} No key means a plain file stays plain for now
 */
function findKey(filePath, secrets, newKey = createKey) {
	const state = readState(filePath)
	const unavailable = (lock) => (state === STATE.PLAIN ? { key: null } : { locked: lock })

	let key
	try {
		key = secrets.get(DATABASE_KEY)
	} catch {
		return unavailable(
			state === STATE.ENCRYPTED ? LOCK.KEY_UNREADABLE : LOCK.NO_SECURE_STORAGE,
		)
	}
	if (key) return { key }
	if (state === STATE.ENCRYPTED) return { locked: LOCK.KEY_MISSING }

	try {
		const created = newKey()
		secrets.set(DATABASE_KEY, created)
		// Nothing may be encrypted with a key that cannot be read back
		if (secrets.get(DATABASE_KEY) !== created) throw new Error("The key did not keep")
		return { key: created }
	} catch {
		return unavailable(LOCK.NO_SECURE_STORAGE)
	}
}

function removeFiles(filePath, files) {
	for (const suffix of ["", ...SIDE_FILES]) {
		files.rmSync(`${filePath}${suffix}`, { force: true })
	}
}

function flush(filePath, files) {
	const descriptor = files.openSync(filePath, "r+")
	try {
		files.fsyncSync(descriptor)
	} finally {
		files.closeSync(descriptor)
	}
}

// Windows cannot open a folder this way, and NTFS journals the rename itself
function flushFolder(folder, files) {
	try {
		const descriptor = files.openSync(folder, "r")
		try {
			files.fsyncSync(descriptor)
		} finally {
			files.closeSync(descriptor)
		}
	} catch {}
}

/** Fails unless every row and every schema object of the plain file reached the copy. */
function assertSameData(copy, plainPath) {
	copy.prepare("ATTACH DATABASE ? AS plain KEY ''").run(plainPath)
	try {
		const [{ integrity_check: integrity }] = copy.pragma("main.integrity_check")
		if (integrity !== "ok") throw new Error(`The copy is damaged: ${integrity}`)

		const lost = copy
			.prepare(
				`SELECT COUNT(*) AS count FROM (
					SELECT type, name, sql FROM plain.sqlite_master
					EXCEPT SELECT type, name, sql FROM main.sqlite_master
				)`,
			)
			.get()
		if (lost.count) throw new Error("The copy lost part of the schema")

		const tables = copy
			.prepare(
				"SELECT name FROM plain.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.pluck()
			.all()
		for (const name of tables) {
			const table = `"${name.replaceAll('"', '""')}"`
			const { source, target, missing } = copy
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM plain.${table}) AS source,
						(SELECT COUNT(*) FROM main.${table}) AS target,
						(SELECT COUNT(*) FROM (
							SELECT * FROM plain.${table} EXCEPT SELECT * FROM main.${table}
						)) AS missing`,
				)
				.get()
			if (source !== target || missing)
				throw new Error(`The copy of ${name} differs from the original`)
		}
	} finally {
		copy.exec("DETACH DATABASE plain")
	}
}

/**
 * Replace a plain database with an encrypted copy. The original stays whole and readable
 * until the rename, which is the one step that switches over, so a failure or a lost
 * power anywhere leaves the file that was there.
 *
 * @param {Function} Database - The cipher build's constructor
 * @param {string} filePath
 * @param {string} key
 * @param {typeof fs} [files]
 */
function encryptFile(Database, filePath, key, files = fs) {
	const temporary = `${filePath}${TEMPORARY_SUFFIX}`

	try {
		const plain = new Database(filePath)
		try {
			// Folds the -wal file in and removes it. Sales still in it would otherwise stay
			// behind, and SQLite would replay that file onto the encrypted one.
			const [{ journal_mode: mode }] = plain.pragma("journal_mode = DELETE")
			if (mode !== "delete") throw new Error("The database is in use")
			plain.prepare("VACUUM INTO ?").run(temporary)
		} finally {
			plain.close()
		}
		if (files.existsSync(`${filePath}-wal`)) throw new Error("The database kept its log")

		const copy = new Database(temporary)
		try {
			selectCipher(copy)
			copy.rekey(rawKey(key))
		} finally {
			copy.close()
		}

		const encrypted = new Database(temporary)
		try {
			selectCipher(encrypted)
			encrypted.key(rawKey(key))
			assertSameData(encrypted, filePath)
		} finally {
			encrypted.close()
		}

		flush(temporary, files)
		files.renameSync(temporary, filePath)
	} catch (error) {
		removeFiles(temporary, files)
		throw error
	}
	flushFolder(path.dirname(filePath), files)
}

/**
 * Open the database, encrypting a plain one first. A conversion that fails leaves the app
 * on the plain file, as it was before, and the next start tries again: no sale is at risk
 * and a shop should not lose its till to a full disk.
 *
 * @param {Function} Database - The cipher build's constructor
 * @param {string} filePath
 * @param {string|null} key
 * @param {typeof fs} [files]
 * @returns {{db: Object, encrypted: boolean}|{locked: string}}
 */
function openDatabase(Database, filePath, key, files = fs) {
	removeFiles(`${filePath}${TEMPORARY_SUFFIX}`, files)

	if (key && readState(filePath, files) === STATE.PLAIN) {
		try {
			encryptFile(Database, filePath, key, files)
		} catch (error) {
			console.error("The database stays plain until the next start:", error.message)
		}
	}

	const encrypted = readState(filePath, files) !== STATE.PLAIN
	const db = new Database(filePath)
	try {
		if (encrypted) {
			selectCipher(db)
			db.key(rawKey(key))
		}
		db.prepare("SELECT COUNT(*) FROM sqlite_master").get()

		// A sale that was committed must survive losing power a moment later
		db.pragma("journal_mode = WAL")
		db.pragma("synchronous = FULL")
		// SQLite does not encrypt its temporary files, and a large sort would write rows there
		db.pragma("temp_store = MEMORY")
		return { db, encrypted }
	} catch (error) {
		db.close()
		if (error.code === NOT_A_DATABASE) return { locked: LOCK.KEY_REJECTED }
		throw error
	}
}

module.exports = {
	DATABASE_KEY,
	LOCK,
	STATE,
	encryptFile,
	findKey,
	openDatabase,
	readState,
}
