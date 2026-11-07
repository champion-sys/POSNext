// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElectronExecutor, openExecutor } from "../sqlExecutor"

const require = createRequire(import.meta.url)
const { DatabaseSync } = require("node:sqlite")
const { createHandler, isAppPage } = require("../../../../desktop/electron/db/handler.js")

describe("the renderer's executor", () => {
	it("defaults params, so a statement without any crosses cleanly", async () => {
		const database = { all: vi.fn(async () => []), run: vi.fn(async () => {}), batch: vi.fn(async () => {}) }
		const sql = createElectronExecutor(database)

		await sql.all("SELECT 1")
		await sql.run("DELETE FROM kv")

		expect(database.all).toHaveBeenCalledWith("SELECT 1", [])
		expect(database.run).toHaveBeenCalledWith("DELETE FROM kv", [])
	})

	describe("opening", () => {
		const database = (state) => ({ open: vi.fn(async () => state), all: vi.fn(async () => []) })

		afterEach(() => vi.unstubAllGlobals())

		it("uses what the preload exposes", async () => {
			const db = database({ encrypted: true })
			vi.stubGlobal("window", { electronAPI: { db } })

			const sql = await openExecutor()
			await sql.all("SELECT 1")

			expect(db.all).toHaveBeenCalled()
		})

		it("says whether the file is encrypted", async () => {
			vi.stubGlobal("window", { electronAPI: { db: database({ encrypted: false }) } })

			expect((await openExecutor()).encrypted).toBe(false)
		})

		it("fails with the reason when the database is locked", async () => {
			vi.stubGlobal("window", { electronAPI: { db: database({ locked: "key-missing" }) } })

			await expect(openExecutor()).rejects.toMatchObject({
				name: "DatabaseLockedError",
				reason: "key-missing",
			})
		})
	})
})

describe("the database process", () => {
	let db
	let handler

	beforeEach(() => {
		db = new DatabaseSync(":memory:")
		handler = createHandler(db)
		handler.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
	})

	it("reads and writes", () => {
		handler.run("INSERT INTO t (id, name) VALUES (?, ?)", [1, "a"])
		expect(handler.all("SELECT name FROM t WHERE id = ?", [1])).toEqual([{ name: "a" }])
	})

	it("commits a batch as one", () => {
		handler.batch([
			{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "a"] },
			{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [2, "b"] },
		])
		expect(handler.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 2 }])
	})

	describe("on a full disk", () => {
		function fullDatabase() {
			const folder = mkdtempSync(join(tmpdir(), "pos-full-"))
			const file = new DatabaseSync(join(folder, "full.sqlite"))
			file.exec("PRAGMA journal_mode = WAL")
			const full = createHandler(file)
			full.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
			full.run("INSERT INTO t (id, name) VALUES (1, 'kept')")
			const [{ page_count: pages }] = full.all("SELECT page_count FROM pragma_page_count")
			file.exec(`PRAGMA max_page_count = ${pages + 1}`)
			return { full, cleanUp: () => (file.close(), rmSync(folder, { recursive: true })) }
		}

		const tooMuch = [{ sql: "INSERT INTO t (id, name) VALUES (2, ?)", params: ["x".repeat(50000)] }]

		it("says so, so the cashier is told what to do", () => {
			const { full, cleanUp } = fullDatabase()

			expect(() => full.batch(tooMuch)).toThrow(/disk is full/)

			cleanUp()
		})

		it("keeps what was there and takes the next write", () => {
			const { full, cleanUp } = fullDatabase()

			expect(() => full.batch(tooMuch)).toThrow()
			full.batch([{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [3, "small"] }])

			expect(full.all("SELECT name FROM t ORDER BY id")).toEqual([{ name: "kept" }, { name: "small" }])
			cleanUp()
		})
	})

	it("rolls a batch back when any statement fails", () => {
		expect(() =>
			handler.batch([
				{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "a"] },
				{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "duplicate"] },
			]),
		).toThrow()

		expect(handler.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 0 }])
	})

	it.each([
		["attaching another file", "ATTACH DATABASE '/tmp/other.db' AS other"],
		["copying the database out", "VACUUM INTO '/tmp/copy.db'"],
		["changing durability", "PRAGMA synchronous = OFF"],
		["an empty statement", ""],
		["something that is not text", 42],
	])("refuses %s", (_name, statement) => {
		expect(() => handler.run(statement)).toThrow("not allowed")
		expect(() => handler.all(statement)).toThrow("not allowed")
		expect(() => handler.batch([{ sql: statement }])).toThrow("not allowed")
	})

	it("checks a whole batch before running any of it", () => {
		expect(() =>
			handler.batch([{ sql: "INSERT INTO t (id) VALUES (1)" }, { sql: "ATTACH DATABASE 'x' AS y" }]),
		).toThrow("not allowed")

		expect(handler.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 0 }])
	})

	it("keeps reads and writes apart, as better-sqlite3 does", () => {
		expect(() => handler.all("DELETE FROM t")).toThrow("only reads")
		expect(() => handler.run("SELECT 1")).toThrow("only writes")
	})
})

describe("who may call it", () => {
	it.each([
		["the app's page", "app://pos/", true],
		["a route in the app", "app://pos/pos/sale?x=1", true],
		["a remote page", "https://example.com/", false],
		["a look-alike host", "app://pos.evil/", false],
		["another scheme", "file:///pos/", false],
	])("%s", (_name, url, allowed) => {
		expect(isAppPage(url)).toBe(allowed)
	})
})
