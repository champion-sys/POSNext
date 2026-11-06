import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	BLE,
	CLASSIC,
	PRINTER_CHARACTERISTICS,
	PRINTER_SERVICES,
	WIFI,
	bleChunkSize,
	bluetoothDeviceId,
	bytesToBase64,
	createLink,
	findWritableCharacteristic,
	listPairedPrinters,
	parseDeviceId,
	scanForBlePrinter,
	selectBluetoothTransport,
	usesNativeLink,
	wifiDeviceId,
	writeInChunks,
} from "../printing/transport"

const pacing = { chunkSize: 4, writeDelay: 0 }
const writable = { write: true, writeWithoutResponse: false }
const unwritable = { write: false, writeWithoutResponse: false }

function service(uuid, characteristics) {
	return { uuid, characteristics }
}

function fakeBle(overrides = {}) {
	return {
		initialize: vi.fn().mockResolvedValue(),
		connect: vi.fn().mockResolvedValue(),
		disconnect: vi.fn().mockResolvedValue(),
		getServices: vi
			.fn()
			.mockResolvedValue([
				service(PRINTER_SERVICES[1], [
					{ uuid: PRINTER_CHARACTERISTICS[1], properties: writable },
				]),
			]),
		getMtu: vi.fn().mockResolvedValue(23),
		write: vi.fn().mockResolvedValue(),
		writeWithoutResponse: vi.fn().mockResolvedValue(),
		isEnabled: vi.fn().mockResolvedValue(true),
		requestEnable: vi.fn().mockResolvedValue(),
		setDisplayStrings: vi.fn().mockResolvedValue(),
		requestDevice: vi.fn(),
		...overrides,
	}
}

function fakeClassic(overrides = {}) {
	const plugin = {
		listener: null,
		handle: { remove: vi.fn().mockResolvedValue() },
		addListener: vi.fn(async (_event, listener) => {
			plugin.listener = listener
			return plugin.handle
		}),
		connect: vi.fn().mockResolvedValue(),
		disconnect: vi.fn().mockResolvedValue(),
		write: vi.fn().mockResolvedValue(),
		listBonded: vi.fn(),
		...overrides,
	}
	return plugin
}

function fakeTcp(overrides = {}) {
	return {
		probe: vi.fn().mockResolvedValue(),
		send: vi.fn().mockResolvedValue(),
		...overrides,
	}
}

beforeEach(() => {
	vi.stubGlobal("__", (message) => message)
})

describe("usesNativeLink", () => {
	it("is only for the Android app", () => {
		expect(usesNativeLink("android")).toBe(true)
		expect(usesNativeLink("web")).toBe(false)
		expect(usesNativeLink("electron")).toBe(false)
	})

	it("stays off in a browser build", () => {
		expect(usesNativeLink()).toBe(false)
	})
})

describe("selectBluetoothTransport", () => {
	it("sends BLE-only printers over BLE", () => {
		expect(selectBluetoothTransport({ type: "le" })).toBe(BLE)
	})

	it.each(["classic", "dual", "unknown"])(
		"sends %s printers over Classic",
		(type) => {
			expect(selectBluetoothTransport({ type })).toBe(CLASSIC)
		},
	)
})

describe("device IDs", () => {
	it("round-trips a Bluetooth printer", () => {
		const id = bluetoothDeviceId({
			address: "AA:BB:CC:DD:EE:FF",
			type: "classic",
		})

		expect(id).toBe("spp:AA:BB:CC:DD:EE:FF")
		expect(parseDeviceId(id)).toEqual({
			kind: CLASSIC,
			address: "AA:BB:CC:DD:EE:FF",
		})
	})

	it("round-trips a Wi-Fi printer", () => {
		const id = wifiDeviceId({ host: "192.168.1.50", port: 9100 })

		expect(id).toBe("tcp:192.168.1.50:9100")
		expect(parseDeviceId(id)).toMatchObject({
			kind: WIFI,
			host: "192.168.1.50",
			port: 9100,
		})
	})

	it("does not recognize an ID from the browser", () => {
		expect(parseDeviceId("usb_1208_514_")).toBeNull()
		expect(parseDeviceId("dGVzdA==")).toBeNull()
		expect(parseDeviceId("")).toBeNull()
		expect(parseDeviceId(undefined)).toBeNull()
	})
})

