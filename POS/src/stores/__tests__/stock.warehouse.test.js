import { flushPromises } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePOSEventsStore } from "../posEvents"
import { useStockStore } from "../stock"

const mocks = vi.hoisted(() => ({
	getOfflineInvoices: vi.fn(),
	updateStockQuantities: vi.fn(async () => {}),
}))

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn(async () => []) }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: mocks }))

const sale = (warehouse, qty) => ({
	data: {
		doctype: "Sales Invoice",
		items: [{ item_code: "SKU", warehouse, qty }],
	},
})

describe("stock brought by the pull", () => {
	let stock

	const pulled = (qty, extra = {}) => ({ item_code: "SKU", warehouse: "Main", actual_qty: qty, ...extra })

	beforeEach(async () => {
		setActivePinia(createPinia())
		mocks.getOfflineInvoices.mockReset().mockResolvedValue([sale("Main", 2)])

		stock = useStockStore()
		stock.init([{ item_code: "SKU", actual_qty: 10 }])
		stock.setWarehouse("Main")
		await flushPromises()
	})

	it("replaces what the server said, and sales still queued keep holding stock", () => {
		stock.applyPulled([pulled(7)])

		expect(stock.getStockInfo("SKU")).toMatchObject({ server: 7, queued: 2, display: 5 })
	})

	it("leaves the cart's reservations in place", () => {
		stock.reserve([{ item_code: "SKU", quantity: 3 }])

		stock.applyPulled([pulled(7)])

		expect(stock.getStockInfo("SKU")).toMatchObject({ server: 7, reserved: 3, display: 2 })
	})

	it("ignores a row of a warehouse this till is not selling from", () => {
		stock.applyPulled([pulled(99, { warehouse: "Annex" })])

		expect(stock.getStockInfo("SKU").server).toBe(10)
	})

	it("does not start tracking items nothing has loaded", () => {
		stock.applyPulled([pulled(4, { item_code: "OTHER" })])

		expect(stock.server.has("OTHER")).toBe(false)
	})

	it("copes with an empty page", () => {
		expect(() => stock.applyPulled([])).not.toThrow()
		expect(() => stock.applyPulled(undefined)).not.toThrow()
	})
})

describe("stock held by queued sales", () => {
	let stock

	beforeEach(async () => {
		setActivePinia(createPinia())
		mocks.getOfflineInvoices
			.mockReset()
			.mockResolvedValue([sale("Main", 2), sale("Annex", 5)])

		stock = useStockStore()
		stock.init([{ item_code: "SKU", actual_qty: 10 }])
		stock.setWarehouse("Main")
		await flushPromises()
	})

	it("counts what is held in the warehouse in use", () => {
		expect(stock.getDisplayStock("SKU")).toBe(8)
	})

	it("is counted again when the settings change the warehouse", async () => {
		usePOSEventsStore().emit("settings:warehouse-changed", {
			newWarehouse: "Annex",
		})
		await flushPromises()

		expect(stock.queued.get("SKU")).toBe(5)
		expect(stock.getDisplayStock("SKU")).toBe(5)
	})

	it("is counted again when the profile sets the warehouse", async () => {
		stock.setWarehouse("Annex")
		await flushPromises()

		expect(stock.queued.get("SKU")).toBe(5)
	})

	it("drops the old warehouse's holds when the new one has none", async () => {
		stock.setWarehouse("Empty")
		await flushPromises()

		expect(stock.queued.has("SKU")).toBe(false)
		expect(stock.getDisplayStock("SKU")).toBe(10)
	})

	it("ends on the warehouse chosen last, however the reads finish", async () => {
		let finishFirst
		mocks.getOfflineInvoices.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve
				}),
		)

		stock.setWarehouse("Annex")
		await flushPromises()
		stock.setWarehouse("Main")
		await flushPromises()
		finishFirst([sale("Main", 2), sale("Annex", 5)])
		await flushPromises()

		expect(stock.queued.get("SKU")).toBe(2)
	})

	it("keeps the holds it has when the queue cannot be read", async () => {
		mocks.getOfflineInvoices.mockRejectedValue(new Error("database closed"))

		stock.setWarehouse("Annex")
		await flushPromises()

		expect(stock.queued.get("SKU")).toBe(2)
	})
})
