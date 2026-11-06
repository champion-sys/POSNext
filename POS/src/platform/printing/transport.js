/**
 * How printer bytes leave the Android app: Bluetooth LE, Bluetooth Classic or Wi-Fi.
 *
 * printerService holds one link at a time and sends through it. A WebView has neither
 * Web Bluetooth nor WebUSB, and the browser keeps using those instead of this file.
 * The saved device ID names the transport, so the shared print routing needs no changes.
 *
 * @module platform/printing/transport
 */

import * as capacitor from "@/platform/capacitor"
import { logger } from "@/utils/logger"
import { ANDROID, PLATFORM } from "../runtime"

const log = logger.create("PrinterTransport")

// Common UUIDs for Bluetooth Thermal Printers
export const PRINTER_SERVICES = [
	"000018f0-0000-1000-8000-00805f9b34fb",
	"0000ffe0-0000-1000-8000-00805f9b34fb",
	"49535343-fe7d-4ae5-8fa9-9fafd205e455",
]

export const PRINTER_CHARACTERISTICS = [
	"00002af1-0000-1000-8000-00805f9b34fb",
	"0000ffe1-0000-1000-8000-00805f9b34fb",
	"49535343-8841-43f4-a8d4-ecbe34729bb3",
]

export const BLE = "ble"
export const CLASSIC = "spp"
export const WIFI = "tcp"

const CONNECT_TIMEOUT_MS = 10000
const WIFI_PROBE_TIMEOUT_MS = 3000
const BASE64_SLICE = 0x8000
const ATT_HEADER_BYTES = 3
const MIN_BLE_PAYLOAD = 20

/**
 * @param {string} [platform]
 * @returns {boolean} Whether printing goes through the native links here
 */
export function usesNativeLink(platform = PLATFORM) {
	return platform === ANDROID
}

/**
 * @param {{address: string, type: string}} device - A device paired in Android's settings
 * @returns {string} The ID saved with the printer
 */
export function bluetoothDeviceId(device) {
	return `${selectBluetoothTransport(device)}:${device.address}`
}

/**
 * @param {{host: string, port: number}} printer
 * @returns {string} The ID saved with the printer
 */
export function wifiDeviceId({ host, port }) {
	return `${WIFI}:${host}:${port}`
}

/**
 * @param {string} deviceId
 * @returns {{kind: string, address: string, host?: string, port?: number}|null}
 */
export function parseDeviceId(deviceId) {
	const match = /^(ble|spp|tcp):(.+)$/.exec(deviceId ?? "")
	if (!match) return null

	const [, kind, address] = match
	if (kind !== WIFI) return { kind, address }

	const separator = address.lastIndexOf(":")
	return {
		kind,
		address,
		host: address.slice(0, separator),
		port: Number(address.slice(separator + 1)),
	}
}

/**
 * Dual-mode printers go over Classic, usually the faster and steadier of the two.
 * @param {{address: string, type: string}} device - A device paired in Android's settings
 * @returns {string} The transport for it
 */
export function selectBluetoothTransport(device) {
	return device.type === "le" ? BLE : CLASSIC
}

/**
 * @param {Array} services - Services from the BLE plugin
 * @returns {{service: string, characteristic: string, withoutResponse: boolean}|null}
 *   A known printer characteristic, or any other one that can be written to
 */
export function findWritableCharacteristic(services) {
	const writable = services.flatMap((service) =>
		service.characteristics
			.filter(
				({ properties }) => properties.write || properties.writeWithoutResponse,
			)
			.map(({ uuid, properties }) => ({
				service: service.uuid.toLowerCase(),
				characteristic: uuid.toLowerCase(),
				withoutResponse: properties.writeWithoutResponse,
			})),
	)

	const known = PRINTER_SERVICES.flatMap((service, index) =>
		writable.filter(
			(found) =>
				found.service === service &&
				found.characteristic === PRINTER_CHARACTERISTICS[index],
		),
	)
	return known[0] ?? writable[0] ?? null
}