describe("findWritableCharacteristic", () => {
	it("prefers a known printer service", () => {
		const found = findWritableCharacteristic([
			service("0000aaaa-0000-1000-8000-00805f9b34fb", [
				{ uuid: "custom", properties: writable },
			]),
			service(PRINTER_SERVICES[2], [
				{ uuid: PRINTER_CHARACTERISTICS[2], properties: writable },
			]),
		])

		expect(found.service).toBe(PRINTER_SERVICES[2])
		expect(found.characteristic).toBe(PRINTER_CHARACTERISTICS[2])
	})

	it("matches UUIDs in any case", () => {
		const found = findWritableCharacteristic([
			service(PRINTER_SERVICES[0].toUpperCase(), [
				{
					uuid: PRINTER_CHARACTERISTICS[0].toUpperCase(),
					properties: writable,
				},
			]),
		])

		expect(found.service).toBe(PRINTER_SERVICES[0])
	})

	it("falls back to anything writable", () => {
		const found = findWritableCharacteristic([
			service("first", [{ uuid: "read-only", properties: unwritable }]),
			service("second", [
				{
					uuid: "open",
					properties: { write: false, writeWithoutResponse: true },
				},
			]),
		])

		expect(found).toEqual({
			service: "second",
			characteristic: "open",
			withoutResponse: true,
		})
	})

	it("finds nothing on a device that cannot be written to", () => {
		expect(
			findWritableCharacteristic([
				service("a", [{ uuid: "b", properties: unwritable }]),
			]),
		).toBeNull()
		expect(findWritableCharacteristic([])).toBeNull()
	})
})

describe("bleChunkSize", () => {
	it("keeps the configured size when it fits", () => {
		expect(bleChunkSize(128, 512)).toBe(128)
	})

	it("shrinks to one packet", () => {
		expect(bleChunkSize(128, 23)).toBe(20)
		expect(bleChunkSize(512, 100)).toBe(97)
	})

	it("stays safe when the plugin has no MTU yet", () => {
		expect(bleChunkSize(128, -1)).toBe(20)
	})
})

describe("bytesToBase64", () => {
	it("encodes bytes", () => {
		expect(bytesToBase64(new Uint8Array([0x1b, 0x40, 0xff]))).toBe("G0D/")
		expect(bytesToBase64(new Uint8Array())).toBe("")
	})

	it("handles a full raster receipt", () => {
		const bytes = new Uint8Array(300000).fill(0xaa)

		expect(atob(bytesToBase64(bytes))).toHaveLength(bytes.length)
	})
})

describe("writeInChunks", () => {
	it("sends every byte in order", async () => {
		const send = vi.fn().mockResolvedValue()

		await writeInChunks(
			new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
			pacing,
			send,
		)

		expect(send.mock.calls.map(([chunk]) => [...chunk])).toEqual([
			[1, 2, 3, 4],
			[5, 6, 7, 8],
			[9],
		])
	})

	it("stops at the first failure", async () => {
		const send = vi.fn().mockRejectedValue(new Error("gone"))

		await expect(
			writeInChunks(new Uint8Array(10), pacing, send),
		).rejects.toThrow("gone")
		expect(send).toHaveBeenCalledTimes(1)
	})
})

describe("createLink", () => {
	it("refuses an ID it cannot read", () => {
		expect(() => createLink("usb_1_2_", vi.fn(), {})).toThrow("paired again")
	})

	it("tells Bluetooth from network printers", () => {
		const plugins = {
			BleClient: fakeBle(),
			ClassicPrinter: fakeClassic(),
			TcpPrinter: fakeTcp(),
		}

		expect(createLink("ble:AA", vi.fn(), plugins).printerType).toBe("bluetooth")
		expect(createLink("spp:AA", vi.fn(), plugins).printerType).toBe("bluetooth")
		expect(createLink("tcp:10.0.0.9:9100", vi.fn(), plugins).printerType).toBe(
			"network",
		)
	})

	it("starts disconnected", () => {
		const link = createLink("spp:AA", vi.fn(), {
			ClassicPrinter: fakeClassic(),
		})

		expect(link.isConnected()).toBe(false)
		expect(link.deviceId).toBe("spp:AA")
	})
})

