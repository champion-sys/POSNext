import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usesNativeLink } from "@/platform/printing/transport"
import { printerService } from "@/services/printerService"
import { useBluetoothPrinterStore } from "@/stores/bluetoothPrinter"
import AndroidPrinterPairing from "../AndroidPrinterPairing.vue"
import PrinterManagement from "../PrinterManagement.vue"

vi.mock("frappe-ui", () => ({
	Button: {
		template: "<button @click=\"$emit('click')\"><slot /></button>",
		emits: ["click"],
	},
}))

vi.mock("@/platform/printing/transport", async (importOriginal) => ({
	...(await importOriginal()),
	usesNativeLink: vi.fn(),
}))

vi.mock("@/services/printerService", () => ({
	printerService: {
		connectNative: vi.fn(),
		isConnected: vi.fn().mockReturnValue(false),
		listPairedPrinters: vi.fn(),
		registerOnDisconnect: vi.fn(),
		scanAndConnect: vi.fn(),
		tryAutoReconnect: vi.fn().mockResolvedValue(false),
	},
}))

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn().mockResolvedValue([]) }))
vi.mock("@/utils/escpos", () => ({ COMMANDS: {} }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ invoiceType: "Sales Invoice" }),
}))

function mountWith(component) {
	return mount(component, {
		global: {
			mocks: { __: (message) => message },
			stubs: { CheckboxField: true, SelectField: true },
		},
	})
}

function buttonNamed(wrapper, label) {
	return wrapper.findAll("button").find((button) => button.text() === label)
}

async function fillWifiForm(wrapper, { name, host, port }) {
	await buttonNamed(wrapper, "Add Wi-Fi Printer").trigger("click")
	const inputs = wrapper.findAll("input")
	await inputs[0].setValue(name)
	await inputs[1].setValue(host)
	await inputs[2].setValue(port)
	await buttonNamed(wrapper, "Add Printer").trigger("click")
	await flushPromises()
}

beforeEach(() => {
	localStorage.clear()
	setActivePinia(createPinia())
	vi.clearAllMocks()
	vi.stubGlobal("__", (message) => message)
})

describe("adding a Wi-Fi printer", () => {
	it("starts on the raw printing port", async () => {
		const wrapper = mountWith(AndroidPrinterPairing)

		await buttonNamed(wrapper, "Add Wi-Fi Printer").trigger("click")

		expect(wrapper.findAll("input")[2].element.value).toBe("9100")
	})

	it("saves a printer that answers", async () => {
		vi.mocked(printerService.connectNative).mockResolvedValue()
		const store = useBluetoothPrinterStore()
		const wrapper = mountWith(AndroidPrinterPairing)

		await fillWifiForm(wrapper, {
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})

		expect(printerService.connectNative).toHaveBeenCalledWith(
			"tcp:192.168.1.50:9100",
		)
		expect(store.printers).toHaveLength(1)
		expect(store.isConnected).toBe(true)
		expect(store.connectedDeviceId).toBe("tcp:192.168.1.50:9100")
	})

	it("saves nothing when the printer does not answer", async () => {
		vi.mocked(printerService.connectNative).mockRejectedValue(new Error("off"))
		const store = useBluetoothPrinterStore()
		const wrapper = mountWith(AndroidPrinterPairing)

		await fillWifiForm(wrapper, {
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})

		expect(store.printers).toHaveLength(0)
		expect(store.isConnected).toBe(false)
	})

	it("explains a bad form and never touches the network", async () => {
		const wrapper = mountWith(AndroidPrinterPairing)

		await fillWifiForm(wrapper, { name: "", host: "kitchen", port: 0 })

		expect(printerService.connectNative).not.toHaveBeenCalled()
		expect(wrapper.text()).toContain("Enter a name for the printer.")
		expect(wrapper.text()).toContain("Enter a valid IP address")
		expect(wrapper.text()).toContain("Enter a port between 1 and 65535.")
	})
})

describe("pairing a Bluetooth printer", () => {
	it("lists the paired devices and saves the chosen one", async () => {
		vi.mocked(printerService.listPairedPrinters).mockResolvedValue([
			{ id: "spp:AA", name: "MTP-II" },
		])
		vi.mocked(printerService.connectNative).mockResolvedValue()
		const store = useBluetoothPrinterStore()
		const wrapper = mountWith(AndroidPrinterPairing)

		await buttonNamed(wrapper, "Pair Bluetooth Printer").trigger("click")
		await flushPromises()
		await buttonNamed(wrapper, "Connect").trigger("click")
		await flushPromises()

		expect(store.activePrinter).toMatchObject({
			deviceId: "spp:AA",
			name: "MTP-II",
			type: "bluetooth",
		})
		expect(store.printMethod).toBe("image")
	})

	it("does not save the same printer twice", async () => {
		vi.mocked(printerService.listPairedPrinters).mockResolvedValue([
			{ id: "spp:AA", name: "MTP-II" },
		])
		vi.mocked(printerService.connectNative).mockResolvedValue()
		const store = useBluetoothPrinterStore()
		store.setSavedPrinter("spp:AA", "MTP-II", "bluetooth")
		const wrapper = mountWith(AndroidPrinterPairing)

		await buttonNamed(wrapper, "Pair Bluetooth Printer").trigger("click")
		await flushPromises()
		await buttonNamed(wrapper, "Connect").trigger("click")
		await flushPromises()

		expect(store.printers).toHaveLength(1)
	})

	it("saves nothing when the BLE scan is cancelled", async () => {
		vi.mocked(printerService.listPairedPrinters).mockResolvedValue([])
		vi.mocked(printerService.scanAndConnect).mockResolvedValue(null)
		const store = useBluetoothPrinterStore()
		const wrapper = mountWith(AndroidPrinterPairing)

		await buttonNamed(wrapper, "Pair Bluetooth Printer").trigger("click")
		await flushPromises()
		await buttonNamed(wrapper, "Scan for BLE Printers").trigger("click")
		await flushPromises()

		expect(store.printers).toHaveLength(0)
	})
})

describe("PrinterManagement", () => {
	function mountEnabled() {
		useBluetoothPrinterStore().isEnabled = 1
		return mountWith(PrinterManagement)
	}

	it("offers Bluetooth and Wi-Fi on Android, and no USB", () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)

		const wrapper = mountEnabled()

		expect(buttonNamed(wrapper, "Add Wi-Fi Printer")).toBeDefined()
		expect(buttonNamed(wrapper, "Pair Bluetooth Printer")).toBeDefined()
		expect(wrapper.text()).not.toContain("USB")
	})

	it("hides the USB delay on Android", () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		const store = useBluetoothPrinterStore()
		store.setSavedPrinter("spp:AA", "MTP-II", "bluetooth")

		const wrapper = mountEnabled()

		expect(wrapper.html()).not.toContain("USB Inter-chunk Delay")
	})

	it("keeps Bluetooth and USB on the web", () => {
		vi.mocked(usesNativeLink).mockReturnValue(false)

		const wrapper = mountEnabled()

		expect(buttonNamed(wrapper, "Pair USB Printer")).toBeDefined()
		expect(buttonNamed(wrapper, "Pair Bluetooth Printer")).toBeDefined()
		expect(buttonNamed(wrapper, "Add Wi-Fi Printer")).toBeUndefined()
	})

	it("shows where a Wi-Fi printer lives", () => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		useBluetoothPrinterStore().addNetworkPrinter({
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})

		const wrapper = mountEnabled()

		expect(wrapper.text()).toContain("192.168.1.50:9100")
		expect(wrapper.text()).toContain("Wi-Fi")
	})
})
