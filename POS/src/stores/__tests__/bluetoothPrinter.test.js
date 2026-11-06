import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"
import { useBluetoothPrinterStore } from "../bluetoothPrinter"

describe("network printers", () => {
	beforeEach(() => {
		localStorage.clear()
		setActivePinia(createPinia())
	})

	it("saves a Wi-Fi printer and makes it active", () => {
		const store = useBluetoothPrinterStore()

		const id = store.addNetworkPrinter({
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})

		expect(store.activePrinterId).toBe(id)
		expect(store.activePrinter).toMatchObject({
			type: "network",
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
			deviceId: "tcp:192.168.1.50:9100",
		})
	})

	it("keeps printing Arabic as an image", () => {
		const store = useBluetoothPrinterStore()

		store.addNetworkPrinter({
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})

		expect(store.printMethod).toBe("image")
	})

	it("survives a restart", async () => {
		const store = useBluetoothPrinterStore()
		store.addNetworkPrinter({
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9100,
		})
		await nextTick()

		setActivePinia(createPinia())

		expect(useBluetoothPrinterStore().printers[0]).toMatchObject({
			type: "network",
			host: "192.168.1.50",
		})
	})
})