describe("BLE link", () => {
	it("keeps each write within one packet", async () => {
		const BleClient = fakeBle()
		const link = createLink("ble:AA", vi.fn(), { BleClient })

		await link.connect()
		await link.write(new Uint8Array(50), { chunkSize: 128, writeDelay: 0 })

		expect(BleClient.initialize).toHaveBeenCalledWith({
			androidNeverForLocation: true,
		})
		expect(
			BleClient.write.mock.calls.map(([, , , value]) => value.byteLength),
		).toEqual([20, 20, 10])
	})

	it("writes without response when the printer offers it", async () => {
		const BleClient = fakeBle({
			getServices: vi
				.fn()
				.mockResolvedValue([
					service(PRINTER_SERVICES[0], [
						{
							uuid: PRINTER_CHARACTERISTICS[0],
							properties: { write: true, writeWithoutResponse: true },
						},
					]),
				]),
		})
		const link = createLink("ble:AA", vi.fn(), { BleClient })

		await link.connect()
		await link.write(new Uint8Array(4), pacing)

		expect(BleClient.writeWithoutResponse).toHaveBeenCalledOnce()
		expect(BleClient.write).not.toHaveBeenCalled()
	})

	it("hangs up on a device with nothing to write to", async () => {
		const BleClient = fakeBle({ getServices: vi.fn().mockResolvedValue([]) })
		const link = createLink("ble:AA", vi.fn(), { BleClient })

		await expect(link.connect()).rejects.toThrow("does not accept print data")
		expect(BleClient.disconnect).toHaveBeenCalledWith("AA")
		expect(link.isConnected()).toBe(false)
	})

	it("reports a printer that goes away", async () => {
		const BleClient = fakeBle()
		const onDrop = vi.fn()
		const link = createLink("ble:AA", onDrop, { BleClient })

		await link.connect()
		BleClient.connect.mock.calls[0][1]("AA")

		expect(onDrop).toHaveBeenCalledOnce()
		expect(link.isConnected()).toBe(false)
	})

	it("stays quiet when the app hangs up itself", async () => {
		const BleClient = fakeBle()
		const onDrop = vi.fn()
		const link = createLink("ble:AA", onDrop, { BleClient })

		await link.connect()
		await link.disconnect()
		BleClient.connect.mock.calls[0][1]("AA")

		expect(onDrop).not.toHaveBeenCalled()
	})

	it("shows the cashier a readable reason", async () => {
		const BleClient = fakeBle({
			connect: vi.fn().mockRejectedValue(new Error("gatt status 133")),
		})
		const link = createLink("ble:AA", vi.fn(), { BleClient })

		await expect(link.connect()).rejects.toThrow(
			"Check that it is on and in range",
		)
	})
})

describe("Classic link", () => {
	it("sends base64 chunks at the configured size", async () => {
		const ClassicPrinter = fakeClassic()
		const link = createLink("spp:AA", vi.fn(), { ClassicPrinter })

		await link.connect()
		await link.write(new Uint8Array([1, 2, 3, 4, 5]), pacing)

		expect(ClassicPrinter.connect).toHaveBeenCalledWith({ address: "AA" })
		expect(
			ClassicPrinter.write.mock.calls.map(([options]) => options.data),
		).toEqual([
			bytesToBase64(new Uint8Array([1, 2, 3, 4])),
			bytesToBase64(new Uint8Array([5])),
		])
	})

	it("cleans up after a failed connection", async () => {
		const ClassicPrinter = fakeClassic({
			connect: vi.fn().mockRejectedValue(new Error("refused")),
		})
		const link = createLink("spp:AA", vi.fn(), { ClassicPrinter })

		await expect(link.connect()).rejects.toThrow(
			"Check that it is on and in range",
		)
		expect(ClassicPrinter.handle.remove).toHaveBeenCalledOnce()
		expect(link.isConnected()).toBe(false)
	})

	it("reports only its own printer going away", async () => {
		const ClassicPrinter = fakeClassic()
		const onDrop = vi.fn()
		const link = createLink("spp:AA", onDrop, { ClassicPrinter })

		await link.connect()
		ClassicPrinter.listener({ address: "BB" })
		expect(onDrop).not.toHaveBeenCalled()

		ClassicPrinter.listener({ address: "AA" })
		expect(onDrop).toHaveBeenCalledOnce()
		expect(link.isConnected()).toBe(false)
	})

	it("stays quiet when the app hangs up itself", async () => {
		const ClassicPrinter = fakeClassic()
		const onDrop = vi.fn()
		const link = createLink("spp:AA", onDrop, { ClassicPrinter })

		await link.connect()
		await link.disconnect()
		ClassicPrinter.listener({ address: "AA" })

		expect(ClassicPrinter.disconnect).toHaveBeenCalledOnce()
		expect(onDrop).not.toHaveBeenCalled()
	})
})

