import { defineStore } from "pinia"
import { ref, watch, computed } from "vue"

export const useBluetoothPrinterStore = defineStore("bluetoothPrinter", () => {
	// Migration helper
	const loadInitialPrinters = () => {
		try {
			const saved = localStorage.getItem("pos_printers")
			if (saved) {
				return JSON.parse(saved)
			}
		} catch (error) {
			console.error("Failed to parse pos_printers:", error)
		}

		// Fallback migration
		const oldId = localStorage.getItem("pos_bt_printer_id")
		const oldName = localStorage.getItem("pos_bt_printer_name")
		if (oldId) {
			const migrated = {
				id: oldId,
				name: oldName || "Bluetooth Printer",
				type: "bluetooth",
				paperSize: localStorage.getItem("pos_bt_paper_size") || "58",
				printMethod: localStorage.getItem("pos_bt_print_method") || "image",
				chunkSize: parseInt(localStorage.getItem("pos_bt_chunk_size") || "128", 10),
				writeDelay: parseInt(localStorage.getItem("pos_bt_write_delay") || "10", 10),
				lineFeedsAfterPrint: parseInt(localStorage.getItem("pos_bt_line_feeds_after_print") || "3", 10),
				isDefault: true
			}
			localStorage.setItem("pos_printers", JSON.stringify([migrated]))
			localStorage.setItem("pos_active_printer_id", oldId)
			return [migrated]
		}
		return []
	}

	// State
	const isEnabled = ref(localStorage.getItem("pos_bt_printer_enabled") === "1" ? 1 : 0)
	const printers = ref(loadInitialPrinters())
	const activePrinterId = ref(localStorage.getItem("pos_active_printer_id") || "")
	const connectedDeviceId = ref("")
	const isConnected = ref(false)
	const enableQueuePersistence = ref(localStorage.getItem("pos_bt_queue_persistence") === "0" ? 0 : 1)

	// Fallback to first/default printer if activePrinterId is not set
	if (!activePrinterId.value && printers.value.length > 0) {
		const defaultPrinter = printers.value.find(p => p.isDefault) || printers.value[0]
		activePrinterId.value = defaultPrinter.id
	}

	// Watchers
	watch(isEnabled, (newVal) => {
		localStorage.setItem("pos_bt_printer_enabled", newVal === 1 ? "1" : "0")
	})

	watch(enableQueuePersistence, (newVal) => {
		localStorage.setItem("pos_bt_queue_persistence", newVal === 1 ? "1" : "0")
	})

	watch(activePrinterId, (newVal) => {
		if (newVal) {
			localStorage.setItem("pos_active_printer_id", newVal)
		} else {
			localStorage.removeItem("pos_active_printer_id")
		}
	})

	watch(printers, (newVal) => {
		localStorage.setItem("pos_printers", JSON.stringify(newVal))
	}, { deep: true })

	// Computed active printer
	const activePrinter = computed(() => {
		return printers.value.find(p => p.id === activePrinterId.value) || printers.value.find(p => p.isDefault) || printers.value[0] || null
	})

	// Backwards-compatible computed fields mapping to the active printer
	const savedPrinterId = computed({
		get: () => activePrinter.value?.id || "",
		set: (val) => {
			activePrinterId.value = val
		}
	})

	const savedPrinterName = computed({
		get: () => activePrinter.value?.name || "",
		set: (val) => {
			if (activePrinter.value) activePrinter.value.name = val
		}
	})

	const paperSize = computed({
		get: () => activePrinter.value?.paperSize || "58",
		set: (val) => {
			if (activePrinter.value) activePrinter.value.paperSize = val
		}
	})

	const printMethod = computed({
		get: () => activePrinter.value?.printMethod || "image",
		set: (val) => {
			if (activePrinter.value) activePrinter.value.printMethod = val
		}
	})

	const chunkSize = computed({
		get: () => activePrinter.value?.chunkSize || 128,
		set: (val) => {
			if (activePrinter.value) activePrinter.value.chunkSize = val
		}
	})

	const writeDelay = computed({
		get: () => activePrinter.value?.writeDelay ?? 10,
		set: (val) => {
			if (activePrinter.value) activePrinter.value.writeDelay = val
		}
	})

	const lineFeedsAfterPrint = computed({
		get: () => activePrinter.value?.lineFeedsAfterPrint ?? 3,
		set: (val) => {
			if (activePrinter.value) activePrinter.value.lineFeedsAfterPrint = val
		}
	})

	// Actions
	function setSavedPrinter(id, name, type = "bluetooth") {
		let existing = printers.value.find(p => p.id === id)
		if (!existing) {
			existing = {
				id,
				name,
				type,
				paperSize: "58",
				printMethod: "image",
				chunkSize: 128,
				writeDelay: 10,
				lineFeedsAfterPrint: 3,
				isDefault: printers.value.length === 0
			}
			printers.value.push(existing)
		} else {
			existing.name = name
			existing.type = type
		}
		activePrinterId.value = id
	}

	function clearSavedPrinter() {
		const idToRemove = activePrinterId.value
		if (idToRemove) {
			removePrinter(idToRemove)
		}
	}

	function setPrinterConfig(config) {
		if (!activePrinter.value) return
		if (config.chunkSize !== undefined) activePrinter.value.chunkSize = config.chunkSize
		if (config.writeDelay !== undefined) activePrinter.value.writeDelay = config.writeDelay
		if (config.lineFeedsAfterPrint !== undefined) activePrinter.value.lineFeedsAfterPrint = parseInt(config.lineFeedsAfterPrint, 10)
	}

	function setConnected(deviceId, connectedState) {
		connectedDeviceId.value = deviceId
		isConnected.value = connectedState
	}

	function setPrintMethod(method) {
		if (activePrinter.value && (method === "image" || method === "text")) {
			activePrinter.value.printMethod = method
		}
	}

	function addPrinter(printer) {
		printers.value.push(printer)
		if (printer.isDefault || printers.value.length === 1) {
			setDefaultPrinter(printer.id)
		}
	}

	function removePrinter(id) {
		const wasActive = activePrinterId.value === id
		const wasDefault = printers.value.find(p => p.id === id)?.isDefault
		printers.value = printers.value.filter(p => p.id !== id)
		if (printers.value.length > 0) {
			if (wasDefault) {
				printers.value[0].isDefault = true
			}
			if (wasActive) {
				const defaultPrinter = printers.value.find(p => p.isDefault) || printers.value[0]
				activePrinterId.value = defaultPrinter.id
			}
		} else {
			activePrinterId.value = ""
		}
	}

	function setDefaultPrinter(id) {
		printers.value.forEach(p => {
			p.isDefault = p.id === id
		})
		activePrinterId.value = id
	}

	function setActivePrinter(id) {
		activePrinterId.value = id
	}

	return {
		isEnabled,
		printers,
		activePrinterId,
		activePrinter,
		connectedDeviceId,
		isConnected,
		enableQueuePersistence,
		
		// Computed fields
		savedPrinterId,
		savedPrinterName,
		paperSize,
		printMethod,
		chunkSize,
		writeDelay,
		lineFeedsAfterPrint,

		// Actions
		setSavedPrinter,
		clearSavedPrinter,
		setPrinterConfig,
		setConnected,
		setPrintMethod,
		addPrinter,
		removePrinter,
		setDefaultPrinter,
		setActivePrinter
	}
})
