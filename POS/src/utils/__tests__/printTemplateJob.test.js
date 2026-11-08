import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return {
		platform: { current: "electron" },
		qzPrintHTML: vi.fn(async () => true),
		markPrinted: vi.fn(async () => {}),
	}
})

vi.mock("@/platform/runtime", async (importOriginal) => ({
	...(await importOriginal()),
	get PLATFORM() {
		return mocks.platform.current
	},
}))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/utils/offline/sync", () => ({ getOfflineInvoiceByOfflineId: vi.fn() }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: { markOfflineInvoicePrinted: mocks.markPrinted } }))
vi.mock("@/utils/qzTray", () => ({ printHTML: mocks.qzPrintHTML }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))

const { printTemplateJob } = await import("../printInvoice")

const job = { template: { name: "PT-0001" }, html: "<html><body><p>R</p></body></html>", paper: "58mm", copies: 2 }

describe("printing a rendered template", () => {
	beforeEach(() => {
		window.electronAPI = { printReceipt: vi.fn(async () => ({ success: true })) }
		localStorage.setItem("pos_next_system_printer", "XP-58")
	})

	afterEach(() => {
		mocks.platform.current = "electron"
		vi.restoreAllMocks()
		vi.clearAllMocks()
		localStorage.clear()
	})

	it("sends the template's paper and copies to the desktop printer", async () => {
		await printTemplateJob(job, { invoiceName: "pos_offline_1" })

		expect(window.electronAPI.printReceipt).toHaveBeenCalledWith(job.html, "XP-58", { paper: "58mm", copies: 2 })
		expect(mocks.markPrinted).toHaveBeenCalledWith("pos_offline_1")
	})

	it("gives QZ Tray the template's width and copies", async () => {
		mocks.platform.current = "web"

		await printTemplateJob({ ...job, paper: "A4", copies: 1 }, { silent: true })

		expect(mocks.qzPrintHTML).toHaveBeenCalledWith(job.html, null, { width: 210, height: 297, copies: 1 })
		await printTemplateJob(job, { silent: true })
		expect(mocks.qzPrintHTML).toHaveBeenLastCalledWith(job.html, null, { width: 58, height: null, copies: 2 })
	})

	it("opens the browser's dialog with every copy when QZ Tray fails", async () => {
		mocks.platform.current = "web"
		mocks.qzPrintHTML.mockRejectedValueOnce(new Error("QZ Tray is not available"))
		const written = []
		const popup = { document: { write: (html) => written.push(html), close: vi.fn() }, print: vi.fn() }
		vi.spyOn(window, "open").mockReturnValue(popup)

		await printTemplateJob(job, { silent: true })

		expect(window.open).toHaveBeenCalled()
		expect(written[0].match(/<p>R<\/p>/g)).toHaveLength(2)
	})

	it("prints through the browser's dialog on the web without silent printing", async () => {
		mocks.platform.current = "web"
		vi.spyOn(window, "open").mockReturnValue(null)

		await expect(printTemplateJob(job, {})).rejects.toThrow("Popup blocked")
		expect(mocks.qzPrintHTML).not.toHaveBeenCalled()
	})

	it("leaves the built-in receipt's call as it was", async () => {
		const { printSystemHTML } = await import("@/platform/printing/system")

		await printSystemHTML("<p>built-in</p>")

		expect(window.electronAPI.printReceipt).toHaveBeenCalledWith("<p>built-in</p>", "XP-58")
	})
})
