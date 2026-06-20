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

// Declare WebUSB types locally for typescript compiler compatibility
export interface USBDevice {
	opened: boolean
	vendorId: number
	productId: number
	serialNumber?: string
	productName?: string
	manufacturerName?: string
	configuration: any
	open(): Promise<void>
	close(): Promise<void>
	selectConfiguration(configurationValue: number): Promise<void>
	claimInterface(interfaceNumber: number): Promise<void>
	releaseInterface(interfaceNumber: number): Promise<void>
	transferOut(endpointNumber: number, data: BufferSource): Promise<any>
}

export class PrinterService {
	// Connection type state
	public activeType: "bluetooth" | "usb" | null = null

	// Bluetooth states
	private device: BluetoothDevice | null = null
	private server: BluetoothRemoteGATTServer | null = null
	private characteristic: BluetoothRemoteGATTCharacteristic | null = null

	// USB states
	private usbDevice: USBDevice | null = null
	private usbInterfaceNumber = -1
	private usbEndpointNumber = -1

	private onDisconnectCallback: (() => void) | null = null
	public queue: PrinterQueue

	constructor() {
		// Instantiate the queue binding to this instance worker method
		this.queue = new PrinterQueue(this.printRawInternal.bind(this))

		// Listen for USB device physical disconnections
		if (typeof navigator !== "undefined" && "usb" in navigator) {
			(navigator as any).usb.addEventListener("disconnect", (event: any) => {
				if (this.activeType === "usb" && this.usbDevice && event.device === this.usbDevice) {
					log.warn("USB device disconnected physically.")
					this.handleDisconnection()
				}
			})
		}
	}

	/**
	 * Checks if Web Bluetooth is supported in the current environment
	 */
	public isSupported(): boolean {
		return typeof window !== "undefined" && typeof navigator !== "undefined" && "bluetooth" in navigator
	}

