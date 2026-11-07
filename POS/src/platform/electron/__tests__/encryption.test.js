// @vitest-environment node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { createNodeExecutor } from "@/platform/store/__tests__/sqliteHarness"

const DESKTOP = resolve(__dirname, "../../../../desktop")
const ENCRYPTION = join(DESKTOP, "electron/db/encryption.js")
const desktopRequire = createRequire(ENCRYPTION)

const { DATABASE_KEY, LOCK, STATE, findKey, openDatabase, readState } = desktopRequire(ENCRYPTION)

/**
 * The real cipher build, which comes from `npm install` in POS/desktop. Without it these
 * tests are skipped on a developer's machine, and CI installs it so that they cannot be.
 */
function loadEngine() {
	try {
		return desktopRequire("better-sqlite3-multiple-ciphers")
	} catch (error) {
		if (process.env.CI) throw error
		return null
	}
}

const Database = loadEngine()
const KEY = "ab".repeat(32)
const OTHER_KEY = "cd".repeat(32)
const MARK = "CUSTOMER-MARK"
const SALES = 500

function fakeSecrets(entries = {}) {
	return {
		entries,
		get: vi.fn((key) => entries[key] ?? null),
		set: vi.fn((key, value) => {
			entries[key] = value
		}),
	}
}