/**
 * A BLE write has to fit in one packet: the MTU, less the ATT header.
 * @param {number} configured - The chunk size in the printer's settings
 * @param {number} mtu - The negotiated MTU
 * @returns {number}
 */
export function bleChunkSize(configured, mtu) {
	return Math.min(configured, Math.max(mtu - ATT_HEADER_BYTES, MIN_BLE_PAYLOAD))
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
	let binary = ""
	for (let offset = 0; offset < bytes.length; offset += BASE64_SLICE) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + BASE64_SLICE),
		)
	}
	return btoa(binary)
}

/**
 * @param {Uint8Array} bytes
 * @param {{chunkSize: number, writeDelay: number}} pacing
 * @param {(chunk: Uint8Array) => Promise<void>} send
 */
export async function writeInChunks(bytes, { chunkSize, writeDelay }, send) {
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		await send(bytes.subarray(offset, offset + chunkSize))
		if (writeDelay > 0) {
			await new Promise((resolve) => setTimeout(resolve, writeDelay))
		}
	}
}

/** Plugins report in English, which the cashier should not have to read. */
async function withMessage(action, message) {
	try {
		return await action()
	} catch (error) {
		log.warn(message, error)
		throw new Error(message)
	}
}

function bleLink({ address }, onDrop, { BleClient }) {
	let target = null
	let mtu = 0

	return {
		async connect() {
			await withMessage(async () => {
				await BleClient.initialize({ androidNeverForLocation: true })
				await BleClient.connect(
					address,
					() => {
						if (!target) return
						target = null
						onDrop()
					},
					{ timeout: CONNECT_TIMEOUT_MS },
				)
			}, __(
				"Could not connect to the printer. Check that it is on and in range.",
			))

			const found = findWritableCharacteristic(
				await BleClient.getServices(address),
			)
			if (!found) {
				await BleClient.disconnect(address)
				throw new Error(__("This Bluetooth device does not accept print data."))
			}
			mtu = await BleClient.getMtu(address)
			target = found
		},

		isConnected: () => target !== null,

		async write(bytes, { chunkSize, writeDelay }) {
			const { service, characteristic, withoutResponse } = target
			await withMessage(
				() =>
					writeInChunks(
						bytes,
						{ chunkSize: bleChunkSize(chunkSize, mtu), writeDelay },
						(chunk) => {
							const value = new DataView(
								chunk.buffer,
								chunk.byteOffset,
								chunk.byteLength,
							)
							return withoutResponse
								? BleClient.writeWithoutResponse(
										address,
										service,
										characteristic,
										value,
									)
								: BleClient.write(address, service, characteristic, value)
						},
					),
				__("Could not send to the printer."),
			)
		},

		async disconnect() {
			target = null
			await BleClient.disconnect(address)
		},
	}
}

function classicLink({ address }, onDrop, { ClassicPrinter }) {
	let connected = false
	let listener = null

	return {
		async connect() {
			listener = await ClassicPrinter.addListener("disconnected", (event) => {
				if (!connected || event.address !== address) return
				connected = false
				listener.remove()
				onDrop()
			})
			try {
				await withMessage(
					() => ClassicPrinter.connect({ address }),
					__(
						"Could not connect to the printer. Check that it is on and in range.",
					),
				)
			} catch (error) {
				listener.remove()
				throw error
			}
			connected = true
		},

		isConnected: () => connected,

		async write(bytes, pacing) {
			await withMessage(
				() =>
					writeInChunks(bytes, pacing, (chunk) =>
						ClassicPrinter.write({ data: bytesToBase64(chunk) }),
					),
				__("Could not send to the printer."),
			)
		},

		async disconnect() {
			connected = false
			await listener?.remove()
			await ClassicPrinter.disconnect()
		},
	}
}

