import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usesNativeLink } from "@/platform/printing/transport"
import { prepareTemplatePrint } from "@/platform/printing/templatePrint"
import { htmlToRasterCanvas } from "@/platform/printing/rasterize"
import { printerService } from "../../services/printerService"
import { useBluetoothPrinterStore } from "../../stores/bluetoothPrinter"
import { printInvoiceToAllPrinters } from "../escpos"

vi.mock("@/platform/printing/transport", async (importOriginal) => ({
	...(await importOriginal()),
	usesNativeLink: vi.fn(),
}))
vi.mock("@/platform/printing/templatePrint", () => ({ prepareTemplatePrint: vi.fn() }))
vi.mock("@/platform/printing/rasterize", async (importOriginal) => ({
	...(await importOriginal()),
	htmlToRasterCanvas: vi.fn(),
}))
vi.mock("../apiWrapper", () => ({ call: vi.fn() }))
vi.mock("../../stores/posSettings", () => ({ usePOSSettingsStore: vi.fn() }))
vi.mock("../../services/printerService", () => ({
	printerService: {
		getConnectedDeviceId: vi.fn(),
		isConnected: vi.fn(),
		printRaw: vi.fn(),
		tryAutoReconnect: vi.fn(),
	},
}))

const invoice = { name: "pos_offline_1", pos_profile: "Main POS", items: [], payments: [], grand_total: 10 }

const job = (paper = "80mm", copies = 2) => ({
	template: { name: "PT-0001" },
	html: "<!DOCTYPE html><html><body>receipt</body></html>",
	paper,
	copies,
})

function blankCanvas(width, height) {
	const data = new Uint8ClampedArray(width * height * 4).fill(255)
	return { width, height, getContext: () => ({ getImageData: () => ({ data }) }) }
}

function savePrinter({ paperSize = "80", printTemplate = "", printFormat = "" } = {}) {
	const store = useBluetoothPrinterStore()
	store.isEnabled = 1
	store.addNetworkPrinter({ name: "Counter", host: "192.168.1.50", port: 9100 })
	store.paperSize = paperSize
	store.printTemplate = printTemplate
	store.printFormat = printFormat
	return store
}

describe("a template on an ESC/POS printer", () => {
	beforeEach(() => {
		localStorage.clear()
		setActivePinia(createPinia())
		vi.clearAllMocks()
		vi.mocked(printerService.getConnectedDeviceId).mockReturnValue("tcp:192.168.1.50:9100")
		vi.mocked(printerService.isConnected).mockReturnValue(true)
		vi.mocked(printerService.printRaw).mockResolvedValue()
		vi.mocked(htmlToRasterCanvas).mockImplementation(async (_html, { rasterWidth }) => blankCanvas(rasterWidth, 40))
	})

	it("is drawn 576 dots wide on an 80mm roll and sent once per copy", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(job("80mm", 2))
		savePrinter({ paperSize: "80", printTemplate: "PT-0001" })

		await printInvoiceToAllPrinters(invoice, { profile: "Main POS" })

		expect(prepareTemplatePrint).toHaveBeenCalledWith(invoice, { profile: "Main POS", printerTemplate: "PT-0001" })
		expect(htmlToRasterCanvas).toHaveBeenCalledWith(job().html, { cssWidth: 302, rasterWidth: 576 })
		expect(printerService.printRaw).toHaveBeenCalledTimes(2)
		const bytes = vi.mocked(printerService.printRaw).mock.calls[0][0]
		expect(Array.from(bytes.slice(2, 8))).toEqual([0x1d, 0x76, 0x30, 0, 72, 0])
	})

	it("is drawn 384 dots wide on a 58mm roll", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(job("58mm", 1))
		savePrinter({ paperSize: "58" })

		await printInvoiceToAllPrinters(invoice, {})

		expect(htmlToRasterCanvas).toHaveBeenCalledWith(job().html, { cssWidth: 219, rasterWidth: 384 })
		const bytes = vi.mocked(printerService.printRaw).mock.calls[0][0]
		expect(bytes[6]).toBe(48)
	})

	it("prints on a browser printer that has no print format", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(false)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(job("80mm", 1))
		savePrinter()

		await printInvoiceToAllPrinters(invoice, {})

		expect(printerService.printRaw).toHaveBeenCalledOnce()
	})

	it("falls back to the built-in receipt when the page cannot be drawn", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(job("80mm", 2))
		vi.mocked(htmlToRasterCanvas).mockRejectedValue(new Error("no canvas"))
		const store = savePrinter()
		store.setPrintMethod("text")

		await printInvoiceToAllPrinters(invoice, {})

		// The template was tried first
		expect(htmlToRasterCanvas).toHaveBeenCalledOnce()
		// One job: the built-in text receipt, not the template's two copies
		expect(printerService.printRaw).toHaveBeenCalledOnce()
		expect(vi.mocked(printerService.printRaw).mock.calls[0][0][2]).not.toBe(0x1d)
	})

	it("leaves the built-in receipt alone when no template applies", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(null)
		const store = savePrinter()
		store.setPrintMethod("text")

		await printInvoiceToAllPrinters(invoice, {})

		expect(htmlToRasterCanvas).not.toHaveBeenCalled()
		expect(printerService.printRaw).toHaveBeenCalledOnce()
	})

	it("renders once for printers that share a template", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(prepareTemplatePrint).mockResolvedValue(job("80mm", 1))
		const store = savePrinter()
		store.addNetworkPrinter({ name: "Kitchen", host: "192.168.1.51", port: 9100 })
		vi.mocked(printerService.tryAutoReconnect).mockResolvedValue(true)

		await printInvoiceToAllPrinters(invoice, {})

		expect(prepareTemplatePrint).toHaveBeenCalledOnce()
		expect(printerService.printRaw).toHaveBeenCalledTimes(2)
	})
})
