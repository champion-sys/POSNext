// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseLockedError, LOCK } from "@/platform/store/databaseLock"
import { openDatabase } from "../encryptedDatabase"
import { createCapacitorExecutor } from "../sqlExecutor"
import { createFakeSecrets, createFakeSqlitePlugin } from "./fakeSqlitePlugin"

const PLAIN = "pos_next"
const ENCRYPTED = "pos_next_secure"
const SECRET_KEY = "pos_next_database_secret"
const COPY_DONE = "encrypted_copy_done"
const SALES = 25

describe("the Android database", () => {
	let folder
	let plugin
	let secrets

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), "pos-android-"))
		plugin = createFakeSqlitePlugin(folder)
		secrets = createFakeSecrets()
	})

	afterEach(() => {
		plugin.restart()
		rmSync(folder, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	const exists = (name) => existsSync(join(folder, `${name}SQLite.db`))
	const open = () => openDatabase(plugin, secrets)

	/** Leaves a plain database of real rows, as the old app did. */
	async function seedPlain() {
		const connection = await plugin.createConnection(PLAIN, false, "no-encryption", 1, false)
		await connection.open()
		await connection.execute("CREATE TABLE outbox (offline_id TEXT PRIMARY KEY, payload TEXT)")
		await connection.execute("CREATE INDEX outbox_payload ON outbox (payload)")
		await connection.execute("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
		for (let sale = 0; sale < SALES; sale++) {
			await connection.run("INSERT INTO outbox VALUES (?, ?)", [`sale-${sale}`, `{"total":${sale}}`])
		}
		await connection.run("INSERT INTO kv VALUES (?, ?)", ["cursor", "42"])
		await plugin.closeConnection(PLAIN)
		plugin.created.length = 0
	}

	async function readSales(connection) {
		const sql = createCapacitorExecutor(connection)
		return (await sql.all("SELECT offline_id FROM outbox ORDER BY offline_id")).map((row) => row.offline_id)
	}

	const allSales = Array.from({ length: SALES }, (_, sale) => `sale-${sale}`).sort()

	/** Lets a test change what each new connection does. */
	function onConnection(change) {
		const create = plugin.createConnection
		plugin.createConnection = async (...args) => {
			const connection = await create(...args)
			change(connection, args[0])
			return connection
		}
	}

	const lockedWith = (reason) =>
		expect.objectContaining({ name: DatabaseLockedError.name, reason })

	describe("on a new device", () => {
		it("creates an encrypted database", async () => {
			const { connection, encrypted } = await open()

			expect(encrypted).toBe(true)
			expect(plugin.created).toEqual([
				{ name: ENCRYPTED, encrypted: true, mode: "secret", version: 1, readonly: false },
			])
			expect(plugin.secretOf(ENCRYPTED)).toBeTruthy()
			await connection.execute("CREATE TABLE t (a)")
		})

		it("generates a long random secret", async () => {
			await open()
			plugin.restart()
			const first = plugin.secret

			const other = createFakeSqlitePlugin(mkdtempSync(join(tmpdir(), "pos-android-")))
			await openDatabase(other, createFakeSecrets())

			expect(first).toMatch(/^[0-9a-f]{64}$/)
			expect(other.secret).not.toBe(first)
		})

		it("keeps the secret once, for good", async () => {
			await open()
			const first = plugin.secret
			plugin.restart()

			const set = vi.spyOn(plugin, "setEncryptionSecret")
			await open()

			expect(plugin.secret).toBe(first)
			expect(set).not.toHaveBeenCalled()
		})

		it("has the secret in committed storage before the plugin can write it late", async () => {
			const order = []
			const setInStorage = secrets.set
			secrets.set = async (...args) => {
				order.push("storage")
				return setInStorage(...args)
			}
			const setInPlugin = plugin.setEncryptionSecret
			plugin.setEncryptionSecret = async (...args) => {
				order.push("plugin")
				return setInPlugin(...args)
			}

			await open()

			expect(order).toEqual(["storage", "plugin"])
			expect(secrets.entries.get(SECRET_KEY)).toBe(plugin.secret)
		})

		it("stops when the secret did not reach storage, which that plugin does not report", async () => {
			secrets.set = async () => {}

			await expect(open()).rejects.toEqual(lockedWith(LOCK.NO_SECURE_STORAGE))
			expect(plugin.secret).toBeNull()
			expect(exists(ENCRYPTED)).toBe(false)
		})

		it("never falls back to a plain database", async () => {
			secrets.set = async () => {
				throw new Error("Keystore refused")
			}

			await expect(open()).rejects.toEqual(lockedWith(LOCK.NO_SECURE_STORAGE))
			expect(exists(PLAIN)).toBe(false)
		})

		it("reuses a secret saved by a start that died before it reached the plugin", async () => {
			secrets.entries.set(SECRET_KEY, "saved-secret")

			await open()

			expect(plugin.secret).toBe("saved-secret")
		})
	})

	describe("on a device with an old plain database", () => {
		beforeEach(seedPlain)

		it("moves every row into the encrypted file and removes the plain one", async () => {
			const { connection, encrypted } = await open()

			expect(encrypted).toBe(true)
			expect(await readSales(connection)).toEqual(allSales)
			expect(plugin.secretOf(ENCRYPTED)).toBe(plugin.secret)
			expect(exists(PLAIN)).toBe(false)
		})

		it("keeps the data after a restart", async () => {
			await open()
			plugin.restart()

			const { connection } = await open()

			expect(await readSales(connection)).toEqual(allSales)
		})

		it("never uses the plugin's encryption mode, which deletes before it renames", async () => {
			await open()

			expect(plugin.created.map(({ mode }) => mode)).not.toContain("encryption")
		})

		it("keeps what it copied, schema included", async () => {
			const { connection } = await open()

			const { values } = await connection.query("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")

			expect(values).toEqual([{ name: "outbox_payload" }])
		})

		it("writes no commit mark when the last step before it fails", async () => {
			plugin.failOn = /^DETACH/

			await open()

			expect(exists(ENCRYPTED)).toBe(false)
			expect(exists(PLAIN)).toBe(true)
		})

		it.each([
			["the copy", /sqlcipher_export/],
			["attaching the original", /^ATTACH/],
			["the comparison", /EXCEPT/],
			["the commit mark", new RegExp(COPY_DONE)],
		])("stays on the original when %s fails", async (_, step) => {
			plugin.failOn = step

			const { connection, encrypted } = await open()

			expect(encrypted).toBe(false)
			expect(await readSales(connection)).toEqual(allSales)
			expect(exists(ENCRYPTED)).toBe(false)
		})

		it("will not take a copy that lost a row", async () => {
			plugin.dropRowsOnExport = true

			const { connection, encrypted } = await open()

			expect(encrypted).toBe(false)
			expect(await readSales(connection)).toEqual(allSales)
			expect(exists(ENCRYPTED)).toBe(false)
		})

		it("will not take a copy that lost part of the schema", async () => {
			onConnection((connection) => {
				const query = connection.query
				connection.query = async (statement, values) => {
					const answer = await query(statement, values)
					if (statement.includes("sqlcipher_export")) {
						await connection.execute("DROP INDEX main.outbox_payload", false)
					}
					return answer
				}
			})

			const { encrypted } = await open()

			expect(encrypted).toBe(false)
			expect(exists(PLAIN)).toBe(true)
		})

		it("tries again on the next start, without a sale made in between going missing", async () => {
			plugin.failOn = /sqlcipher_export/
			const { connection } = await open()
			await connection.run("INSERT INTO outbox VALUES (?, ?)", ["sale-late", "{}"])
			plugin.restart()

			const second = await open()

			expect(second.encrypted).toBe(true)
			expect(await readSales(second.connection)).toEqual([...allSales, "sale-late"].sort())
			expect(exists(PLAIN)).toBe(false)
		})

		it("stays on the original when no secret can be kept", async () => {
			secrets.set = async () => {
				throw new Error("Keystore refused")
			}

			const { connection, encrypted } = await open()

			expect(encrypted).toBe(false)
			expect(await readSales(connection)).toEqual(allSales)
		})

		it.each([
			["attaching the original", /^ATTACH/],
			["the copy", /sqlcipher_export/],
			["the comparison", /EXCEPT/],
			["detaching", /^DETACH/],
			["the commit mark", new RegExp(COPY_DONE)],
			["closing the original", new RegExp(`closeConnection ${PLAIN}`)],
			["removing the original", new RegExp(`delete ${PLAIN}`)],
		])("loses nothing when the app is killed at %s", async (_, step) => {
			plugin.killOn = step
			await open().catch(() => {})
			plugin.restart()

			const { connection, encrypted } = await open()

			expect(encrypted).toBe(true)
			expect(await readSales(connection)).toEqual(allSales)
			expect(exists(PLAIN)).toBe(false)
		})

		it("removes the original on the next start when only that step was missed", async () => {
			plugin.killOn = new RegExp(`delete ${PLAIN}`)
			await open().catch(() => {})
			plugin.restart()
			const exported = vi.fn()
			onConnection((connection) => {
				const query = connection.query
				connection.query = (statement, values) => {
					if (statement.includes("sqlcipher_export")) exported()
					return query(statement, values)
				}
			})

			await open()

			expect(exists(PLAIN)).toBe(false)
			expect(exported).not.toHaveBeenCalled()
		})

		it("does not go on with the plain file once the encrypted one may be the real one", async () => {
			plugin.failOn = new RegExp(COPY_DONE)
			onConnection((connection, name) => {
				if (name !== ENCRYPTED) return
				connection.delete = async () => {
					throw new Error("Failed in deleteDB")
				}
			})

			await expect(open()).rejects.toEqual(lockedWith(LOCK.OPEN_FAILED))
			expect(exists(PLAIN)).toBe(true)
		})
	})

	describe("when the secret is gone", () => {
		async function encryptedDevice() {
			await open()
			plugin.restart()
		}

		const fileBefore = () => plugin.secretOf(ENCRYPTED)

		it("restores the plugin's secret when only that copy was lost", async () => {
			await encryptedDevice()
			plugin.secret = null

			const { encrypted } = await open()

			expect(encrypted).toBe(true)
		})

		it("stops, and makes no new secret, when both copies are gone", async () => {
			await encryptedDevice()
			const before = fileBefore()
			plugin.secret = null
			secrets.entries.clear()

			await expect(open()).rejects.toEqual(lockedWith(LOCK.KEY_MISSING))
			expect(plugin.secret).toBeNull()
			expect(secrets.entries.size).toBe(0)
			expect(exists(ENCRYPTED)).toBe(true)
			expect(fileBefore()).toBe(before)
		})

		it("stops on a Keystore failure", async () => {
			await encryptedDevice()
			plugin.secret = null
			secrets.get = async () => {
				throw new Error("Keystore was tampered with")
			}

			await expect(open()).rejects.toEqual(lockedWith(LOCK.KEY_UNREADABLE))
			expect(exists(ENCRYPTED)).toBe(true)
		})

		it("stops when the secret does not open the file", async () => {
			await encryptedDevice()
			plugin.secret = "not-the-secret"

			await expect(open()).rejects.toEqual(lockedWith(LOCK.KEY_REJECTED))
			expect(exists(ENCRYPTED)).toBe(true)
		})

		it("stops, and does not read as a new device, when the plugin could not load", async () => {
			await encryptedDevice()
			plugin.secretLoaded = false

			await expect(open()).rejects.toEqual(lockedWith(LOCK.NO_SECURE_STORAGE))
			expect(exists(ENCRYPTED)).toBe(true)
		})

		it("makes no secret when it cannot tell whether a database is there", async () => {
			plugin.isDatabase = async () => {
				throw new Error("The plugin is not answering")
			}

			await expect(open()).rejects.toEqual(lockedWith(LOCK.NO_SECURE_STORAGE))
			expect(plugin.secret).toBeNull()
			expect(secrets.entries.size).toBe(0)
		})

		it("does not fall back to a plain file left next to it", async () => {
			await seedPlain()
			plugin.killOn = new RegExp(`delete ${PLAIN}`)
			await open().catch(() => {})
			plugin.restart()
			plugin.secret = null
			secrets.entries.clear()

			await expect(open()).rejects.toEqual(lockedWith(LOCK.KEY_MISSING))
			expect(exists(PLAIN)).toBe(true)
		})

		it("opens the moment the secret is back", async () => {
			await encryptedDevice()
			const secret = plugin.secret
			const saved = secrets.entries.get(SECRET_KEY)
			plugin.secret = null
			secrets.entries.clear()
			await expect(open()).rejects.toEqual(lockedWith(LOCK.KEY_MISSING))
			plugin.restart()

			secrets.entries.set(SECRET_KEY, saved)
			const { encrypted } = await open()

			expect(encrypted).toBe(true)
			expect(plugin.secret).toBe(secret)
		})
	})

	describe("connecting", () => {
		it("reuses the connection a reloaded WebView left open", async () => {
			const { connection } = await open()

			const again = await open()

			expect(again.connection).toBe(connection)
			expect(plugin.created).toHaveLength(1)
		})

		it("starts over when the plugin and the page disagree", async () => {
			await open()
			plugin.restart()

			await open()

			expect(plugin.created).toHaveLength(2)
		})
	})
})
