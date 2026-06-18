import { logger } from "../utils/logger"

const log = logger.create("PrinterService")

// Common UUIDs for Bluetooth Thermal Printers
const PRINTER_SERVICE_UUID = "000018f0-0000-1000-8000-00805f9b34fb"
const PRINTER_CHARACTERISTIC_UUID = "00002af1-0000-1000-8000-00805f9b34fb"

export class PrinterService {
	private static device: BluetoothDevice | null = null
	private static server: BluetoothRemoteGATTServer | null = null
	private static characteristic: BluetoothRemoteGATTCharacteristic | null = null
	private static onDisconnectCallback: (() => void) | null = null

	/**
	 * Checks if Web Bluetooth is supported in the current environment
	 */
	public static isSupported(): boolean {
		return typeof window !== "undefined" && typeof navigator !== "undefined" && "bluetooth" in navigator
	}

	/**
	 * Scans for nearby Bluetooth printers and connects
	 */
	public static async scanAndConnect(): Promise<BluetoothDevice> {
		if (!this.isSupported()) {
			throw new Error("Web Bluetooth is not supported in this browser.")
		}

		log.info("Requesting Bluetooth device...")
		let device: BluetoothDevice

		try {
			// Try filtering for common printer services first
			device = await navigator.bluetooth.requestDevice({
				filters: [
					{ services: [PRINTER_SERVICE_UUID] },
					{ namePrefix: "Printer" },
					{ namePrefix: "POS" },
					{ namePrefix: "MTP" },
					{ namePrefix: "Thermal" },
					{ namePrefix: "QS" },
				],
				optionalServices: [PRINTER_SERVICE_UUID],
			})
		} catch (error) {
			log.warn("Filtered scan failed or cancelled, trying fallback all devices", error)
			// Fallback: Show all devices to maximize compatibility
			device = await navigator.bluetooth.requestDevice({
				acceptAllDevices: true,
				optionalServices: [PRINTER_SERVICE_UUID],
			})
		}

		await this.connectToDevice(device)
		return device
	}

	/**
	 * Connects to a specific Bluetooth device
	 */
	public static async connectToDevice(device: BluetoothDevice): Promise<void> {
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
			try {
				const service = await this.server.getPrimaryService(PRINTER_SERVICE_UUID)
				this.characteristic = await service.getCharacteristic(PRINTER_CHARACTERISTIC_UUID)
				log.info("Printer service and characteristic found successfully.")
			} catch (err) {
				log.warn("Standard printer service UUID not found. Scanning all services...", err)
				// Fallback: discover any writeable characteristic in available primary services
				const services = await this.server.getPrimaryServices()
				let found = false

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
	public static registerOnDisconnect(callback: () => void): void {
		this.onDisconnectCallback = callback
	}

	/**
	 * Disconnects from the current device
	 */
	public static disconnect(): void {
		if (this.device && this.device.gatt?.connected) {
			log.info("Disconnecting from Bluetooth device...")
			this.device.gatt.disconnect()
		}
		this.cleanup()
	}

	/**
	 * Checks if currently connected
	 */
	public static isConnected(): boolean {
		return !!(this.device && this.device.gatt?.connected && this.characteristic)
	}

	/**
	 * Get connected device name
	 */
	public static getConnectedDeviceName(): string {
		return this.device?.name || this.device?.id || ""
	}

	/**
	 * Get connected device ID
	 */
	public static getConnectedDeviceId(): string {
		return this.device?.id || ""
	}

	/**
	 * Send raw byte data to the printer in chunks to avoid MTU buffer overflow
	 */
	public static async printRaw(data: Uint8Array): Promise<void> {
		if (!this.isConnected() || !this.characteristic) {
			throw new Error("No printer connected.")
		}

		log.info(`Sending ${data.length} bytes to printer...`)
		// Standard Bluetooth Low Energy MTU payload chunk size is typically safe at 20-512 bytes.
		// Using 128 bytes chunking to ensure compatibility with most POS Bluetooth printers.
		const chunkSize = 128
		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.slice(i, i + chunkSize)
			if (this.characteristic.properties.writeWithoutResponse) {
				await this.characteristic.writeValueWithoutResponse(chunk)
			} else {
				await this.characteristic.writeValue(chunk)
			}
			// Small delay to allow printer buffer to process chunk
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		log.info("Print data sent successfully.")
	}

	/**
	 * Automatic reconnection flow using previously saved device ID
	 * Note: Browsers require prior user interaction/permission.
	 * In Web Bluetooth, we can retrieve previously permitted devices using getDevices().
	 */
	public static async tryAutoReconnect(savedId: string): Promise<boolean> {
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

	private static handleDisconnection(): void {
		log.warn("Bluetooth device disconnected.")
		this.cleanup()
		if (this.onDisconnectCallback) {
			this.onDisconnectCallback()
		}
	}

	private static cleanup(): void {
		this.device = null
		this.server = null
		this.characteristic = null
	}
}
