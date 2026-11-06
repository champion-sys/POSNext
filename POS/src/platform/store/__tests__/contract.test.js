/**
 * One set of behavior tests, run against every implementation of the local store.
 *
 * The web side runs the real worker and the real worker client, in this process. Only the
 * layer under them is fake: an in-memory Dexie and raw IndexedDB, because fake-indexeddb
 * is not installed. So these tests cannot show that Dexie itself behaves like the fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { createNativeStore } from "@/platform/store/native"
import { createSqlStore } from "@/platform/store/sqlStore"
import { getQueueUpdateForResult, sumQueuedStock } from "@/utils/offline/invoicePayload"
import { createFakeIndexedDB } from "./fakeIndexedDB"
import { createCapacitorHarness, createElectronHarness, createNodeExecutor } from "./sqliteHarness"

const { FakeDexie, resetFakeDexie } = await vi.hoisted(() => import("./fakeDexie"))

vi.mock("dexie", () => ({ default: FakeDexie }))

const callServer = vi.hoisted(() => vi.fn())
vi.mock("@/utils/apiWrapper", () => ({ call: callServer }))

/** Runs offline.worker.js in this process, wired to the real client as a Worker would be */
class InProcessWorker {
	constructor() {
		this.loaded = (async () => {
			self.postMessage = (message) => this.onmessage?.({ data: structuredClone(message) })
			await import("@/workers/offline.worker.js")
		})()
	}

	async postMessage(message) {
		await this.loaded
		await self.onmessage({ data: structuredClone(message) })
	}

	terminate() {}
}

async function openWebStore() {
	resetFakeDexie()
	vi.doUnmock("@/platform/store")
	vi.stubGlobal("Worker", InProcessWorker)
	vi.stubGlobal("indexedDB", createFakeIndexedDB())
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:worker" }))

	const { localStore } = await import("@/platform/store")
	return localStore
}

function sqlImplementation(createExecutor) {
	return async () => {
		const sql = createExecutor()
		await migrate(sql)
		const database = createSqlStore(sql)
		const store = createNativeStore(async () => database)
		vi.doMock("@/platform/store", () => ({ localStore: store }))
		return store
	}
}

const IMPLEMENTATIONS = [
	["web: worker and Dexie", openWebStore],
	["SQLite", sqlImplementation(createNodeExecutor)],
	["SQLite through the Electron executor and host", sqlImplementation(createElectronHarness)],
	["SQLite through the Capacitor executor", sqlImplementation(createCapacitorHarness)],
]

const fetchResponses = new Map()

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url) => {
			const answer = [...fetchResponses].find(([path]) => String(url).includes(path))?.[1]
			const body = answer ?? { message: "pong" }
			return { ok: true, json: async () => body, text: async () => JSON.stringify(body) }
		}),
	)
}

const invoice = (extra = {}) => ({
	doctype: "Sales Invoice",
	customer: "CUST-1",
	posa_pos_opening_shift: "SHIFT-1",
	grand_total: 24,
	items: [{ item_code: "A", qty: 2, conversion_factor: 12, warehouse: "W1" }],
	payments: [{ mode_of_payment: "Cash", amount: 24 }],
	...extra,
})

const item = (code, extra = {}) => ({
	item_code: code,
	item_name: `Item ${code}`,
	item_group: "Group 1",
	...extra,
})

