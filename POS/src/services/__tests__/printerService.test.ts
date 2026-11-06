import { beforeEach, describe, expect, it, vi } from "vitest"
import { createLink, usesNativeLink } from "@/platform/printing/transport"
import { PrinterService } from "../printerService"

vi.mock("@/platform/printing/transport", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createLink: vi.fn(),
	usesNativeLink: vi.fn(),
}))

vi.mock("@/utils/offline/db", () => ({
	db: {
		table: () => ({
			put: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			toArray: vi.fn().mockResolvedValue([]),
		}),
	},
}))

function fakeLink(deviceId = "tcp:192.168.1.50:9100", printerType = "network") {
	let connected = false
	return {
		deviceId,
		printerType,
		connect: vi.fn(async () => {
			connected = true
		}),
		isConnected: () => connected,
		write: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn(async () => {
			connected = false
		}),
	}
}

describe("PrinterService on Android", () => {
	beforeEach(() => {
		vi.mocked(usesNativeLink).mockReturnValue(true)
		vi.mocked(createLink).mockReset()
		localStorage.clear()
	})

	it("sends through the link, behind the queue", async () => {
		const link = fakeLink()
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()
		const bytes = new Uint8Array([1, 2, 3])

		await service.connectNative(link.deviceId)
		await service.printRaw(bytes)

		expect(link.write).toHaveBeenCalledWith(bytes, {
			chunkSize: 128,
			writeDelay: 10,
		})
		expect(service.queue.getJobs().at(-1)?.status).toBe("completed")
	})

	it("uses the active printer's pacing", async () => {
		localStorage.setItem("pos_active_printer_id", "p1")
		localStorage.setItem(
			"pos_printers",
			JSON.stringify([{ id: "p1", chunkSize: 64, writeDelay: 5 }]),
		)
		const link = fakeLink()
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()

		await service.connectNative(link.deviceId)
		await service.printRaw(new Uint8Array([1]))

		expect(link.write).toHaveBeenCalledWith(expect.anything(), {
			chunkSize: 64,
			writeDelay: 5,
		})
	})

	it("reports the connection from the link", async () => {
		const link = fakeLink()
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()

		expect(service.isConnected()).toBe(false)

		await service.connectNative(link.deviceId)

		expect(service.isConnected()).toBe(true)
		expect(service.getConnectedDeviceId()).toBe(link.deviceId)
		expect(service.activeType).toBe("network")
	})

	it("closes the old link before opening the next", async () => {
		const events: string[] = []
		const first = fakeLink("spp:AA", "bluetooth")
		const second = fakeLink("spp:BB", "bluetooth")
		first.disconnect.mockImplementation(async () => {
			await Promise.resolve()
			events.push("closed first")
		})
		second.connect.mockImplementation(async () => {
			events.push("opened second")
		})
		vi.mocked(createLink).mockReturnValueOnce(first).mockReturnValueOnce(second)
		const service = new PrinterService()

		await service.connectNative(first.deviceId)
		await service.connectNative(second.deviceId)

		expect(events).toEqual(["closed first", "opened second"])
	})

	it("reconnects a saved printer of any type", async () => {
		const link = fakeLink()
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()

		await expect(
			service.tryAutoReconnect(link.deviceId, "network"),
		).resolves.toBe(true)
		expect(createLink).toHaveBeenCalledWith(link.deviceId, expect.any(Function))
	})

	it("reports a printer it could not reconnect", async () => {
		const link = fakeLink()
		link.connect.mockRejectedValue(new Error("off"))
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()

		await expect(
			service.tryAutoReconnect(link.deviceId, "bluetooth"),
		).resolves.toBe(false)
		expect(service.isConnected()).toBe(false)
	})

	it("tells the app when the printer goes away", async () => {
		const link = fakeLink("spp:AA", "bluetooth")
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()
		const onDisconnect = vi.fn()
		service.registerOnDisconnect(onDisconnect)

		await service.connectNative(link.deviceId)
		vi.mocked(createLink).mock.calls[0][1]()

		expect(onDisconnect).toHaveBeenCalledOnce()
		expect(service.isConnected()).toBe(false)
		expect(service.activeType).toBeNull()
	})

	it("ignores a late drop from a link it already replaced", async () => {
		const first = fakeLink("spp:AA", "bluetooth")
		const second = fakeLink("spp:BB", "bluetooth")
		vi.mocked(createLink).mockReturnValueOnce(first).mockReturnValueOnce(second)
		const service = new PrinterService()

		await service.connectNative(first.deviceId)
		await service.connectNative(second.deviceId)
		vi.mocked(createLink).mock.calls[0][1]()

		expect(service.getConnectedDeviceId()).toBe(second.deviceId)
		expect(service.isConnected()).toBe(true)
	})

	it("closes the link on disconnect", async () => {
		const link = fakeLink()
		vi.mocked(createLink).mockReturnValue(link)
		const service = new PrinterService()

		await service.connectNative(link.deviceId)
		service.disconnect()

		expect(link.disconnect).toHaveBeenCalledOnce()
		expect(service.isConnected()).toBe(false)
	})
})

describe("PrinterService in the browser", () => {
	beforeEach(() => {
		vi.mocked(usesNativeLink).mockReturnValue(false)
		vi.mocked(createLink).mockReset()
	})

	it("never opens a native link", async () => {
		const service = new PrinterService()

		await expect(
			service.tryAutoReconnect("some-web-id", "bluetooth"),
		).resolves.toBe(false)
		expect(createLink).not.toHaveBeenCalled()
	})

	it("keeps asking the browser for Bluetooth support", () => {
		expect(new PrinterService().isSupported()).toBe("bluetooth" in navigator)
	})
})
