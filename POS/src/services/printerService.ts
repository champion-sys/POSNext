import { logger } from "../utils/logger"
import { PrinterQueue, PrintJobPriority } from "./printerQueue"

const log = logger.create("PrinterService")

// Common UUIDs for Bluetooth Thermal Printers
const PRINTER_SERVICES = [
	"000018f0-0000-1000-8000-00805f9b34fb",
	"0000ffe0-0000-1000-8000-00805f9b34fb",
	"49535343-fe7d-4ae5-8fa9-9fafd205e455",
]

const PRINTER_CHARACTERISTICS = [
	"00002af1-0000-1000-8000-00805f9b34fb",
	"0000ffe1-0000-1000-8000-00805f9b34fb",
	"49535343-8841-43f4-a8d4-ecbe34729bb3",
]

export class PrinterService {
	private device: BluetoothDevice | null = null
	private server: BluetoothRemoteGATTServer | null = null
	private characteristic: BluetoothRemoteGATTCharacteristic | null = null
	private onDisconnectCallback: (() => void) | null = null
	public queue: PrinterQueue

	constructor() {
		// Instantiate the queue binding to this instance worker method
		this.queue = new PrinterQueue(this.printRawInternal.bind(this))
	}

	/**
	 * Checks if Web Bluetooth is supported in the current environment
	 */
	public isSupported(): boolean {
		return typeof window !== "undefined" && typeof navigator !== "undefined" && "bluetooth" in navigator
	}

	/**
	 * Scans for nearby Bluetooth printers and connects
	 */
	public async scanAndConnect(): Promise<BluetoothDevice> {
		if (!this.isSupported()) {
			throw new Error("Web Bluetooth is not supported in this browser.")
		}

		log.info("Requesting Bluetooth device...")
		let device: BluetoothDevice

		try {
			// Try filtering for common printer services first
			const filters = [
				...PRINTER_SERVICES.map(service => ({ services: [service] })),
				{ namePrefix: "Printer" },
				{ namePrefix: "POS" },
				{ namePrefix: "MTP" },
				{ namePrefix: "Thermal" },
				{ namePrefix: "QS" },
			]

			device = await navigator.bluetooth.requestDevice({
				filters,
				optionalServices: PRINTER_SERVICES,
			})
		} catch (error) {
			log.warn("Filtered scan failed or cancelled, trying fallback all devices", error)
			// Fallback: Show all devices to maximize compatibility
			device = await navigator.bluetooth.requestDevice({
				acceptAllDevices: true,
				optionalServices: PRINTER_SERVICES,
			})
		}

		await this.connectToDevice(device)
		return device
	}

	/**
	 * Connects to a specific Bluetooth device
	 */
	public async connectToDevice(device: BluetoothDevice): Promise<void> {
		this.disconnect()

		this.device = device
		device.addEventListener("gattserverdisconnected", this.handleDisconnection.bind(this))

		log.info(`Connecting to GATT server on ${device.name || device.id}...`)
		if (!device.gatt) {
			throw new Error("GATT is not available on this device.")
		}

		// Implement connection timeout (10 seconds)
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Connection timed out after 10 seconds")), 10000)
		)

		const connectPromise = async () => {
			this.server = await device.gatt!.connect()
			log.info("GATT server connected. Discovering services...")

			// Try to find the printer service and characteristic
			let found = false
			for (let i = 0; i < PRINTER_SERVICES.length; i++) {
				try {
					const serviceUuid = PRINTER_SERVICES[i]
					const charUuid = PRINTER_CHARACTERISTICS[i]
					const service = await this.server.getPrimaryService(serviceUuid)
					this.characteristic = await service.getCharacteristic(charUuid)
					log.info(`Printer service (${serviceUuid}) and characteristic (${charUuid}) found successfully.`)
					found = true
					break
				} catch (err) {
					// Try next service/characteristic pair
				}
			}

			if (!found) {
				log.warn("Standard printer service UUIDs not found. Scanning all services...")
				// Fallback: discover any writeable characteristic in available primary services
				const services = await this.server.getPrimaryServices()

				for (const service of services) {
					try {
						const characteristics = await service.getCharacteristics()
						for (const char of characteristics) {
							if (char.properties.write || char.properties.writeWithoutResponse) {
								this.characteristic = char
								found = true
								log.info(`Found writeable characteristic: ${char.uuid} on service ${service.uuid}`)
								break
							}
						}
					} catch (e) {
						log.warn(`Could not read characteristics from service ${service.uuid}`, e)
					}
					if (found) break
				}

				if (!found) {
					throw new Error("Could not find a writeable characteristic for the printer.")
				}
			}
		}

