import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usesNativeLink } from "@/platform/printing/transport"
import { printerService } from "../../services/printerService"
import { useBluetoothPrinterStore } from "../../stores/bluetoothPrinter"
import { printInvoiceToAllPrinters } from "../escpos"

vi.mock("@/platform/printing/transport", async (importOriginal) => ({
	...(await importOriginal()),
	usesNativeLink: vi.fn(),
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

const invoice = {
	name: "OFFLINE-1",
	company: "Sanad",
	items: [],
	payments: [],
	grand_total: 10,
}

function savePrinterWithoutFormat() {
	const store = useBluetoothPrinterStore()
	store.isEnabled = 1
	store.addNetworkPrinter({ name: "Counter", host: "192.168.1.50", port: 9100 })
	store.setPrintMethod("text")
	return store
}

describe("a printer with no target print format", () => {
	beforeEach(() => {
		localStorage.clear()
		setActivePinia(createPinia())
		vi.clearAllMocks()
		vi.mocked(printerService.getConnectedDeviceId).mockReturnValue(
			"tcp:192.168.1.50:9100",
		)
		vi.mocked(printerService.isConnected).mockReturnValue(true)
		vi.mocked(printerService.printRaw).mockResolvedValue()
	})

	it("prints the local receipt on Android, which has no other way to print", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		savePrinterWithoutFormat()

		await printInvoiceToAllPrinters(invoice)

		expect(printerService.printRaw).toHaveBeenCalledOnce()
	})

	it("is skipped in the browser, as before", async () => {
		vi.mocked(usesNativeLink).mockReturnValue(false)
		savePrinterWithoutFormat()

		await printInvoiceToAllPrinters(invoice)

		expect(printerService.printRaw).not.toHaveBeenCalled()
	})
})