	/**
	 * Checks if WebUSB is supported in the current environment
	 */
	public isUsbSupported(): boolean {
		return typeof window !== "undefined" && typeof navigator !== "undefined" && "usb" in navigator
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
	 * Scans for nearby USB printers and connects
	 */
	public async scanAndConnectUsb(): Promise<USBDevice> {
		if (!this.isUsbSupported()) {
			throw new Error("WebUSB is not supported in this browser.")
		}

		log.info("Requesting USB device...")
		let device: USBDevice

		try {
			device = await (navigator as any).usb.requestDevice({
				filters: [] // Empty filter so user can authorize any USB device
			})
		} catch (error) {
			log.error("USB device selection failed or cancelled:", error)
			throw error
		}

		await this.connectUsb(device)
		return device
	}

	/**
	 * Connects to a specific Bluetooth device
	 */
	public async connectToDevice(device: BluetoothDevice): Promise<void> {
		this.disconnect()

		this.device = device
		this.activeType = "bluetooth"
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
	 * Connects to a specific USB device
	 */
	public async connectUsb(device: USBDevice): Promise<void> {
		this.disconnect()

		this.usbDevice = device
		this.activeType = "usb"

		log.info(`Connecting to USB device: ${device.productName || device.serialNumber || "Unknown"}...`)
		await device.open()

		if (device.configuration === null) {
			await device.selectConfiguration(1)
		}

		// Find interface and bulk OUT endpoint
		let interfaceNumber = -1
		let endpointNumber = -1

		for (const iface of device.configuration.interfaces) {
			const alternate = iface.alternates[0]
			for (const endpoint of alternate.endpoints) {
				if (endpoint.direction === "out" && endpoint.type === "bulk") {
					interfaceNumber = iface.interfaceNumber
					endpointNumber = endpoint.endpointNumber
					break
				}
			}
			if (endpointNumber !== -1) break
		}

		if (interfaceNumber === -1 || endpointNumber === -1) {
			throw new Error("No bulk OUT endpoint found on this USB device. Ensure it is a compatible thermal printer.")
		}

		this.usbInterfaceNumber = interfaceNumber
		this.usbEndpointNumber = endpointNumber

		await device.claimInterface(interfaceNumber)
		log.info("USB device connected and interface claimed successfully.")
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
		if (this.activeType === "usb") {
			if (this.usbDevice && this.usbDevice.opened) {
				log.info("Disconnecting from USB device...")
				const dev = this.usbDevice
				const iface = this.usbInterfaceNumber
				dev.releaseInterface(iface)
					.then(() => dev.close())
					.catch((err: any) => log.warn("Error during USB connection cleanup:", err))
			}
		} else {
			if (this.device && this.device.gatt?.connected) {
				log.info("Disconnecting from Bluetooth device...")
				this.device.gatt.disconnect()
			}
		}
		this.cleanup()
	}

	/**
	 * Checks if currently connected
	 */
	public isConnected(): boolean {
		if (this.activeType === "usb") {
			return !!(this.usbDevice && this.usbDevice.opened)
		} else {
			return !!(this.device && this.device.gatt?.connected && this.characteristic)
		}
	}

	/**
	 * Get connected device name
	 */
	public getConnectedDeviceName(): string {
		if (this.activeType === "usb") {
			return this.usbDevice?.productName || this.usbDevice?.serialNumber || "USB Printer"
		}
		return this.device?.name || this.device?.id || ""
	}

	/**
	 * Get connected device ID
	 */
	public getConnectedDeviceId(): string {
		if (this.activeType === "usb" && this.usbDevice) {
			return `usb_${this.usbDevice.vendorId}_${this.usbDevice.productId}_${this.usbDevice.serialNumber || ""}`
		}
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
	 * Send raw byte data directly to the printer (Internal queue worker use only)
	 */
	private async printRawInternal(data: Uint8Array): Promise<void> {
		if (!this.isConnected()) {
			throw new Error("No printer connected.")
		}

		if (this.activeType === "usb") {
			if (!this.usbDevice || this.usbEndpointNumber === -1) {
				throw new Error("USB printer not configured.")
			}
			log.info(`Sending ${data.length} bytes to USB bulk OUT endpoint ${this.usbEndpointNumber}...`)
			
			let usbWriteDelay = 5
			try {
				if (typeof localStorage !== "undefined") {
					const activePrinterId = localStorage.getItem("pos_active_printer_id")
					const printersStr = localStorage.getItem("pos_printers")
					if (printersStr && activePrinterId) {
						const printers = JSON.parse(printersStr)
						const active = printers.find((p: any) => p.id === activePrinterId)
						if (active && active.usbWriteDelay !== undefined) {
							usbWriteDelay = parseInt(active.usbWriteDelay, 10)
						}
					}
				}
			} catch (e) {
				log.warn("Failed to retrieve usbWriteDelay configuration:", e)
			}

			// Bulk transfer using standard USB packet boundaries
			const maxPacketSize = 1024
			if (data.length > maxPacketSize) {
				for (let i = 0; i < data.length; i += maxPacketSize) {
					const chunk = data.slice(i, i + maxPacketSize)
					await this.usbDevice.transferOut(this.usbEndpointNumber, chunk as any)
					if (usbWriteDelay > 0) {
						await new Promise((resolve) => setTimeout(resolve, usbWriteDelay))
					}
				}
			} else {
				await this.usbDevice.transferOut(this.usbEndpointNumber, data as any)
			}
		} else {
			// Bluetooth path
			if (!this.characteristic) {
				throw new Error("Bluetooth printer characteristic is missing.")
			}
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
		}
		log.info("Print data sent successfully.")
	}

	/**
	 * Automatic reconnection flow using previously saved device ID
	 */
	public async tryAutoReconnect(savedId: string, type: "bluetooth" | "usb" = "bluetooth"): Promise<boolean> {
		if (!savedId) return false

		if (type === "usb") {
			if (!this.isUsbSupported()) return false
			try {
				const devices = await (navigator as any).usb.getDevices()
				const matched = devices.find((d: any) => {
					const id = `usb_${d.vendorId}_${d.productId}_${d.serialNumber || ""}`
					return id === savedId
				})
				if (matched) {
					log.info(`Found saved permitted USB device: ${matched.productName || matched.serialNumber}. Reconnecting...`)
					await this.connectUsb(matched)
					return true
				}
			} catch (error) {
				log.error("USB auto-reconnection failed:", error)
			}
		} else {
			if (!this.isSupported()) return false
			try {
				if ("getDevices" in navigator.bluetooth) {
					const devices = await (navigator.bluetooth as any).getDevices()
					const matched = devices.find((d: BluetoothDevice) => d.id === savedId)
					if (matched) {
						log.info(`Found saved permitted Bluetooth device: ${matched.name || matched.id}. Reconnecting...`)
						await this.connectToDevice(matched)
						return true
					}
				}
			} catch (error) {
				log.error("Bluetooth auto-reconnection failed:", error)
			}
		}
		return false
	}

	private handleDisconnection(): void {
		log.warn("Printer device disconnected.")
		this.cleanup()
		if (this.onDisconnectCallback) {
			this.onDisconnectCallback()
		}
	}

	private cleanup(): void {
		this.device = null
		this.server = null
		this.characteristic = null

		this.usbDevice = null
		this.usbInterfaceNumber = -1
		this.usbEndpointNumber = -1

		this.activeType = null
	}
}

// Export default instantiated singleton to prevent breaking existing imports
export const printerService = new PrinterService()
