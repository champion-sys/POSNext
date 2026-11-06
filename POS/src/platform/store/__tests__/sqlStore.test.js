// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { createOutbox } from "@/platform/sql/outbox"
import { sumQueuedStock } from "@/utils/offline/invoicePayload"
import { createSqlStore } from "../sqlStore"
import { createNodeExecutor } from "./sqliteHarness"

const invoice = (extra = {}) => ({
	doctype: "Sales Invoice",
	posa_pos_opening_shift: "SHIFT-1",
	items: [{ item_code: "A", qty: 2, conversion_factor: 12, warehouse: "W1" }],
	...extra,
})

const item = (code, name, extra = {}) => ({ item_code: code, item_name: name, item_group: "G", ...extra })

describe("the SQLite store", () => {
	let sql
	let store
	let outbox

	beforeEach(async () => {
		sql = createNodeExecutor()
		await migrate(sql)
		store = createSqlStore(sql)
		outbox = createOutbox(sql)
	})

	describe("a sale", () => {
		beforeEach(async () => {
			await store.cacheItems([item("A", "Item", { warehouse: "W1", actual_qty: 100 })])
		})

		it("commits with its receipt, stock hold and shift", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			expect(await store.getReceipt(offline_id)).toMatchObject({ offline_id, doctype: "Sales Invoice" })
			expect(await outbox.availableStock("A", "W1")).toBe(76)

			const [{ shift, state }] = await sql.all("SELECT shift, state FROM outbox")
			expect(shift).toBe("SHIFT-1")
			expect(state).toBe("pending")
		})

		it("leaves nothing behind when any part of it fails", async () => {
			await sql.run(`CREATE TRIGGER fail_receipt BEFORE INSERT ON receipt
				BEGIN SELECT RAISE(ABORT, 'disk full'); END`)

			await expect(store.saveOfflineInvoice(invoice())).rejects.toThrow("disk full")

			expect(await sql.all("SELECT * FROM outbox")).toEqual([])
			expect(await sql.all("SELECT * FROM stock_reservation")).toEqual([])
			expect(await sql.all("SELECT * FROM device_sequence")).toEqual([])
		})

		it("does not change what the caller passed in", async () => {
			const data = invoice()
			await store.saveOfflineInvoice(data)
			expect(data.offline_id).toBeUndefined()
		})

		it("gets its own place in the queue when two are saved at once", async () => {
			const saves = await Promise.all([1, 2, 3, 4, 5].map(() => store.saveOfflineInvoice(invoice())))

			expect(saves.map((save) => save.id).sort()).toEqual([1, 2, 3, 4, 5])
			expect(await store.getOfflineInvoiceCount()).toBe(5)
		})

		it("releases its hold when an edit retires it", async () => {
			const original = await store.saveOfflineInvoice(invoice())

			await store.saveOfflineInvoice(invoice({ items: [{ item_code: "A", qty: 1, warehouse: "W1" }] }), {
				supersedesId: original.id,
			})

			expect(await outbox.availableStock("A", "W1")).toBe(99)
		})

		it("releases its hold when replaced by an online checkout", async () => {
			const { id } = await store.saveOfflineInvoice(invoice())
			await store.supersedeOfflineInvoice(id, "SINV-1")
			expect(await outbox.availableStock("A", "W1")).toBe(100)
		})

		it("cannot be retired once the server holds it", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(id, { server_status: "received" })

			await store.supersedeOfflineInvoice(id, "SINV-1")

			expect((await store.getQueuedInvoice(offline_id)).server_status).toBe("received")
			expect(await outbox.availableStock("A", "W1")).toBe(76)
		})

		it("keeps holding stock until the server finishes it", async () => {
			const { id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, { server_status: "received" })
			expect(await outbox.availableStock("A", "W1")).toBe(76)

			await store.updateQueuedInvoice(id, { server_status: "needs_review", error: "x", sync_failed: true })
			expect(await outbox.availableStock("A", "W1")).toBe(76)

			await store.updateQueuedInvoice(id, { server_status: "synced", server_invoice: "SINV-1", synced: true })
			expect(await outbox.availableStock("A", "W1")).toBe(100)
		})

		it("gives stock back while a return is on its way, as the web's queued total does", async () => {
			const data = invoice({ is_return: 1, items: [{ item_code: "A", qty: -2, warehouse: "W1" }] })

			await store.saveOfflineInvoice(data)

			expect(await outbox.availableStock("A", "W1")).toBe(102)
			expect(sumQueuedStock(await store.getOfflineInvoices(), "W1").get("A")).toBe(-2)
		})

		it("keeps holding stock while it waits for a local customer", async () => {
			const { offline_id } = await store.saveQueueEntity("customer", { doctype: "Customer" })
			await store.saveOfflineInvoice(invoice({ customer: offline_id }))

			expect(await outbox.availableStock("A", "W1")).toBe(76)
		})

		it("takes its hold and receipt with it when deleted", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.deleteOfflineInvoice(id)

			expect(await outbox.availableStock("A", "W1")).toBe(100)
			expect(await store.getReceipt(offline_id)).toBeNull()
		})

		it("keeps a retired sale for audit when cleaning up", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			await store.supersedeOfflineInvoice(id, "X")

			await store.deleteSyncedInvoices(Date.now() + 1000)

			expect(await store.getQueuedInvoice(offline_id)).toBeDefined()
		})

		it("drops a finished sale's receipt with it", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(id, { server_status: "synced", synced: true })

			await store.deleteSyncedInvoices(Date.now() + 1000)

			expect(await store.getReceipt(offline_id)).toBeNull()
		})

		it("lets the checkout replace the first receipt with its fuller one", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			await store.saveReceipt(offline_id, { name: offline_id, is_offline: true, change_amount: 5 })

			expect(await store.getReceipt(offline_id)).toMatchObject({ is_offline: true, change_amount: 5 })
		})

		it("counts each print of its receipt", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			await store.markOfflineInvoicePrinted(offline_id)
			await store.markOfflineInvoicePrinted(offline_id)

			const [{ printed_count }] = await sql.all("SELECT printed_count FROM receipt")
			expect(printed_count).toBe(2)
		})

		it("forgets receipts on logout", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			await store.clearReceipts()

			expect(await store.getReceipt(offline_id)).toBeNull()
			expect((await store.getQueuedInvoice(offline_id)).data.items).toHaveLength(1)
		})
	})

	describe("records that are not sales", () => {
		it("keep the shift they belong to, for closing it", async () => {
			await store.saveQueueEntity("payment", { posa_pos_opening_shift: "SHIFT-1" })
			await store.saveQueueEntity("shift_close", { pos_opening_shift: "SHIFT-2" })
			await store.saveQueueEntity("customer", { doctype: "Customer" })

			const rows = await sql.all("SELECT shift FROM outbox ORDER BY seq")
			expect(rows.map((row) => row.shift)).toEqual(["SHIFT-1", "SHIFT-2", null])
		})

		it("hold no stock and have no receipt", async () => {
			await store.saveQueueEntity("payment", { items: [{ item_code: "A", qty: 5, warehouse: "W1" }] })

			expect(await sql.all("SELECT * FROM stock_reservation")).toEqual([])
			expect(await sql.all("SELECT * FROM receipt")).toEqual([])
		})

		it("share the sequence with sales, so the server gets them in order", async () => {
			const results = await Promise.all([
				store.saveQueueEntity("customer", { doctype: "Customer" }),
				store.saveOfflineInvoice(invoice()),
				store.saveQueueEntity("payment", { invoice_name: "S" }),
			])

			expect(results.map((result) => result.id).sort()).toEqual([1, 2, 3])
		})

		it("store nothing when saving fails", async () => {
			await sql.run(`CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox
				BEGIN SELECT RAISE(ABORT, 'disk full'); END`)

			await expect(store.saveQueueEntity("customer", {})).rejects.toThrow("disk full")

			expect(await sql.all("SELECT * FROM device_sequence")).toEqual([])
		})

		it("read a row from before the queue had dependencies", async () => {
			await sql.run(
				`INSERT INTO outbox (offline_id, seq, entity, entity_version, payload, state, created_at)
				VALUES ('old', 1, 'invoice', 1, '{}', 'pending', 1)`,
			)

			expect((await store.getQueuedInvoice("old")).depends_on).toEqual([])
		})
	})

	describe("pulled items", () => {
		const page = (rows, deleted = []) => ({ rows, deleted })

		it("set the base stock", async () => {
			await store.applyPullPage("items", page([item("A", "Item", { warehouse: "W1", actual_qty: 8 })]))
			expect(await outbox.availableStock("A", "W1")).toBe(8)
		})

		it("leave nothing behind when deleted", async () => {
			await store.cacheItems([item("A", "Item", { rate: 1, barcodes: ["1"], warehouse: "W1", actual_qty: 8 })])

			await store.applyPullPage("items", page([], ["A"]))

			for (const table of ["catalog_item", "item_barcode", "item_price", "stock_base"]) {
				expect(await sql.all(`SELECT * FROM ${table}`)).toEqual([])
			}
		})

		it("delete far more items than one statement can bind", async () => {
			await store.cacheItems(Array.from({ length: 1200 }, (_, index) => item(`I-${index}`, "Item")))
			const deleted = Array.from({ length: 1200 }, (_, index) => `I-${index}`)

			await store.applyPullPage("items", page([], deleted))

			expect(await store.isCacheReady()).toBe(false)
			const largest = Math.max(...sql.statements.map((statement) => statement.params?.length ?? 0))
			expect(largest).toBeLessThanOrEqual(500)
		})
	})

	describe("stock", () => {
		it("takes the server's figure as the base for what is available", async () => {
			await store.cacheItems([item("A", "Item", { warehouse: "W1", actual_qty: 10 })])
			await store.saveOfflineInvoice(invoice({ items: [{ item_code: "A", qty: 3, warehouse: "W1" }] }))
			expect(await outbox.availableStock("A", "W1")).toBe(7)

			await store.updateStockQuantities([{ item_code: "A", warehouse: "W1", actual_qty: 50 }])
			expect(await outbox.availableStock("A", "W1")).toBe(47)
		})

		it("keeps stock per warehouse", async () => {
			await store.cacheItems([item("A", "Item")])

			await store.updateStockQuantities([
				{ item_code: "A", warehouse: "W1", actual_qty: 5 },
				{ item_code: "A", warehouse: "W2", actual_qty: 6 },
			])

			expect(await outbox.availableStock("A", "W1")).toBe(5)
			expect(await outbox.availableStock("A", "W2")).toBe(6)
		})
	})

	describe("batches and serials", () => {
		it("loses no change when two arrive at once", async () => {
			await store.cacheItems([item("A", "Item")])
			await store.updateItemBatchSerial(["A"], () => ({
				serial_no_data: [{ serial_no: "S1" }, { serial_no: "S2" }, { serial_no: "S3" }],
			}))

			const remove = (serialNo) =>
				store.updateItemBatchSerial(["A"], (cached) => ({
					serial_no_data: cached.serial_no_data.filter((serial) => serial.serial_no !== serialNo),
				}))
			await Promise.all([remove("S1"), remove("S2")])

			expect((await store.getCachedItem("A")).serial_no_data).toEqual([{ serial_no: "S3" }])
		})

		it("keeps going after a change fails", async () => {
			await store.cacheItems([item("A", "Item")])

			await expect(
				store.updateItemBatchSerial(["A"], () => {
					throw new Error("bad change")
				}),
			).rejects.toThrow("bad change")

			expect(await store.updateItemBatchSerial(["A"], () => ({ batch_no_data: [] }))).toBe(1)
		})
	})

	describe("searching in Arabic", () => {
		beforeEach(async () => {
			await store.cacheItems([
				item("I-1", "قَهْوَة عربية"),
				item("I-2", "أرز بسمتي"),
				item("I-3", "إبريق شاي", { description: "ستانلس ستيل" }),
				item("I-4", "حلوى المولد"),
				item("I-5", "آلة حاسبة"),
				item("I-6", "شاي أخضر", { disabled: 1 }),
			])
			await store.cacheCustomers([{ name: "C-1", customer_name: "مصطفى أحمد", mobile_no: "0551112222" }])
		})

		const codes = (items) => items.map((row) => row.item_code)

		it.each([
			["taa marbuta typed as heh", "قهوه", "I-1"],
			["without tashkeel", "قهوة", "I-1"],
			["with tashkeel", "قَهْوَة", "I-1"],
			["alef without its hamza", "ارز", "I-2"],
			["alef with the wrong hamza", "إرز", "I-2"],
			["hamza below typed plainly", "ابريق", "I-3"],
			["alef maksura typed as yeh", "حلوي", "I-4"],
			["alef with madda typed plainly", "اله", "I-5"],
			["inside the name", "بسمتي", "I-2"],
			["in the description", "ستانلس", "I-3"],
			["several words in any order", "عربيه قهوه", "I-1"],
		])("finds an item by %s", async (_how, term, expected) => {
			expect(codes(await store.searchCachedItems(term))).toEqual([expected])
		})

		it("finds a customer however the name is spelled", async () => {
			expect((await store.searchCachedCustomers("مصطفي احمد")).map((c) => c.name)).toEqual(["C-1"])
		})

		it("gives an item back exactly as the server wrote it", async () => {
			expect((await store.getCachedItem("I-1")).item_name).toBe("قَهْوَة عربية")
		})

		it("ranks an exact name above a name that only contains it", async () => {
			await store.cacheItems([item("Z-1", "شاي"), item("A-9", "كوب شاي كبير")])
			expect(codes(await store.searchCachedItems("شاي كبير"))).toEqual(["A-9"])
			expect(codes(await store.searchCachedItems("شاي"))[0]).toBe("Z-1")
		})
	})

	describe("bulk writes", () => {
		const items = (count) =>
			Array.from({ length: count }, (_, index) => item(`I-${index}`, `Item ${index}`, { barcodes: [`b${index}`], rate: 1 }))

		it("stays within what a device's SQLite can bind", async () => {
			await store.cacheItems(items(1200))

			expect(await store.isCacheReady()).toBe(true)
			const largest = Math.max(...sql.statements.map((statement) => statement.params?.length ?? 0))
			expect(largest).toBeLessThanOrEqual(500)
		})

		it("clears barcodes per page, because Android rescans the schema on every DELETE", async () => {
			await store.cacheItems(items(1200))

			const deletes = sql.statements.filter((statement) => /^\s*DELETE/.test(statement.sql))
			expect(deletes).toHaveLength(3)
		})

		it("honors a caller's smaller page, but never a larger one", async () => {
			const batch = vi.spyOn(sql, "batch")

			await store.cacheItems(items(10), 4)
			expect(batch).toHaveBeenCalledTimes(3)

			batch.mockClear()
			await store.cacheItems(items(600), 5000)
			expect(batch).toHaveBeenCalledTimes(2)
		})
	})

	describe("the rest of the app's calls", () => {
		it("never reports a durable database as evictable", async () => {
			expect(await store.requestPersistentStorage()).toBe(true)
		})

		it("keeps the same mode of payment on two profiles", async () => {
			await store.cachePaymentMethods([
				{ mode_of_payment: "Cash", pos_profile: "P1" },
				{ mode_of_payment: "Cash", pos_profile: "P2" },
			])

			expect(await store.getCachedPaymentMethods("P1")).toHaveLength(1)
			expect(await store.getCachedPaymentMethods("P2")).toHaveLength(1)
		})

		it("works out being offline from the shared connection state", () => {
			expect(store.checkOffline(false)).toBe(true)
			expect(store.checkOffline(true)).toBe(false)
		})
	})
})
