import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return {
		printSystemHTML: vi.fn(async () => {}),
		platform: { current: "electron" },
	}
})

vi.mock("@/platform/printing/system", () => ({
	printSystemHTML: mocks.printSystemHTML,
}))
vi.mock("@/platform/runtime", async (importOriginal) => ({
	...(await importOriginal()),
	get PLATFORM() {
		return mocks.platform.current
	},
}))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/utils/offline/sync", () => ({
	getOfflineInvoiceByOfflineId: vi.fn(),
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))
vi.mock("@/utils/qzTray", () => ({ printHTML: vi.fn() }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))

const { printInvoiceCustom } = await import("../printInvoice")

const draft = {
	name: "DRAFT-1",
	items: [{ item_code: "SKU", item_name: "Tea", qty: 1, rate: 5, amount: 5 }],
	payments: [],
	grand_total: 5,
	customer_name: "Sara",
	status: "Draft",
}

describe("printing a local receipt", () => {
	beforeEach(() => {
		mocks.printSystemHTML.mockClear()
		vi.spyOn(window, "open").mockReturnValue(null)
	})

	afterEach(() => {
		mocks.platform.current = "electron"
		vi.restoreAllMocks()
	})

	it("goes to the system printer on desktop, where new windows are denied", async () => {
		await printInvoiceCustom(draft)

		expect(window.open).not.toHaveBeenCalled()
		expect(mocks.printSystemHTML).toHaveBeenCalled()
		expect(mocks.printSystemHTML.mock.calls[0][0]).toContain("Tea")
	})

	it("passes a printer failure on to whoever asked", async () => {
		mocks.printSystemHTML.mockRejectedValueOnce(new Error("Printer offline"))

		await expect(printInvoiceCustom(draft)).rejects.toThrow("Printer offline")
	})

	it("still opens a window on the web", () => {
		mocks.platform.current = "web"

		expect(() => printInvoiceCustom(draft)).toThrow("Popup blocked")
		expect(window.open).toHaveBeenCalled()
		expect(mocks.printSystemHTML).not.toHaveBeenCalled()
	})
})
