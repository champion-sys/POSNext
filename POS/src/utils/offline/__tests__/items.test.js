import { beforeEach, describe, expect, it, vi } from "vitest"

const itemStore = new Map()

vi.mock("../db", () => {
	const items = {
		bulkGet: vi.fn(async (codes) => codes.map((code) => itemStore.get(code))),
		bulkPut: vi.fn(async (rows) => {
			for (const row of rows) itemStore.set(row.item_code, { ...row })
		}),
		get: vi.fn(async (itemCode) => itemStore.get(itemCode) ?? undefined),
		update: vi.fn(async (itemCode, update) => {
			const existing = itemStore.get(itemCode)
			if (!existing) return 0
			itemStore.set(itemCode, { ...existing, ...update })
			return 1
		}),
		put: vi.fn(async (row) => {
			itemStore.set(row.item_code, { ...row })
			return row.item_code
		}),
	}

	return {
		db: {
			items,
			transaction: vi.fn(async (_mode, _table, fn) => fn()),
		},
		getSetting: vi.fn(),
		setSetting: vi.fn(),
	}
})

const {
	parseSerialNumbers,
	persistItemBatchSerialData,
	consumeCachedSerials,
	returnCachedSerials,
	getCachedSerialData,
	getCachedBatchData,
	deductCachedBatchQty,
	cacheItems,
} = await import("../items")

describe("parseSerialNumbers", () => {
	it("parses newline-delimited strings", () => {
		expect(parseSerialNumbers("SN-1\nSN-2\n\n SN-3 ")).toEqual([
			"SN-1",
			"SN-2",
			"SN-3",
		])
	})

	it("passes through arrays and empty input", () => {
		expect(parseSerialNumbers(["A", "B"])).toEqual(["A", "B"])
		expect(parseSerialNumbers(null)).toEqual([])
		expect(parseSerialNumbers("")).toEqual([])
	})
})

describe("offline serial cache mutators", () => {
	beforeEach(() => {
		itemStore.clear()
		itemStore.set("ITEM-1", {
			item_code: "ITEM-1",
			item_name: "Widget",
			serial_no_data: [
				{ serial_no: "SN-1", warehouse: "Stores - T" },
				{ serial_no: "SN-2", warehouse: "Stores - T" },
				{ serial_no: "SN-3", warehouse: "Stores - T" },
			],
		})
	})

	it("consume then return restores serials (round-trip)", async () => {
		await consumeCachedSerials("ITEM-1", "SN-1\nSN-2")
		expect(await getCachedSerialData("ITEM-1")).toEqual([
			{ serial_no: "SN-3", warehouse: "Stores - T" },
		])

		await returnCachedSerials("ITEM-1", ["SN-1", "SN-2"], "Stores - T")
		expect(await getCachedSerialData("ITEM-1")).toEqual([
			{ serial_no: "SN-1", warehouse: "Stores - T" },
			{ serial_no: "SN-2", warehouse: "Stores - T" },
			{ serial_no: "SN-3", warehouse: "Stores - T" },
		])
	})

	it("does not create phantom rows when the item is missing", async () => {
		const ok = await persistItemBatchSerialData("MISSING", {
			serial_no_data: [{ serial_no: "SN-X", warehouse: "Stores - T" }],
		})
		expect(ok).toBe(false)
		expect(itemStore.has("MISSING")).toBe(false)
	})

	it("refuses to return serials without a warehouse when cache is empty", async () => {
		itemStore.set("ITEM-1", {
			item_code: "ITEM-1",
			item_name: "Widget",
			serial_no_data: [],
		})

		await returnCachedSerials("ITEM-1", ["SN-1"])
		expect(await getCachedSerialData("ITEM-1")).toEqual([])

		await returnCachedSerials("ITEM-1", ["SN-1"], "Stores - T")
		expect(await getCachedSerialData("ITEM-1")).toEqual([
			{ serial_no: "SN-1", warehouse: "Stores - T" },
		])
	})
})

describe("offline batch cache", () => {
	beforeEach(() => {
		itemStore.clear()
		itemStore.set("ITEM-1", {
			item_code: "ITEM-1",
			batch_no_data: [
				{ batch_no: "B-1", batch_qty: 5 },
				{ batch_no: "B-2", batch_qty: 3 },
			],
		})
	})

	it("deducts only the sold batch and never goes below zero", async () => {
		await deductCachedBatchQty("ITEM-1", "B-1", 2)
		await deductCachedBatchQty("ITEM-1", "B-2", 9)

		expect(await getCachedBatchData("ITEM-1")).toEqual([
			{ batch_no: "B-1", batch_qty: 3 },
			{ batch_no: "B-2", batch_qty: 0 },
		])
	})

	it("keeps batch data when items are cached again from the server", async () => {
		await cacheItems([{ item_code: "ITEM-1", item_name: "Widget" }])

		expect((await getCachedBatchData("ITEM-1")).length).toBe(2)
		expect(itemStore.get("ITEM-1").item_name).toBe("Widget")
	})
})
