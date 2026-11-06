// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeConnection } from "@/platform/store/__tests__/sqliteHarness"
import { connect, createCapacitorExecutor } from "../sqlExecutor"

describe("the Android executor", () => {
	let connection
	let sql

	beforeEach(async () => {
		connection = createFakeConnection()
		sql = createCapacitorExecutor(connection)
		await sql.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
	})

	it("reads rows", async () => {
		await sql.run("INSERT INTO t (id, name) VALUES (?, ?)", [1, "a"])
		expect(await sql.all("SELECT name FROM t WHERE id = ?", [1])).toEqual([{ name: "a" }])
	})

	it("answers with no rows when the plugin leaves values out", async () => {
		const empty = createCapacitorExecutor({ query: async () => ({}) })
		expect(await empty.all("SELECT 1")).toEqual([])
	})

	it("runs a batch as one set, in one transaction", async () => {
		await sql.batch([
			{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "a"] },
			{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [2, "b"] },
		])

		expect(connection.sets).toEqual([{ size: 2, transaction: true }])
		expect(await sql.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 2 }])
	})

	it("rolls a batch back when any statement fails", async () => {
		await expect(
			sql.batch([
				{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "a"] },
				{ sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "duplicate"] },
			]),
		).rejects.toThrow()

		expect(await sql.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 0 }])
	})

	it("sends values on every statement, which the plugin requires on Android", async () => {
		await sql.batch([{ sql: "INSERT INTO t (id) VALUES (1)" }])
		expect(await sql.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 1 }])
	})

	it("skips an empty batch, which the plugin would fail", async () => {
		await expect(sql.batch([])).resolves.toBeUndefined()
		expect(connection.sets).toEqual([])
	})

	it("never overlaps two calls, because the plugin allows one transaction at a time", async () => {
		await Promise.all([
			sql.batch([{ sql: "INSERT INTO t (id) VALUES (1)" }]),
			sql.run("INSERT INTO t (id) VALUES (2)"),
			sql.batch([{ sql: "INSERT INTO t (id) VALUES (3)" }]),
			sql.all("SELECT 1"),
		])

		expect(await sql.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 3 }])
	})

	it("keeps working after a call fails", async () => {
		await expect(sql.run("NOT SQL")).rejects.toThrow()
		await sql.run("INSERT INTO t (id) VALUES (1)")
		expect(await sql.all("SELECT COUNT(*) AS count FROM t")).toEqual([{ count: 1 }])
	})
})

describe("connecting", () => {
	const fakeSqlite = ({ consistent, connected }) => {
		const connection = { open: vi.fn(async () => {}) }
		return {
			connection,
			checkConnectionsConsistency: vi.fn(async () => ({ result: consistent })),
			isConnection: vi.fn(async () => ({ result: connected })),
			retrieveConnection: vi.fn(async () => connection),
			createConnection: vi.fn(async () => connection),
		}
	}

	it("creates a connection on a fresh start", async () => {
		const sqlite = fakeSqlite({ consistent: false, connected: false })

		expect(await connect(sqlite)).toBe(sqlite.connection)

		expect(sqlite.createConnection).toHaveBeenCalledWith("pos_next", false, "no-encryption", 1, false)
		expect(sqlite.connection.open).toHaveBeenCalled()
	})

	it("reuses the connection a reloaded WebView left open", async () => {
		const sqlite = fakeSqlite({ consistent: true, connected: true })

		await connect(sqlite)

		expect(sqlite.retrieveConnection).toHaveBeenCalledWith("pos_next", false)
		expect(sqlite.createConnection).not.toHaveBeenCalled()
	})

	it("starts over when the plugin and the page disagree", async () => {
		const sqlite = fakeSqlite({ consistent: false, connected: true })

		await connect(sqlite)

		expect(sqlite.createConnection).toHaveBeenCalled()
		expect(sqlite.retrieveConnection).not.toHaveBeenCalled()
	})
})