describe("the database file", () => {
	let folder
	let file

	beforeEach(() => {
		folder = fs.mkdtempSync(join(tmpdir(), "pos-encryption-"))
		file = join(folder, "pos-next.sqlite")
	})

	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	const contains = (path, text) => fs.readFileSync(path).includes(text)
	const hasPlainHeader = (path) => contains(path, "SQLite format 3")
	const leftovers = () => fs.readdirSync(folder).filter((name) => name !== "pos-next.sqlite")

	describe("finding the key", () => {
		const newKey = () => KEY

		it("generates one for a device that has no database yet", () => {
			const secrets = fakeSecrets()

			expect(findKey(file, secrets, newKey)).toEqual({ key: KEY })
			expect(secrets.entries[DATABASE_KEY]).toBe(KEY)
		})

		it("makes a key of 256 random bits by default", () => {
			const { key } = findKey(file, fakeSecrets())
			const { key: other } = findKey(file, fakeSecrets())

			expect(key).toMatch(/^[0-9a-f]{64}$/)
			expect(other).not.toBe(key)
		})

		it("generates a key only once", () => {
			const secrets = fakeSecrets({ [DATABASE_KEY]: KEY })

			expect(findKey(file, secrets, () => OTHER_KEY)).toEqual({ key: KEY })
			expect(secrets.set).not.toHaveBeenCalled()
		})

		it("generates one for an old plain database", () => {
			fs.writeFileSync(file, "SQLite format 3\0 and the rest of the file")

			expect(findKey(file, fakeSecrets(), newKey)).toEqual({ key: KEY })
		})

		it("treats an empty file as no database", () => {
			fs.writeFileSync(file, "")

			expect(readState(file)).toBe(STATE.MISSING)
		})

		it("will not use a key that it cannot read back", () => {
			const secrets = fakeSecrets()
			secrets.get = () => null

			expect(findKey(file, secrets, newKey)).toEqual({ locked: LOCK.NO_SECURE_STORAGE })
		})

		it("stops on a new device with no secure storage, rather than go unencrypted", () => {
			const secrets = fakeSecrets()
			secrets.set = () => {
				throw new Error("This system cannot store secrets safely")
			}

			expect(findKey(file, secrets, newKey)).toEqual({ locked: LOCK.NO_SECURE_STORAGE })
		})

		it("keeps an old plain database working when no key can be stored", () => {
			fs.writeFileSync(file, "SQLite format 3\0 and the rest of the file")
			const secrets = fakeSecrets()
			secrets.set = () => {
				throw new Error("This system cannot store secrets safely")
			}

			expect(findKey(file, secrets, newKey)).toEqual({ key: null })
		})

		describe("for an encrypted file", () => {
			beforeEach(() => fs.writeFileSync(file, Buffer.alloc(4096, 0x5a)))

			it("stops when the key is gone, and makes no new one", () => {
				const secrets = fakeSecrets()

				expect(findKey(file, secrets, newKey)).toEqual({ locked: LOCK.KEY_MISSING })
				expect(secrets.set).not.toHaveBeenCalled()
			})

			it("stops when the operating system will not decrypt the key", () => {
				const secrets = fakeSecrets({ [DATABASE_KEY]: KEY })
				secrets.get = () => {
					throw new Error("Error while decrypting the ciphertext")
				}

				expect(findKey(file, secrets, newKey)).toEqual({ locked: LOCK.KEY_UNREADABLE })
			})

			it("leaves the file as it was", () => {
				const before = fs.readFileSync(file)

				findKey(file, fakeSecrets(), newKey)

				expect(fs.readFileSync(file).equals(before)).toBe(true)
			})
		})
	})

	describe.skipIf(!Database)("on the real cipher build", () => {
		/** A plain database with the app's schema and real rows, as the old app left it. */
		async function seedPlain(path = file) {
			const db = new Database(path)
			db.pragma("journal_mode = WAL")
			db.pragma("synchronous = FULL")
			await migrate(createNodeExecutor(db))
			db.exec("BEGIN")
			const insert = db.prepare(
				`INSERT INTO outbox (offline_id, seq, entity, entity_version, payload, state, created_at)
				VALUES (?, ?, 'invoice', 1, ?, 'pending', 1)`,
			)
			for (let sale = 0; sale < SALES; sale++) {
				insert.run(`sale-${sale}`, sale + 1, `{"customer":"${MARK}-${sale}"}`)
			}
			db.exec("COMMIT")
			db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("cursor", "42")
			return db
		}

		const closeAndOpen = (key = KEY) => openDatabase(Database, file, key)

		function countSales(db) {
			return db.prepare("SELECT COUNT(*) FROM outbox").pluck().get()
		}

		function readEncrypted(path = file, key = KEY) {
			const db = new Database(path)
			db.pragma("cipher='sqlcipher'")
			db.pragma("legacy=4")
			db.key(Buffer.from(`x'${key}'`))
			return db
		}

		const allFiles = () => fs.readdirSync(folder).map((name) => join(folder, name))

		describe("with no database yet", () => {
			it("creates an encrypted file", () => {
				const { db, encrypted } = closeAndOpen()
				db.exec(`CREATE TABLE t (a); INSERT INTO t VALUES ('${MARK}')`)
				db.close()

				expect(encrypted).toBe(true)
				expect(readState(file)).toBe(STATE.ENCRYPTED)
				expect(contains(file, MARK)).toBe(false)
			})

			it("keeps its promises on durability", () => {
				const { db } = closeAndOpen()

				expect(db.pragma("journal_mode", { simple: true })).toBe("wal")
				expect(db.pragma("synchronous", { simple: true })).toBe(2)
				db.close()
			})

			it("never lets SQLite spill rows into a plain temporary file", () => {
				const { db } = closeAndOpen()

				expect(db.pragma("temp_store", { simple: true })).toBe(2)
				db.close()
			})

			it("reads its data after a restart", () => {
				const first = closeAndOpen()
				first.db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)")
				first.db.close()

				const second = closeAndOpen()

				expect(second.db.prepare("SELECT a FROM t").pluck().get()).toBe(1)
				second.db.close()
			})

			it("writes SQLCipher's format, not the library's default", () => {
				const { db } = closeAndOpen()
				db.exec("CREATE TABLE t (a)")
				db.close()

				const standard = readEncrypted()
				expect(standard.prepare("SELECT COUNT(*) FROM t").pluck().get()).toBe(0)
				standard.close()

				const defaults = new Database(file)
				defaults.key(Buffer.from(`x'${KEY}'`))
				expect(() => defaults.prepare("SELECT COUNT(*) FROM t").get()).toThrow("not a database")
				defaults.close()
			})

			it("encrypts its log too", () => {
				const { db } = closeAndOpen()
				db.exec("CREATE TABLE t (a)")
				db.prepare("INSERT INTO t VALUES (?)").run(MARK)

				const onDisk = allFiles()
				expect(onDisk.some((path) => path.endsWith("-wal"))).toBe(true)
				expect(onDisk.filter((path) => contains(path, MARK))).toEqual([])
				db.close()
			})
		})

		describe("with an old plain database", () => {
			it("keeps every row, in a file that is no longer readable", async () => {
				const plain = await seedPlain()
				plain.close()
				expect(contains(file, MARK)).toBe(true)

				const { db, encrypted } = closeAndOpen()

				expect(encrypted).toBe(true)
				expect(countSales(db)).toBe(SALES)
				expect(db.prepare("SELECT payload FROM outbox WHERE seq = 77").pluck().get()).toContain(`${MARK}-76`)
				expect(db.prepare("SELECT value FROM kv WHERE key = 'cursor'").pluck().get()).toBe("42")
				db.close()

				expect(allFiles().filter(hasPlainHeader)).toEqual([])
				expect(allFiles().filter((path) => contains(path, MARK))).toEqual([])
			})

			it("keeps the indexes and the record of migrations", async () => {
				const plain = await seedPlain()
				const before = plain.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all()
				const migrated = plain.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()
				plain.close()

				const { db } = closeAndOpen()

				expect(db.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all()).toEqual(before)
				expect(db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(migrated)
				db.close()
			})

			it("keeps a sale that only ever reached the log", async () => {
				const source = join(folder, "running.sqlite")
				const running = await seedPlain(source)
				running.pragma("wal_autocheckpoint = 0")
				running.pragma("wal_checkpoint(TRUNCATE)")
				running.prepare("UPDATE kv SET value = ? WHERE key = 'cursor'").run("in the log")
				expect(fs.statSync(`${source}-wal`).size).toBeGreaterThan(0)

				// What a power cut leaves behind: the main file without that sale, and the log
				fs.copyFileSync(source, file)
				fs.copyFileSync(`${source}-wal`, `${file}-wal`)
				running.close()
				fs.rmSync(source)

				const { db, encrypted } = closeAndOpen()

				expect(encrypted).toBe(true)
				expect(db.prepare("SELECT value FROM kv WHERE key = 'cursor'").pluck().get()).toBe("in the log")
				db.close()
				expect(fs.existsSync(`${file}-wal`) && contains(`${file}-wal`, "in the log")).toBe(false)
			})

			it("still reads after a restart", async () => {
				;(await seedPlain()).close()
				closeAndOpen().db.close()

				const { db } = closeAndOpen()

				expect(countSales(db)).toBe(SALES)
				db.close()
			})

			it("leaves no temporary file", async () => {
				;(await seedPlain()).close()

				const { db } = closeAndOpen()
				db.close()

				expect(leftovers()).toEqual([])
			})

			it("will not touch a file another process still has open", async () => {
				const other = await seedPlain()

				const blocked = class extends Database {
					constructor(...args) {
						super(...args)
						this.pragma("busy_timeout = 0")
					}
				}
				vi.spyOn(console, "error").mockImplementation(() => {})

				const { db, encrypted } = openDatabase(blocked, file, KEY)

				expect(encrypted).toBe(false)
				expect(countSales(db)).toBe(SALES)
				db.close()
				other.close()
			})
		})

		describe("when the conversion fails part way", () => {
			beforeEach(() => {
				vi.spyOn(console, "error").mockImplementation(() => {})
			})

			/** Fails or loses data at one step, then proves the original is whole and in use. */
			async function expectOriginalKept(run) {
				;(await seedPlain()).close()
				const before = readSalesOfPlain()

				const { db, encrypted } = run()

				expect(encrypted).toBe(false)
				expect(db.prepare("SELECT offline_id FROM outbox ORDER BY seq").pluck().all()).toEqual(before)
				db.close()
				expect(readState(file)).toBe(STATE.PLAIN)
				expect(leftovers()).toEqual([])
			}

			function readSalesOfPlain() {
				const plain = new Database(file)
				const rows = plain.prepare("SELECT offline_id FROM outbox ORDER BY seq").pluck().all()
				plain.close()
				return rows
			}

			it("stays on the original when the file cannot be switched", async () => {
				const files = {
					...fs,
					renameSync: () => {
						throw new Error("EPERM: the antivirus has it")
					},
				}

				await expectOriginalKept(() => openDatabase(Database, file, KEY, files))
			})

			it("stays on the original when the copy cannot be flushed", async () => {
				const files = {
					...fs,
					fsyncSync: () => {
						throw new Error("ENOSPC: no space left on device")
					},
				}

				await expectOriginalKept(() => openDatabase(Database, file, KEY, files))
			})

			it("stays on the original when encrypting fails", async () => {
				class Failing extends Database {
					rekey() {
						return 1
					}
				}

				await expectOriginalKept(() => openDatabase(Failing, file, KEY))
			})

			it("will not take a copy that lost a row", async () => {
				class Lossy extends Database {
					rekey(...args) {
						const code = super.rekey(...args)
						this.exec("DELETE FROM outbox WHERE seq = 5")
						return code
					}
				}

				await expectOriginalKept(() => openDatabase(Lossy, file, KEY))
			})

			it("will not take a copy with a changed row", async () => {
				class Changed extends Database {
					rekey(...args) {
						const code = super.rekey(...args)
						this.exec("UPDATE outbox SET payload = '{}' WHERE seq = 5")
						return code
					}
				}

				await expectOriginalKept(() => openDatabase(Changed, file, KEY))
			})

			it("will not take a copy that lost part of the schema", async () => {
				class Stripped extends Database {
					rekey(...args) {
						const code = super.rekey(...args)
						const index = this.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
						)
							.pluck()
							.get()
						this.exec(`DROP INDEX ${index}`)
						return code
					}
				}

				await expectOriginalKept(() => openDatabase(Stripped, file, KEY))
			})

			it("converts on the next start", async () => {
				;(await seedPlain()).close()
				const broken = { ...fs, renameSync: () => { throw new Error("EBUSY") } }
				openDatabase(Database, file, KEY, broken).db.close()

				const { db, encrypted } = closeAndOpen()

				expect(encrypted).toBe(true)
				expect(countSales(db)).toBe(SALES)
				db.close()
			})

			it("keeps a sale taken on the original before that next start", async () => {
				;(await seedPlain()).close()
				const broken = { ...fs, renameSync: () => { throw new Error("EBUSY") } }
				const first = openDatabase(Database, file, KEY, broken)
				first.db.prepare("UPDATE kv SET value = 'sold while plain' WHERE key = 'cursor'").run()
				first.db.close()

				const { db } = closeAndOpen()

				expect(db.prepare("SELECT value FROM kv WHERE key = 'cursor'").pluck().get()).toBe("sold while plain")
				db.close()
			})

			it("never logs the key", async () => {
				const logged = vi.spyOn(console, "error")
				const broken = { ...fs, renameSync: () => { throw new Error("EBUSY") } }

				await expectOriginalKept(() => openDatabase(Database, file, KEY, broken))

				expect(logged).toHaveBeenCalled()
				expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY)
			})
		})

		describe("when the process is killed part way", () => {
			const KILL = `process.kill(process.pid, "SIGKILL")`

			/** A real process with a real SIGKILL, at a step of the file system. */
			function killAt(step) {
				const script = `
					const fs = require("node:fs")
					const Database = require(${JSON.stringify(desktopRequire.resolve("better-sqlite3-multiple-ciphers"))})
					const { encryptFile } = require(${JSON.stringify(ENCRYPTION)})
					const files = { ...fs, ${step} }
					encryptFile(Database, ${JSON.stringify(file)}, ${JSON.stringify(KEY)}, files)
				`
				const { signal } = spawnSync(process.execPath, ["-e", script])
				expect(signal).toBe("SIGKILL")
			}

			it.each(["fsyncSync", "renameSync"])("loses nothing when killed at %s", async (step) => {
				;(await seedPlain()).close()

				killAt(`${step}: () => ${KILL}`)

				expect(readState(file)).toBe(STATE.PLAIN)
				expect(fs.existsSync(`${file}.encrypting`)).toBe(true)
				const plain = new Database(file)
				expect(countSales(plain)).toBe(SALES)
				plain.close()

				const { db, encrypted } = closeAndOpen()
				expect(encrypted).toBe(true)
				expect(countSales(db)).toBe(SALES)
				db.close()
				expect(leftovers().filter((name) => name.endsWith(".encrypting"))).toEqual([])
			})

			it("leaves a whole encrypted file when killed right after the switch", async () => {
				;(await seedPlain()).close()

				killAt(`renameSync: (from, to) => { fs.renameSync(from, to); ${KILL} }`)

				expect(readState(file)).toBe(STATE.ENCRYPTED)
				const { db, encrypted } = closeAndOpen()
				expect(encrypted).toBe(true)
				expect(countSales(db)).toBe(SALES)
				db.close()
			})
		})

		describe("when the key will not open the file", () => {
			beforeEach(async () => {
				const { db } = closeAndOpen()
				db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)")
				db.close()
			})

			it("stops, and changes nothing on disk", () => {
				const before = fs.readFileSync(file)

				expect(openDatabase(Database, file, OTHER_KEY)).toEqual({ locked: LOCK.KEY_REJECTED })
				expect(fs.readFileSync(file).equals(before)).toBe(true)
				expect(leftovers()).toEqual([])
			})

			it("opens again with the right key", () => {
				openDatabase(Database, file, OTHER_KEY)

				const { db } = closeAndOpen()

				expect(db.prepare("SELECT a FROM t").pluck().get()).toBe(1)
				db.close()
			})

			it("does not start empty on a file that is not SQLite at all", () => {
				fs.writeFileSync(file, Buffer.alloc(8192, 0x41))

				expect(openDatabase(Database, file, KEY)).toEqual({ locked: LOCK.KEY_REJECTED })
				expect(fs.statSync(file).size).toBe(8192)
			})
		})

		describe("the window", () => {
			it("cannot rekey the file, reach its key or attach a copy", () => {
				const { createHandler } = desktopRequire("./handler.js")
				const { db } = closeAndOpen()
				db.exec("CREATE TABLE t (a)")
				const handler = createHandler(db)

				expect(() => handler.run(`PRAGMA rekey = '${OTHER_KEY}'`)).toThrow("not allowed")
				expect(() => handler.all("PRAGMA key")).toThrow("not allowed")
				expect(() => handler.run("ATTACH DATABASE 'x' AS y KEY ''")).toThrow("not allowed")
				expect(handler.all("SELECT sqlite3mc_codec_data('raw_key') AS key")).toEqual([{ key: null }])
				db.close()
			})
		})
	})

	it("keeps what the desktop app installs in step with what it requires", () => {
		const manifest = JSON.parse(fs.readFileSync(join(DESKTOP, "package.json"), "utf8"))

		// 13 needs a newer Node than Electron 33 has, and crashes it outright
		expect(manifest.dependencies["better-sqlite3-multiple-ciphers"]).toBe("12.11.1")
		expect(manifest.dependencies["better-sqlite3"]).toBeUndefined()
	})
})