/**
 * Holds no socket: TcpPrinter opens one per job, so a printer that is off shows up
 * as a failed job for the queue to retry, and needs no reconnecting afterwards.
 */
function wifiLink({ host, port }, _onDrop, { TcpPrinter }) {
	let confirmed = false

	return {
		async connect() {
			await withMessage(
				() =>
					TcpPrinter.probe({
						host,
						port,
						connectTimeoutMs: WIFI_PROBE_TIMEOUT_MS,
					}),
				__("Could not reach the printer at {0}:{1}.", [host, port]),
			)
			confirmed = true
		},

		isConnected: () => confirmed,

		async write(bytes) {
			await withMessage(
				() => TcpPrinter.send({ host, port, data: bytesToBase64(bytes) }),
				__("Could not reach the printer at {0}:{1}.", [host, port]),
			)
		},

		async disconnect() {
			confirmed = false
		},
	}
}

const LINKS = { [BLE]: bleLink, [CLASSIC]: classicLink, [WIFI]: wifiLink }

/**
 * @param {string} deviceId - The printer's saved ID
 * @param {() => void} onDrop - Called when the printer goes away by itself
 * @param {Object} [plugins] - The Capacitor plugins
 * @returns {{deviceId: string, printerType: string, connect: Function, isConnected: Function,
 *   write: Function, disconnect: Function}} Not connected yet
 */
export function createLink(deviceId, onDrop, plugins = capacitor) {
	const target = parseDeviceId(deviceId)
	if (!target) {
		throw new Error(__("This printer needs to be paired again."))
	}

	return {
		deviceId,
		printerType: target.kind === WIFI ? "network" : "bluetooth",
		...LINKS[target.kind](target, onDrop, plugins),
	}
}

/** Bluetooth must be on before a list of printers means anything. */
async function ensureBluetoothOn({ BleClient }) {
	await withMessage(
		() => BleClient.initialize({ androidNeverForLocation: true }),
		__("Allow access to nearby devices to use a Bluetooth printer."),
	)
	if (!(await BleClient.isEnabled())) {
		await withMessage(
			() => BleClient.requestEnable(),
			__("Turn on Bluetooth to use a Bluetooth printer."),
		)
	}
}

/**
 * @param {Object} [plugins] - The Capacitor plugins
 * @returns {Promise<Array<{id: string, name: string}>>} The devices paired in Android's settings
 */
export async function listPairedPrinters(plugins = capacitor) {
	await ensureBluetoothOn(plugins)

	const { devices } = await withMessage(
		() => plugins.ClassicPrinter.listBonded(),
		__("Could not read the paired Bluetooth devices."),
	)
	return devices.map((device) => ({
		id: bluetoothDeviceId(device),
		name: device.name || device.address,
	}))
}

/**
 * Show Android's list of BLE printers in range.
 * @param {Object} [plugins] - The Capacitor plugins
 * @returns {Promise<{id: string, name: string}|null>} The choice, or null if cancelled
 */
export async function scanForBlePrinter(plugins = capacitor) {
	await ensureBluetoothOn(plugins)

	const { BleClient } = plugins
	await BleClient.setDisplayStrings({
		scanning: __("Scanning..."),
		cancel: __("Cancel"),
		availableDevices: __("Available devices"),
		noDeviceFound: __("No printer found"),
	})

	try {
		const device = await BleClient.requestDevice({
			optionalServices: PRINTER_SERVICES,
		})
		return {
			id: bluetoothDeviceId({ address: device.deviceId, type: "le" }),
			name: device.name || device.deviceId,
		}
	} catch (error) {
		if (/cancelled/.test(error.message)) return null
		log.warn("BLE scan failed", error)
		throw new Error(__("Could not scan for Bluetooth printers."))
	}
}

/** Open Android's settings, where a Classic printer gets paired with its PIN. */
export function openBluetoothSettings({ BleClient } = capacitor) {
	return BleClient.openBluetoothSettings()
}