describe("Wi-Fi link", () => {
	const deviceId = "tcp:192.168.1.50:9100"

	it("checks that the printer answers before calling it connected", async () => {
		const TcpPrinter = fakeTcp()
		const link = createLink(deviceId, vi.fn(), { TcpPrinter })

		await link.connect()

		expect(TcpPrinter.probe).toHaveBeenCalledWith(
			expect.objectContaining({ host: "192.168.1.50", port: 9100 }),
		)
		expect(link.isConnected()).toBe(true)
	})

	it("stays disconnected when nothing answers", async () => {
		const TcpPrinter = fakeTcp({
			probe: vi.fn().mockRejectedValue(new Error("timeout")),
		})
		const link = createLink(deviceId, vi.fn(), { TcpPrinter })

		await expect(link.connect()).rejects.toThrow("Could not reach the printer")
		expect(link.isConnected()).toBe(false)
	})

	it("sends a job whole, with no pacing", async () => {
		const TcpPrinter = fakeTcp()
		const link = createLink(deviceId, vi.fn(), { TcpPrinter })
		const bytes = new Uint8Array(1000).fill(7)

		await link.connect()
		await link.write(bytes, pacing)

		expect(TcpPrinter.send).toHaveBeenCalledOnce()
		expect(TcpPrinter.send).toHaveBeenCalledWith({
			host: "192.168.1.50",
			port: 9100,
			data: bytesToBase64(bytes),
		})
	})

	it("stays usable after a failed job, for the queue to retry", async () => {
		const TcpPrinter = fakeTcp({
			send: vi.fn().mockRejectedValue(new Error("reset")),
		})
		const link = createLink(deviceId, vi.fn(), { TcpPrinter })

		await link.connect()
		await expect(link.write(new Uint8Array(1), pacing)).rejects.toThrow(
			"Could not reach the printer",
		)

		expect(link.isConnected()).toBe(true)
	})
})

describe("listPairedPrinters", () => {
	it("picks the transport for each device", async () => {
		const ClassicPrinter = fakeClassic({
			listBonded: vi.fn().mockResolvedValue({
				devices: [
					{ address: "AA", name: "MTP-II", type: "classic" },
					{ address: "BB", name: "BLE Printer", type: "le" },
					{ address: "CC", type: "unknown" },
				],
			}),
		})

		await expect(
			listPairedPrinters({ BleClient: fakeBle(), ClassicPrinter }),
		).resolves.toEqual([
			{ id: "spp:AA", name: "MTP-II" },
			{ id: "ble:BB", name: "BLE Printer" },
			{ id: "spp:CC", name: "CC" },
		])
	})

	it("asks for Bluetooth to be turned on", async () => {
		const BleClient = fakeBle({ isEnabled: vi.fn().mockResolvedValue(false) })
		const ClassicPrinter = fakeClassic({
			listBonded: vi.fn().mockResolvedValue({ devices: [] }),
		})

		await listPairedPrinters({ BleClient, ClassicPrinter })

		expect(BleClient.requestEnable).toHaveBeenCalledOnce()
	})

	it("explains a refused permission", async () => {
		const BleClient = fakeBle({
			initialize: vi.fn().mockRejectedValue(new Error("Permission denied.")),
		})

		await expect(
			listPairedPrinters({ BleClient, ClassicPrinter: fakeClassic() }),
		).rejects.toThrow("nearby devices")
	})
})

describe("scanForBlePrinter", () => {
	it("returns the chosen printer", async () => {
		const BleClient = fakeBle({
			requestDevice: vi
				.fn()
				.mockResolvedValue({ deviceId: "AA", name: "BLE Printer" }),
		})

		await expect(scanForBlePrinter({ BleClient })).resolves.toEqual({
			id: "ble:AA",
			name: "BLE Printer",
		})
		expect(BleClient.requestDevice).toHaveBeenCalledWith({
			optionalServices: PRINTER_SERVICES,
		})
	})

	it("treats cancelling as no choice", async () => {
		const BleClient = fakeBle({
			requestDevice: vi
				.fn()
				.mockRejectedValue(new Error("requestDevice cancelled.")),
		})

		await expect(scanForBlePrinter({ BleClient })).resolves.toBeNull()
	})

	it("reports a failed scan", async () => {
		const BleClient = fakeBle({
			requestDevice: vi.fn().mockRejectedValue(new Error("scan failed")),
		})

		await expect(scanForBlePrinter({ BleClient })).rejects.toThrow(
			"Could not scan",
		)
	})
})
