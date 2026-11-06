// @vitest-environment node
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { beforeEach, describe, expect, it } from "vitest"
import { migrate, MIGRATIONS } from "../migrations"
import { createOutbox } from "../outbox"

// Vite cannot resolve node:sqlite through an import
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")

function createExecutor() {
	const db = new DatabaseSync(":memory:")
	return {
		db,
		all: async (sql, params = []) => db.prepare(sql).all(...params),
		run: async (sql, params = []) => void db.prepare(sql).run(...params),
		batch: async (statements) => {
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

const sale = (offlineId, qty = 2, extra = {}) => ({
	offlineId,
	shift: "SHIFT-1",
	invoice: {
		doctype: "Sales Invoice",
		items: [{ item_code: "A", qty, conversion_factor: 12, warehouse: "W1" }],
	},
	receipt: { name: offlineId },
	...extra,
})

describe("migrate", () => {
	it("runs once and reports the version", async () => {
		const sql = createExecutor()
		expect(await migrate(sql)).toBe(MIGRATIONS.at(-1).version)
		expect(await migrate(sql)).toBe(MIGRATIONS.at(-1).version)
	})

	it("leaves the last good version when a migration fails", async () => {
		const sql = createExecutor()
		await migrate(sql)
		const broken = [
			...MIGRATIONS,
			{ version: 99, statements: ["CREATE TABLE half_done (id INTEGER)", "THIS IS NOT SQL"] },
		]

		await expect(migrate(sql, broken)).rejects.toThrow()

		expect(await sql.all("SELECT name FROM sqlite_master WHERE name = 'half_done'")).toEqual([])
		expect(await migrate(sql)).toBe(MIGRATIONS.at(-1).version)
	})

	it("keeps queued sales across an upgrade", async () => {
		const sql = createExecutor()
		await migrate(sql)
		await createOutbox(sql).enqueueSale(sale("a"))

		await migrate(sql, [
			...MIGRATIONS,
			{ version: MIGRATIONS.at(-1).version + 1, statements: ["ALTER TABLE outbox ADD COLUMN note TEXT"] },
		])

		const [{ name }] = await sql.all("SELECT name FROM pragma_table_info('outbox') WHERE name = 'note'")
		expect(name).toBe("note")
		expect((await createOutbox(sql).nextBatch(10))[0].offline_id).toBe("a")
	})

	it("keeps a sale queued before the catalog tables existed", async () => {
		const sql = createExecutor()
		await migrate(sql, MIGRATIONS.slice(0, 1))
		await sql.run(
			`INSERT INTO outbox (offline_id, seq, entity, entity_version, payload, state, created_at)
			VALUES ('old', 1, 'invoice', 1, '{"customer":"C"}', 'pending', 1)`,
		)

		expect(await migrate(sql)).toBe(MIGRATIONS.at(-1).version)

		const [row] = await createOutbox(sql).nextBatch(10)
		expect(row.offline_id).toBe("old")
		expect(row.payload.customer).toBe("C")
		expect(row.sync_failed).toBe(0)
	})

	// Devices upgrade through these while holding unsynced sales. Add a migration instead.
	it("never rewrites a shipped migration", () => {
		const hash = createHash("sha256").update(JSON.stringify(MIGRATIONS[0])).digest("hex")
		expect(hash).toBe("09030cebe768c6dd9e15161afa73ea2a47d99b44076d7c02097252b98fce9736")
	})
})

describe("outbox", () => {
	let sql
	let outbox

	beforeEach(async () => {
		sql = createExecutor()
		await migrate(sql)
		outbox = createOutbox(sql)
		await sql.run("INSERT INTO stock_base VALUES ('A', 'W1', 100, 1)")
	})

	it("stores the sale, receipt and stock hold together", async () => {
		await outbox.enqueueSale(sale("a"))

		expect((await outbox.nextBatch(10))[0].payload.items[0].item_code).toBe("A")
		expect(await sql.all("SELECT offline_id FROM receipt")).toEqual([{ offline_id: "a" }])
		expect(await outbox.availableStock("A", "W1")).toBe(76)
	})

	it("stores nothing when any part of the sale fails", async () => {
		await outbox.enqueueSale(sale("a"))

		await expect(outbox.enqueueSale(sale("a"))).rejects.toThrow()

		expect(await outbox.countsByState()).toEqual({ pending: 1 })
		expect(await outbox.availableStock("A", "W1")).toBe(76)
		const [{ value }] = await sql.all("SELECT value FROM device_sequence")
		expect(value).toBe(1)
	})

	it("sends oldest first and respects the backoff", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.enqueueSale(sale("b"))
		await outbox.markFailed("a", "Timeout", 5000)

		expect((await outbox.nextBatch(10, 1000)).map((row) => row.offline_id)).toEqual(["b"])
		expect((await outbox.nextBatch(10, 6000)).map((row) => row.offline_id)).toEqual(["a", "b"])
	})

	it("releases stock only when the sale is finished", async () => {
		await outbox.enqueueSale(sale("a"))

		await outbox.applyResult("a", { state: "received" })
		expect(await outbox.availableStock("A", "W1")).toBe(76)

		await outbox.applyResult("a", { state: "needs_review", error: "Stock" })
		expect(await outbox.availableStock("A", "W1")).toBe(76)

		await outbox.applyResult("a", { state: "synced", serverName: "SINV-1" })
		expect(await outbox.availableStock("A", "W1")).toBe(100)
		const [row] = await sql.all("SELECT server_name, synced_at FROM outbox")
		expect(row.server_name).toBe("SINV-1")
		expect(row.synced_at).toBeGreaterThan(0)
	})

	it("retires the original of an edit in one step", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.enqueueSale(sale("b", 1, { supersedes: "a" }))

		expect((await outbox.nextBatch(10)).map((row) => row.offline_id)).toEqual(["b"])
		expect(await outbox.availableStock("A", "W1")).toBe(88)
	})

	it("does not retire a sale already sent", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.applyResult("a", { state: "received" })
		await outbox.enqueueSale(sale("b", 1, { supersedes: "a" }))

		expect(await outbox.countsByState()).toEqual({ pending: 1, received: 1 })
		expect(await outbox.availableStock("A", "W1")).toBe(64)
	})

	it("sends interrupted sales again after a crash", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.applyResult("a", { state: "sending" })

		await outbox.recoverInterrupted()

		expect(await outbox.nextBatch(10)).toHaveLength(1)
	})

	it("queues a record that is not a sale in the same order", async () => {
		await outbox.enqueueSale(sale("a"))
		const seq = await outbox.enqueueEntity({
			offlineId: "c",
			entity: "customer",
			data: { customer_name: "Sara" },
		})
		await outbox.enqueueSale(sale("b", 1, { dependsOn: ["c"] }))

		expect(seq).toBe(2)
		const rows = await outbox.nextBatch(10)
		expect(rows.map((row) => [row.offline_id, row.entity])).toEqual([
			["a", "invoice"],
			["c", "customer"],
			["b", "invoice"],
		])
		expect(rows[1].payload.customer_name).toBe("Sara")
		expect(rows[2].depends_on).toEqual(["c"])
	})

	it("sends a sale again, still holding its stock, when the server has lost it", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.applyResult("a", { state: "needs_review", serverName: "X", error: "Stock" })

		await outbox.returnToPending("a")

		expect((await outbox.nextBatch(10)).map((row) => row.offline_id)).toEqual(["a"])
		expect(await outbox.get("a")).toMatchObject({
			attempts: 0,
			server_name: null,
			last_error: null,
			sync_failed: 0,
			acked_at: null,
		})
		expect(await outbox.availableStock("A", "W1")).toBe(76)
	})

	it("keeps a row's dependencies with it", async () => {
		await outbox.enqueueEntity({ offlineId: "s", entity: "shift_close", data: {}, dependsOn: ["a", "b"] })
		expect((await outbox.get("s")).depends_on).toEqual(["a", "b"])
	})

	it("lists what is kept, apart from what was retired", async () => {
		await outbox.enqueueSale(sale("a"))
		await outbox.applyResult("a", { state: "synced" })
		await outbox.enqueueSale(sale("b"))
		await outbox.enqueueSale(sale("c", 1, { supersedes: "b" }))

		expect((await outbox.listKept()).map((row) => row.offline_id)).toEqual(["a", "c"])
		expect((await outbox.listQueued()).map((row) => row.offline_id)).toEqual(["c"])
	})

	it("does not hold stock for a Sales Order", async () => {
		await outbox.enqueueSale({ offlineId: "o", invoice: { doctype: "Sales Order", items: [{ item_code: "A", qty: 5, warehouse: "W1" }] } })
		expect(await outbox.availableStock("A", "W1")).toBe(100)
	})
})