describe.each(IMPLEMENTATIONS)("%s", (_name, openStore) => {
	let store

	beforeEach(async () => {
		vi.resetModules()
		localStorage.clear()
		sessionStorage.clear()
		fetchResponses.clear()
		callServer.mockReset()
		stubFetch()
		store = await openStore()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.doUnmock("@/platform/store")
	})

	describe("the sales queue", () => {
		it("gives back a sale in the shape the app reads", async () => {
			const before = Date.now()
			const { success, id, offline_id } = await store.saveOfflineInvoice(invoice())

			expect(success).toBe(true)
			expect(offline_id).toMatch(/^pos_offline_/)

			const [row] = await store.getOfflineInvoices()
			expect(row.id).toBe(id)
			expect(row.offline_id).toBe(offline_id)
			expect(row.data.customer).toBe("CUST-1")
			expect(row.data.offline_id).toBe(offline_id)
			expect(row.timestamp).toBeGreaterThanOrEqual(before)
			expect(row.synced).toBe(false)
			expect(row.retry_count).toBe(0)
			expect(row.server_status).toBeUndefined()
			expect(row.superseded).toBeFalsy()
		})

		it("keeps the id of a failed online attempt, so the server can dedupe it", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice({ offline_id: "pos_offline_kept" }))
			expect(offline_id).toBe("pos_offline_kept")
		})

		it("refuses an empty invoice and stores nothing", async () => {
			await expect(store.saveOfflineInvoice(invoice({ items: [] }))).rejects.toThrow("Cannot save empty invoice")
			expect(await store.getOfflineInvoiceCount()).toBe(0)
		})

		// The web's worker client retries with a backoff before it gives up
		it("refuses a second sale with the same id and keeps the first", { timeout: 15000 }, async () => {
			await store.saveOfflineInvoice(invoice({ offline_id: "same", customer: "FIRST" }))

			await expect(store.saveOfflineInvoice(invoice({ offline_id: "same", customer: "SECOND" }))).rejects.toThrow()

			const rows = await store.getOfflineInvoices()
			expect(rows).toHaveLength(1)
			expect(rows[0].data.customer).toBe("FIRST")
		})

		it("lists sales oldest first", async () => {
			const first = await store.saveOfflineInvoice(invoice())
			const second = await store.saveOfflineInvoice(invoice())

			expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual([
				first.offline_id,
				second.offline_id,
			])
			expect((await store.listUnsyncedInvoices()).map((row) => row.id)).toEqual([first.id, second.id])
		})

		it("retires the original of an edit in one step", async () => {
			const original = await store.saveOfflineInvoice(invoice())

			const edit = await store.saveOfflineInvoice(invoice({ customer: "EDITED" }), { supersedesId: original.id })

			const rows = await store.getOfflineInvoices()
			expect(rows.map((row) => row.offline_id)).toEqual([edit.offline_id])
			expect(await store.getOfflineInvoiceCount()).toBe(1)

			const retired = await store.getQueuedInvoice(original.offline_id)
			expect(retired.superseded).toBe(true)
			expect(retired.replaced_by).toBe(edit.offline_id)
		})

		it("keeps the sale when the original of an edit is already gone", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice(), { supersedesId: 9999 })
			expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual([offline_id])
		})

		it("hides a sale replaced by an online checkout", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			expect(await store.supersedeOfflineInvoice(id, "SINV-9")).toEqual({ success: true })

			expect(await store.getOfflineInvoiceCount()).toBe(0)
			expect((await store.getQueuedInvoice(offline_id)).replaced_by).toBe("SINV-9")
		})

		it("treats a queue row that is gone as nothing to do", async () => {
			expect(await store.supersedeOfflineInvoice(9999, "X")).toEqual({ success: true })
			expect(await store.deleteOfflineInvoice(9999)).toEqual({ success: true })
			await expect(store.updateQueuedInvoice(9999, { retry_count: 1, error: "x" })).resolves.not.toThrow()
		})

		it("deletes a sale", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.deleteOfflineInvoice(id)

			expect(await store.getOfflineInvoices()).toEqual([])
			expect(await store.getQueuedInvoice(offline_id)).toBeUndefined()
		})

		it("marks a sale printed", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			expect(await store.markOfflineInvoicePrinted(offline_id)).toEqual({ success: true })

			const { data } = await store.getQueuedInvoice(offline_id)
			expect(data.was_printed).toBe(true)
			expect(data.last_printed_at).toBeGreaterThan(0)
			expect(data.customer).toBe("CUST-1")
		})

		it("says when there is nothing to mark printed", async () => {
			expect(await store.markOfflineInvoicePrinted("unknown")).toEqual({ success: false, reason: "not found" })
			expect(await store.markOfflineInvoicePrinted(null)).toEqual({ success: false })
		})

		it("holds stock for queued sales from the rows it lists", async () => {
			await store.saveOfflineInvoice(invoice())
			await store.saveOfflineInvoice(invoice({ doctype: "Sales Order" }))

			expect(sumQueuedStock(await store.getOfflineInvoices(), "W1").get("A")).toBe(24)
		})

		it("records a failed attempt and its backoff", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, { retry_count: 1, error: "Timeout", next_attempt_at: 5000 })

			const row = await store.getQueuedInvoice(offline_id)
			expect(row.retry_count).toBe(1)
			expect(row.error).toBe("Timeout")
			expect(row.next_attempt_at).toBe(5000)
			expect(row.sync_failed).toBeFalsy()
			expect(row.server_status).toBeUndefined()
		})

		it("flags a sale that ran out of retries", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, { retry_count: 1, error: "x", next_attempt_at: 1, sync_failed: true })

			expect((await store.getQueuedInvoice(offline_id)).sync_failed).toBe(true)
			expect(await store.getOfflineInvoiceCount()).toBe(1)
		})

		it.each([
			["received", { status: "received" }, { server_status: "received", synced: false, listed: true }],
			["processing", { status: "processing" }, { server_status: "processing", synced: false, listed: true }],
			["needs_review", { status: "needs_review", message: "Stock" }, { server_status: "needs_review", synced: false, listed: true }],
			["conflict", { status: "conflict", message: "Stock" }, { server_status: "needs_review", synced: false, listed: true }],
			["synced", { status: "synced", invoice: "SINV-1" }, { server_status: "synced", synced: true, listed: false }],
			["duplicate", { status: "duplicate", invoice: "SINV-1" }, { server_status: "synced", synced: true, listed: false }],
			["voided", { status: "voided" }, { server_status: "voided", synced: true, listed: false }],
		])("follows the server's answer: %s", async (_status, result, expected) => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, getQueueUpdateForResult(result))

			const row = await store.getQueuedInvoice(offline_id)
			expect(row.server_status).toBe(expected.server_status)
			expect(row.synced).toBe(expected.synced)
			expect(row.error ?? null).toBe(result.message ?? null)
			expect(Boolean(row.sync_failed)).toBe(expected.server_status === "needs_review")
			expect(row.server_invoice ?? null).toBe(result.invoice ?? null)
			expect((await store.getOfflineInvoices()).length).toBe(expected.listed ? 1 : 0)
		})

		it("deletes finished sales only past the cutoff", async () => {
			const kept = await store.saveOfflineInvoice(invoice())
			const finished = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(finished.id, getQueueUpdateForResult({ status: "synced", invoice: "S" }))

			await store.deleteSyncedInvoices(0)
			expect(await store.getQueuedInvoice(finished.offline_id)).toBeDefined()

			await store.deleteSyncedInvoices(Date.now() + 1000)
			expect(await store.getQueuedInvoice(finished.offline_id)).toBeUndefined()
			expect(await store.getQueuedInvoice(kept.offline_id)).toBeDefined()
		})
	})

	describe("syncing through utils/offline/sync", () => {
		let syncOfflineInvoices

		beforeEach(async () => {
			;({ syncOfflineInvoices } = await import("@/utils/offline/sync"))
		})

		const answers = (results, statuses = []) =>
			callServer.mockImplementation(async (method) => (method.endsWith("push") ? { results } : statuses))

		it("hands a sale to the server and follows it until it is synced", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers(
				[{ offline_id, status: "received" }],
				[{ offline_id, status: "synced", invoice: "SINV-1" }],
			)

			const result = await syncOfflineInvoices()

			expect(result.success).toBe(1)
			expect(await store.getOfflineInvoiceCount()).toBe(0)

			const [method, params] = callServer.mock.calls[0]
			expect(method).toBe("pos_next.api.sync.push")
			expect(params.items[0].offline_id).toBe(offline_id)
			expect(params.items[0].payload.customer).toBe("CUST-1")
			expect(params.items[0].seq).toBeGreaterThan(0)
		})

		it("backs off from a sale the server rejects", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers([{ offline_id, status: "rejected", message: "Bad" }])

			const result = await syncOfflineInvoices()

			expect(result.failed).toBe(1)
			const row = await store.getQueuedInvoice(offline_id)
			expect(row.retry_count).toBe(1)
			expect(row.error).toBe("Bad")
			expect(row.next_attempt_at).toBeGreaterThan(Date.now())
		})

		it("survives a rejection without a message", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers([{ offline_id, status: "rejected" }])

			expect((await syncOfflineInvoices()).failed).toBe(1)
			expect((await store.getQueuedInvoice(offline_id)).retry_count).toBe(1)
		})

		it("waits out the backoff unless the sync is forced", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(id, { retry_count: 1, error: "x", next_attempt_at: Date.now() + 60000 })
			answers([{ offline_id, status: "synced", invoice: "S" }], [{ offline_id, status: "synced", invoice: "S" }])

			await syncOfflineInvoices()
			expect(callServer).not.toHaveBeenCalledWith("pos_next.api.sync.push", expect.anything())

			await syncOfflineInvoices({ force: true })
			expect(callServer).toHaveBeenCalledWith("pos_next.api.sync.push", expect.anything())
		})

		it("reports a sale that needs review and keeps it listed", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers(
				[{ offline_id, status: "received" }],
				[{ offline_id, status: "needs_review", message: "No stock" }],
			)

			const result = await syncOfflineInvoices()

			expect(result.failed).toBe(1)
			const [row] = await store.getOfflineInvoices()
			expect(row.server_status).toBe("needs_review")
			expect(row.sync_failed).toBe(true)
			expect(row.error).toBe("No stock")
		})

		it("finds a queued invoice by its offline id", async () => {
			const { getOfflineInvoiceByOfflineId } = await import("@/utils/offline/sync")
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			expect((await getOfflineInvoiceByOfflineId(offline_id)).customer).toBe("CUST-1")
			expect(await getOfflineInvoiceByOfflineId("unknown")).toBeNull()
		})
	})

	describe("the catalog", () => {
		const catalog = [
			item("B-2", { item_name: "Banana" }),
			item("A-1", { item_name: "Apple", barcodes: ["1234567890"], description: "red fruit" }),
			item("TPL", { item_name: "Template", has_variants: 1 }),
			item("TPL-S", { item_name: "Template Small", variant_of: "TPL" }),
			item("OFF", { item_name: "Disabled", disabled: 1 }),
			item("C-3", { item_name: "Cherry", item_group: "Group 2", brand: "Acme" }),
		]

		beforeEach(async () => {
			await store.cacheItems(catalog)
		})

		const codes = (items) => items.map((row) => row.item_code)

		it("reports what it cached", async () => {
			expect(await store.cacheItems([item("Z-1")])).toMatchObject({ success: true, count: 1 })
			expect(await store.cacheItems([])).toEqual({ success: true, count: 0, duration: 0 })
			expect(await store.isCacheReady()).toBe(true)
		})

		it("browses by name, without templates' variants or disabled items", async () => {
			expect(codes(await store.searchCachedItems(""))).toEqual(["A-1", "B-2", "C-3", "TPL"])
		})

		it("shows variants instead of templates when the setting asks for it", async () => {
			await store.setShowVariantsAsItems(true)
			expect(codes(await store.searchCachedItems(""))).toEqual(["A-1", "B-2", "C-3", "TPL-S"])
		})

		it("pages through a browse", async () => {
			expect(codes(await store.searchCachedItems("", 2, 1))).toEqual(["B-2", "C-3"])
		})

		it("finds an item by barcode first", async () => {
			expect(codes(await store.searchCachedItems("1234567890"))).toEqual(["A-1"])
		})

		it("finds an item by the start of its code, in any case", async () => {
			expect(codes(await store.searchCachedItems("b-2"))).toEqual(["B-2"])
		})

		it("finds an item by the start of its name, in any case", async () => {
			expect(codes(await store.searchCachedItems("CHER"))).toEqual(["C-3"])
		})

		it("matches every word of a longer search, in any order", async () => {
			expect(codes(await store.searchCachedItems("fruit red"))).toEqual(["A-1"])
			expect(await store.searchCachedItems("fruit blue")).toEqual([])
		})

		it("never finds a disabled item", async () => {
			expect(await store.searchCachedItems("disabled")).toEqual([])
		})

		it("finds a variant by search though it is hidden from browsing", async () => {
			expect(codes(await store.searchCachedItems("TPL-S"))).toEqual(["TPL-S"])
		})

		it("filters by group, sorted and paged", async () => {
			expect(codes(await store.searchCachedItemsByGroup(["Group 1"]))).toEqual(["A-1", "B-2", "TPL"])
			expect(codes(await store.searchCachedItemsByGroup(["Group 1", "Group 2"], 2, 1))).toEqual(["B-2", "C-3"])
			expect(await store.countCachedItemsByGroup(["Group 1"])).toBe(3)
			expect(await store.countCachedItemsByGroup([])).toBe(4)
		})

		it("falls back to browsing without a group or brand", async () => {
			expect(codes(await store.searchCachedItemsByGroup([], 1))).toEqual(["A-1"])
			expect(codes(await store.searchCachedItemsByBrand("", 1, 1))).toEqual(["B-2"])
		})

		it("filters by brand", async () => {
			expect(codes(await store.searchCachedItemsByBrand("Acme"))).toEqual(["C-3"])
			expect(await store.searchCachedItemsByBrand("Nobody")).toEqual([])
		})

		it("reads one item, a barcode and the variants of a template", async () => {
			expect((await store.getCachedItem("A-1")).item_name).toBe("Apple")
			expect(await store.getCachedItem("nope")).toBeUndefined()
			expect((await store.getCachedItemByBarcode("1234567890")).item_code).toBe("A-1")
			expect(await store.getCachedItemByBarcode("0")).toBeUndefined()
			expect(codes(await store.getCachedVariants("TPL"))).toEqual(["TPL-S"])
		})

		it("reads barcodes in each format the server sends them", async () => {
			await store.cacheItems([
				item("P-1", { barcode: "111" }),
				item("P-2", { item_barcode: [{ barcode: "222" }, { barcode: "223" }] }),
				item("P-3", { item_barcode: "333" }),
			])

			for (const [barcode, itemCode] of [["111", "P-1"], ["223", "P-2"], ["333", "P-3"]]) {
				expect(codes(await store.searchCachedItems(barcode))).toEqual([itemCode])
			}
			expect((await store.getCachedItem("P-2")).barcodes).toEqual(["222", "223"])
		})

		it("stops finding a barcode the server took away", async () => {
			await store.cacheItems([item("A-1", { item_name: "Apple", barcodes: ["999"] })])

			expect(await store.getCachedItemByBarcode("1234567890")).toBeUndefined()
			expect((await store.getCachedItemByBarcode("999")).item_code).toBe("A-1")
		})

		it("keeps a price per price list, with a default list", async () => {
			await store.cacheItems([
				item("P-1", { rate: 5, selling_price_list: "Retail" }),
				item("P-2", { price_list_rate: 7 }),
				item("P-3"),
			])

			expect(await store.getCachedItemPrice("Retail", "P-1")).toBe(5)
			expect(await store.getCachedItemPrice("Standard", "P-2")).toBe(7)
			expect(await store.getCachedItemPrice("Standard", "P-3")).toBeUndefined()
		})

		it("counts what the screen shows", async () => {
			const stats = await store.getCacheStats()

			expect(stats.items).toBe(5)
			expect(stats.customers).toBe(0)
			expect(stats.queuedInvoices).toBe(0)
			expect(stats.cacheReady).toBe(true)
			expect(stats.lastSync).toBeGreaterThan(0)
		})

		it("updates stock on the items it holds, and only those", async () => {
			const result = await store.updateStockQuantities([
				{ item_code: "A-1", warehouse: "W1", actual_qty: 7 },
				{ item_code: "B-2", stock_qty: 3 },
				{ item_code: "not cached", actual_qty: 1 },
				{ warehouse: "W1", actual_qty: 1 },
			])

			expect(result).toEqual({ success: true, updated: 2 })
			expect(await store.getCachedItem("A-1")).toMatchObject({ actual_qty: 7, stock_qty: 7, warehouse: "W1" })
			expect(await store.getCachedItem("B-2")).toMatchObject({ actual_qty: 3, stock_qty: 3 })
			expect(await store.updateStockQuantities([])).toEqual({ success: true, updated: 0 })
		})

		it("keeps batch and serial data through a stock update", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "B1", batch_qty: 5 }] })

			await store.updateStockQuantities([{ item_code: "A-1", actual_qty: 9 }])

			const cached = await store.getCachedItem("A-1")
			expect(cached.actual_qty).toBe(9)
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1", batch_qty: 5 }])
		})

		it("keeps batch and serial data when the server sends the item again", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { serial_no_data: [{ serial_no: "S1" }] })

			await store.cacheItems([item("A-1", { item_name: "Apple 2" })])

			const cached = await store.getCachedItem("A-1")
			expect(cached.item_name).toBe("Apple 2")
			expect(cached.serial_no_data).toEqual([{ serial_no: "S1" }])
		})

		it("lets a server row that carries batch data replace the cached one", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "OLD" }] })

			await store.cacheItems([item("A-1", { batch_no_data: [{ batch_no: "NEW" }] })])

			expect((await store.getCachedItem("A-1")).batch_no_data).toEqual([{ batch_no: "NEW" }])
		})

		it("removes whole groups with their prices", async () => {
			await store.cacheItems([item("P-1", { item_group: "Gone", rate: 5 })])

			expect(await store.removeItemsByGroups(["Gone"])).toMatchObject({ success: true, removed: 1, pricesRemoved: 1 })
			expect(await store.getCachedItem("P-1")).toBeUndefined()
			expect(await store.getCachedItemPrice("Standard", "P-1")).toBeUndefined()
			expect(await store.removeItemsByGroups([])).toEqual({ success: true, removed: 0, pricesRemoved: 0 })
		})

		it("clears items and prices", async () => {
			await store.cacheItems([item("P-1", { rate: 5 })])

			expect(await store.clearItemsCache()).toEqual({ success: true })

			expect(await store.isCacheReady()).toBe(false)
			expect(await store.getCachedItemPrice("Standard", "P-1")).toBeUndefined()
			expect((await store.getCacheStats()).lastSync).toBeNull()
		})
	})

	describe("batches and serials through utils/offline/items", () => {
		let items

		beforeEach(async () => {
			items = await import("@/utils/offline/items")
			await store.cacheItems([item("A-1")])
		})

		it("consumes and returns serials", async () => {
			await items.persistItemBatchSerialData("A-1", {
				serial_no_data: [
					{ serial_no: "S1", warehouse: "W1" },
					{ serial_no: "S2", warehouse: "W1" },
				],
			})

			await items.consumeCachedSerials("A-1", "S1")
			expect((await items.getCachedSerialData("A-1")).map((s) => s.serial_no)).toEqual(["S2"])

			await items.returnCachedSerials("A-1", ["S1"])
			expect((await items.getCachedSerialData("A-1")).map((s) => s.serial_no)).toEqual(["S1", "S2"])
		})

		it("deducts a sold batch and never goes below zero", async () => {
			await items.persistItemBatchSerialData("A-1", {
				batch_no_data: [
					{ batch_no: "B1", batch_qty: 5 },
					{ batch_no: "B2", batch_qty: 1 },
				],
			})

			await items.deductCachedBatchQty("A-1", "B1", 2)
			await items.deductCachedBatchQty("A-1", "B2", 9)

			expect((await items.getCachedBatchData("A-1")).map((b) => b.batch_qty)).toEqual([3, 0])
		})

		it("does not invent an item it does not hold", async () => {
			expect(await items.persistItemBatchSerialData("ghost", { batch_no_data: [] })).toBe(false)
			expect(await store.getCachedItem("ghost")).toBeUndefined()
		})

		it("updates several items in one call, skipping unknown ones", async () => {
			await items.updateItemBatchSerialData({
				"A-1": { batch_no_data: [{ batch_no: "B1" }] },
				ghost: { serial_no_data: [{ serial_no: "S" }] },
			})

			const cached = await store.getCachedItem("A-1")
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1" }])
			expect(cached.serial_no_data).toEqual([])
			expect(await store.getCachedItem("ghost")).toBeUndefined()
		})

		it("merges a page of items without touching batch data", async () => {
			await items.persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "B1" }] })

			await items.cacheItems([item("A-1", { item_barcode: [{ barcode: "555" }], rate: 3 })], "Retail")

			expect((await store.getCachedItem("A-1")).batch_no_data).toEqual([{ batch_no: "B1" }])
			expect((await items.getItemByBarcode("555")).item_code).toBe("A-1")
			expect((await items.getItemWithPrice("A-1", "Retail")).rate).toBe(3)
			expect(await items.getItemsLastSync()).toBeGreaterThan(0)
		})
	})

	describe("customers", () => {
		const customers = [
			{ name: "CUST-2", customer_name: "Sara Ali", mobile_no: "0551112222" },
			{ name: "CUST-1", customer_name: "Omar Hassan", mobile_no: "0553334444" },
		]

		beforeEach(async () => {
			await store.cacheCustomers(customers)
		})

		const names = (rows) => rows.map((row) => row.name)

		it("searches inside the name, mobile number and id, in any case", async () => {
			expect(names(await store.searchCachedCustomers("ali"))).toEqual(["CUST-2"])
			expect(names(await store.searchCachedCustomers("3334"))).toEqual(["CUST-1"])
			expect(names(await store.searchCachedCustomers("cust-1"))).toEqual(["CUST-1"])
			expect(await store.searchCachedCustomers("nobody")).toEqual([])
		})

		it("lists them, limited or whole", async () => {
			expect(names(await store.searchCachedCustomers("", 1))).toEqual(["CUST-1"])
			expect(await store.searchCachedCustomers("", 0)).toHaveLength(2)
			expect(await store.searchCachedCustomers("055", 1)).toHaveLength(1)
			expect(await store.searchCachedCustomers("055", 0)).toHaveLength(2)
		})

		it("gives each one back whole", async () => {
			expect(await store.getCachedCustomer("CUST-1")).toEqual(customers[1])
			expect(await store.getCachedCustomer("nope")).toBeUndefined()
		})

		it("deletes and clears", async () => {
			await store.deleteCustomers(["CUST-1"])
			expect(names(await store.searchCachedCustomers(""))).toEqual(["CUST-2"])
			expect(await store.deleteCustomers([])).toBe(true)

			await store.clearCustomersCache()
			expect(await store.searchCachedCustomers("")).toEqual([])
			expect(await store.getSetting("customers_last_sync")).toBeNull()
		})
	})

	describe("payment methods and sales persons", () => {
		it("keeps payment methods by profile", async () => {
			expect(
				await store.cachePaymentMethods([
					{ mode_of_payment: "Cash", pos_profile: "P1", default: 1 },
					{ mode_of_payment: "Card", pos_profile: "P2" },
				]),
			).toEqual({ success: true, count: 2 })

			expect(await store.getCachedPaymentMethods("P1")).toEqual([
				{ mode_of_payment: "Cash", pos_profile: "P1", default: 1 },
			])
			expect(await store.getCachedPaymentMethods()).toHaveLength(2)
			expect(await store.getSetting("payment_methods_last_sync")).toBeGreaterThan(0)
		})

		it("keeps sales persons by profile", async () => {
			await store.cacheSalesPersons([
				{ name: "Ali", pos_profile: "P1" },
				{ name: "Sara", pos_profile: "P2" },
			])

			expect(await store.getCachedSalesPersons("P2")).toEqual([{ name: "Sara", pos_profile: "P2" }])
			expect(await store.getCachedSalesPersons()).toHaveLength(2)
		})
	})

	describe("offers", () => {
		const nextYear = `${new Date().getFullYear() + 1}-01-01`

		it("replaces a profile's offers and leaves out expired ones", async () => {
			await store.cacheOffers([{ name: "OLD", valid_upto: nextYear }], "P1")

			expect(
				await store.cacheOffers(
					[{ name: "LIVE", valid_upto: nextYear }, { name: "FOREVER" }, { name: "EXPIRED", valid_upto: "2020-01-01" }],
					"P1",
				),
			).toEqual({ success: true, count: 3 })

			expect((await store.getCachedOffers("P1")).map((offer) => offer.name).sort()).toEqual(["FOREVER", "LIVE"])
		})

		it("keeps profiles apart", async () => {
			await store.cacheOffers([{ name: "A" }], "P1")
			await store.cacheOffers([{ name: "B" }], "P2")

			await store.clearOffersCache("P1")

			expect(await store.getCachedOffers("P1")).toEqual([])
			expect((await store.getCachedOffers("P2")).map((offer) => offer.name)).toEqual(["B"])
		})

		it("clears every profile when none is named", async () => {
			await store.cacheOffers([{ name: "A" }], "P1")
			await store.clearOffersCache()
			expect(await store.getCachedOffers("P1")).toEqual([])
		})

		it("refuses a call without offers or a profile", async () => {
			expect(await store.cacheOffers(null, "P1")).toEqual({ success: false, count: 0 })
			expect(await store.cacheOffers([], "")).toEqual({ success: false, count: 0 })
			expect(await store.getCachedOffers("")).toEqual([])
		})
	})

	describe("settings", () => {
		it("gives back what was stored, or the default", async () => {
			await store.setSetting("rules", { rate: 15, names: ["VAT"] })

			expect(await store.getSetting("rules")).toEqual({ rate: 15, names: ["VAT"] })
			expect(await store.getSetting("missing", "fallback")).toBe("fallback")
			expect(await store.getSetting("missing")).toBeNull()
		})

		it("keeps a stored false or null rather than the default", async () => {
			await store.setSetting("flag", false)
			await store.setSetting("nothing", null)

			expect(await store.getSetting("flag", true)).toBe(false)
			expect(await store.getSetting("nothing", "fallback")).toBeNull()
		})

		it("deletes by prefix", async () => {
			await store.setSetting("print_format_template_a", 1)
			await store.setSetting("print_format_template_b", 2)
			await store.setSetting("print_other", 3)

			await store.deleteSettingsByPrefix("print_format_template_")

			expect(await store.getSetting("print_format_template_a")).toBeNull()
			expect(await store.getSetting("print_other")).toBe(3)
		})
	})

	describe("clearing cached data", () => {
		beforeEach(async () => {
			await store.cacheItems([item("A-1", { rate: 5 })])
			await store.cacheCustomers([{ name: "C", customer_name: "C" }])
			await store.cachePaymentMethods([{ mode_of_payment: "Cash", pos_profile: "P" }])
			await store.cacheSalesPersons([{ name: "S", pos_profile: "P" }])
			await store.saveOfflineInvoice(invoice())
			await store.addDraft({ draft_id: "D", created_at: "2026-01-01" })
			await store.setSetting("key", 1)
		})

		it("keeps sales, drafts and settings by default", async () => {
			expect((await store.clearCachedData()).success).toBe(true)

			expect(await store.isCacheReady()).toBe(false)
			expect(await store.getCachedItemPrice("Standard", "A-1")).toBeUndefined()
			expect(await store.searchCachedCustomers("")).toEqual([])
			expect(await store.getCachedPaymentMethods("P")).toEqual([])
			expect(await store.getCachedSalesPersons("P")).toEqual([])

			expect(await store.getOfflineInvoiceCount()).toBe(1)
			expect(await store.countDrafts()).toBe(1)
			expect(await store.getSetting("key")).toBe(1)
		})

		it("keeps payment methods when asked, for a cache version upgrade", async () => {
			await store.clearCachedData({ preservePaymentMethods: true })
			expect(await store.getCachedPaymentMethods("P")).toHaveLength(1)
		})

		it("clears sales and settings only when told to", async () => {
			await store.clearCachedData({ preserveInvoices: false, preserveSettings: false })

			expect(await store.getOfflineInvoiceCount()).toBe(0)
			expect(await store.getSetting("key")).toBeNull()
			expect(await store.countDrafts()).toBe(1)
		})
	})

	describe("invoice history through utils/offline/sync", () => {
		let sync

		const history = [
			{ name: "A", customer: "Ali", posting_date: "2026-01-01", posting_time: "10:00:00" },
			{ name: "B", customer: "Sara", posting_date: "2026-03-01", posting_time: "10:00:00" },
			{ name: "C", customer: "Ali Omar", posting_date: "2026-02-01" },
		]

		beforeEach(async () => {
			sync = await import("@/utils/offline/sync")
			await sync.cacheInvoiceHistory(history, "P1")
			await sync.cacheInvoiceHistory([{ name: "Z", customer: "Zed", posting_date: "2026-01-01" }], "P2")
		})

		const names = (rows) => rows.map((row) => row.name)

		it("reads newest first, by profile", async () => {
			expect(names(await sync.getCachedInvoiceHistory("P1"))).toEqual(["B", "C", "A"])
			expect(await sync.getCachedInvoiceHistory()).toHaveLength(4)
		})

		it("filters by customer and dates, and limits", async () => {
			expect(names(await sync.getCachedInvoiceHistory("P1", { customer: "ali" }))).toEqual(["C", "A"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { fromDate: "2026-02-01" }))).toEqual(["B", "C"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { toDate: "2026-01-31" }))).toEqual(["A"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { limit: 1 }))).toEqual(["B"])
		})

		it("clears one profile or all of them", async () => {
			await sync.clearInvoiceHistoryCache("P1")
			expect(await sync.getCachedInvoiceHistory("P1")).toEqual([])
			expect(await sync.getCachedInvoiceHistory()).toHaveLength(1)

			await sync.clearInvoiceHistoryCache()
			expect(await sync.getCachedInvoiceHistory()).toEqual([])
		})
	})

	describe("unpaid invoices through utils/offline/sync", () => {
		let sync

		beforeEach(async () => {
			sync = await import("@/utils/offline/sync")
		})

		it("replaces a profile's list and reads the largest amount first", async () => {
			await sync.cacheUnpaidInvoices([{ name: "OLD", outstanding_amount: 1 }], "P1")
			await sync.cacheUnpaidInvoices(
				[
					{ name: "A", outstanding_amount: 10 },
					{ name: "B", outstanding_amount: 50 },
				],
				"P1",
			)
			await sync.cacheUnpaidInvoices([{ name: "C", outstanding_amount: 99 }], "P2")

			expect((await sync.getCachedUnpaidInvoices("P1")).map((row) => row.name)).toEqual(["B", "A"])
			expect((await sync.getCachedUnpaidInvoices("P1", { limit: 1 })).map((row) => row.name)).toEqual(["B"])
			expect(await sync.getCachedUnpaidInvoices("")).toEqual([])
		})

		it("empties a profile that has nothing unpaid any more", async () => {
			await sync.cacheUnpaidInvoices([{ name: "A", outstanding_amount: 10 }], "P1")
			expect(await sync.cacheUnpaidInvoices([], "P1")).toBe(true)
			expect(await sync.getCachedUnpaidInvoices("P1")).toEqual([])
		})

		it("keeps the summary", async () => {
			await sync.cacheUnpaidSummary({ count: 2, total_outstanding: 60, total_paid: 5 }, "P1")

			expect(await sync.getCachedUnpaidSummary("P1")).toMatchObject({ count: 2, total_outstanding: 60 })
			expect(await sync.getCachedUnpaidSummary("P2")).toEqual({ count: 0, total_outstanding: 0, total_paid: 0 })
		})
	})

	describe("translations through utils/offline/translationCache", () => {
		it("survives losing the memory copy", async () => {
			const { translationCache } = await import("@/utils/offline/translationCache")
			await translationCache.set("AR", { Hello: "مرحبا" }, 1000)

			vi.resetModules()
			const fresh = (await import("@/utils/offline/translationCache")).translationCache

			expect(await fresh.get("ar")).toEqual({ locale: "ar", messages: { Hello: "مرحبا" }, timestamp: 1000 })
			expect(await fresh.get("fr")).toBeNull()
		})

		it("clears one locale or all of them", async () => {
			const { translationCache } = await import("@/utils/offline/translationCache")
			await translationCache.set("ar", { a: "1" })
			await translationCache.set("en", { a: "2" })

			expect(await translationCache.clear("ar")).toBe(true)
			expect(await store.getTranslations("ar")).toBeNull()
			expect(await store.getTranslations("en")).not.toBeNull()

			expect(await translationCache.clear()).toBe(true)
			expect(await store.getTranslations("en")).toBeNull()
		})
	})

	describe("drafts through utils/draftManager", () => {
		let drafts

		beforeEach(async () => {
			drafts = await import("@/utils/draftManager")
		})

		it("saves, reads back and counts", async () => {
			const draft = await drafts.saveDraft({ customer: "CUST-1", items: [{ item_code: "A" }] })

			expect(draft.draft_id).toMatch(/^DRAFT-/)
			expect(await drafts.getDraftById(draft.draft_id)).toMatchObject({ customer: "CUST-1" })
			expect(await drafts.getDraftById("nope")).toBeUndefined()
			expect(await drafts.getDraftsCount()).toBe(1)
		})

		it("updates in place, keeping when it was created", async () => {
			const draft = await drafts.saveDraft({ customer: "OLD" })

			const updated = await drafts.updateDraft(draft.draft_id, { customer: "NEW" })

			expect(updated.created_at).toBe(draft.created_at)
			expect(await drafts.getDraftsCount()).toBe(1)
			expect((await drafts.getDraftById(draft.draft_id)).customer).toBe("NEW")
			await expect(drafts.updateDraft("nope", {})).rejects.toThrow("Draft not found")
		})

		it("lists the newest first", async () => {
			await store.addDraft({ draft_id: "OLD", created_at: "2026-01-01T00:00:00Z" })
			await store.addDraft({ draft_id: "NEW", created_at: "2026-02-01T00:00:00Z" })

			expect((await drafts.getAllDrafts()).map((draft) => draft.draft_id)).toEqual(["NEW", "OLD"])
		})

		it("deletes one or all", async () => {
			const first = await drafts.saveDraft({})
			const second = await drafts.saveDraft({})

			expect(await drafts.deleteDraft(first.draft_id)).toBe(true)
			expect((await drafts.getAllDrafts()).map((draft) => draft.draft_id)).toEqual([second.draft_id])
			await expect(drafts.deleteDraft("nope")).rejects.toThrow("Draft not found")

			expect(await drafts.clearAllDrafts()).toBe(true)
			expect(await drafts.getDraftsCount()).toBe(0)
		})
	})

	describe("the print queue", () => {
		const job = (jobId, data = [27, 64, 200, 255]) => ({
			jobId,
			data: new Uint8Array(data),
			priority: "normal",
			status: "pending",
			retries: 0,
			maxRetries: 3,
			createdAt: 1000,
		})

		it("keeps the bytes of a job intact", async () => {
			await store.putPrintJob(job("J1"))

			const [saved] = await store.listPrintJobs()
			expect(saved.jobId).toBe("J1")
			expect(ArrayBuffer.isView(saved.data)).toBe(true)
			expect([...saved.data]).toEqual([27, 64, 200, 255])
		})

		it("replaces a job by id and deletes it", async () => {
			await store.putPrintJob(job("J1"))
			await store.putPrintJob({ ...job("J1"), status: "failed" })
			expect((await store.listPrintJobs()).map((saved) => saved.status)).toEqual(["failed"])

			await store.deletePrintJob("J1")
			expect(await store.listPrintJobs()).toEqual([])
		})
	})

	describe("the open shift", () => {
		it("is kept, replaced and cleared", async () => {
			expect(await store.getShift()).toBeNull()

			await store.saveShift({ pos_opening_shift: { name: "SHIFT-1" }, _receivedAt: 5 })
			await store.saveShift({ pos_opening_shift: { name: "SHIFT-2" }, _receivedAt: 6 })
			expect(await store.getShift()).toEqual({ pos_opening_shift: { name: "SHIFT-2" }, _receivedAt: 6 })

			await store.clearShift()
			expect(await store.getShift()).toBeNull()
		})
	})

	describe("the periodic stock sync", () => {
		beforeEach(async () => {
			await store.cacheItems([item("A-1", { batch_no_data: [{ batch_no: "B1" }] })])
			fetchResponses.set("get_stock_quantities", {
				message: [{ item_code: "A-1", warehouse: "W1", actual_qty: 42 }],
			})
		})

		afterEach(async () => {
			await store.stopStockSync()
		})

		it("reports how it is configured", async () => {
			expect(await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"], intervalMs: 30000 })).toEqual({
				warehouse: "W1",
				itemCount: 1,
				intervalMs: 30000,
				enabled: false,
				lastSync: null,
			})
			expect(await store.getStockSyncStatus()).toMatchObject({ enabled: false, running: false, itemCount: 1 })
		})

		it("refuses an interval that would hammer the server", async () => {
			const before = await store.getStockSyncStatus()
			expect((await store.configureStockSync({ intervalMs: 5 })).intervalMs).toBe(before.intervalMs)
		})

		it("updates cached stock and announces it", async () => {
			const announced = new Promise((resolve) => {
				window.addEventListener("stockSyncComplete", (event) => resolve(event.detail), { once: true })
			})
			await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"] })

			const { success, status } = await store.triggerStockSync()

			expect(success).toBe(true)
			expect(status.lastSync).toBeGreaterThan(0)
			expect(await announced).toMatchObject({ updated: 1, total: 1 })

			const cached = await store.getCachedItem("A-1")
			expect(cached.actual_qty).toBe(42)
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1" }])
		})

		it("starts and stops", async () => {
			await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"] })

			expect((await store.startStockSync()).status.enabled).toBe(true)
			expect((await store.stopStockSync()).status.enabled).toBe(false)
		})
	})
})