		await Promise.race([connectPromise(), timeoutPromise])
	}

	/**
	 * Sets a callback function when disconnection occurs
	 */
	public registerOnDisconnect(callback: () => void): void {
		this.onDisconnectCallback = callback
	}

	/**
	 * Disconnects from the current device
	 */
	public disconnect(): void {
		if (this.device && this.device.gatt?.connected) {
			log.info("Disconnecting from Bluetooth device...")
			this.device.gatt.disconnect()
		}
		this.cleanup()
	}

	/**
	 * Checks if currently connected
	 */
	public isConnected(): boolean {
		return !!(this.device && this.device.gatt?.connected && this.characteristic)
	}

	/**
	 * Get connected device name
	 */
	public getConnectedDeviceName(): string {
		return this.device?.name || this.device?.id || ""
	}

	/**
	 * Get connected device ID
	 */
	public getConnectedDeviceId(): string {
		return this.device?.id || ""
	}

	/**
	 * Get the active PrinterQueue instance
	 */
	public getQueue(): PrinterQueue {
		return this.queue
	}

	/**
	 * Send raw byte data to the printer by adding it to the execution queue
	 */
	public async printRaw(data: Uint8Array, priority: PrintJobPriority = "normal"): Promise<void> {
		const job = this.queue.enqueue(data, priority)
		return this.queue.waitForJob(job.id)
	}

	/**
	 * Send raw byte data directly to the printer in chunks (Internal queue worker use only)
	 */
	private async printRawInternal(data: Uint8Array): Promise<void> {
		if (!this.isConnected() || !this.characteristic) {
			throw new Error("No printer connected.")
		}

		// Retrieve chunk size and delay from settings/localStorage
		const chunkSize = parseInt(localStorage.getItem("pos_bt_chunk_size") || "128", 10)
		const writeDelay = parseInt(localStorage.getItem("pos_bt_write_delay") || "10", 10)

		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.slice(i, i + chunkSize)
			if (this.characteristic.properties.writeWithoutResponse) {
				await this.characteristic.writeValueWithoutResponse(chunk)
			} else {
				await this.characteristic.writeValue(chunk)
			}
			
			// Small delay to prevent buffer overrun on the printer side
			if (writeDelay > 0) {
				await new Promise((resolve) => setTimeout(resolve, writeDelay))
			}
		}
		log.info("Print data sent successfully.")
	}

	/**
	 * Automatic reconnection flow using previously saved device ID
	 * Note: Browsers require prior user interaction/permission.
	 * In Web Bluetooth, we can retrieve previously permitted devices using getDevices().
	 */
	public async tryAutoReconnect(savedId: string): Promise<boolean> {
		if (!this.isSupported() || !savedId) return false

		try {
			// getDevices() is supported in modern Chrome/Edge to list permitted devices
			if ("getDevices" in navigator.bluetooth) {
				const devices = await (navigator.bluetooth as any).getDevices()
				const matched = devices.find((d: BluetoothDevice) => d.id === savedId)
				if (matched) {
					log.info(`Found saved permitted device: ${matched.name || matched.id}. Reconnecting...`)
					await this.connectToDevice(matched)
					return true
				}
			}
		} catch (error) {
			log.error("Auto-reconnection failed:", error)
		}
		return false
	}

	private handleDisconnection(): void {
		log.warn("Bluetooth device disconnected.")
		this.cleanup()
		if (this.onDisconnectCallback) {
			this.onDisconnectCallback()
		}
	}

	private cleanup(): void {
		this.device = null
		this.server = null
		this.characteristic = null
	}
}

// Export default instantiated singleton to prevent breaking existing imports
export const printerService = new PrinterService()
