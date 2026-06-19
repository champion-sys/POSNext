import { defineStore } from "pinia"
import { ref, watch } from "vue"

export const useBluetoothPrinterStore = defineStore("bluetoothPrinter", () => {
	// State
	const isEnabled = ref(localStorage.getItem("pos_bt_printer_enabled") === "1" ? 1 : 0)
	const paperSize = ref(localStorage.getItem("pos_bt_paper_size") || "58") // '58' or '80'
	const savedPrinterId = ref(localStorage.getItem("pos_bt_printer_id") || "")
	const savedPrinterName = ref(localStorage.getItem("pos_bt_printer_name") || "")
	const printMethod = ref(localStorage.getItem("pos_bt_print_method") || "image") // 'image' or 'text'
	const connectedDeviceId = ref("")
	const isConnected = ref(false)

	// New settings for delay, chunk size, and queue persistence
	const chunkSize = ref(parseInt(localStorage.getItem("pos_bt_chunk_size") || "128", 10))
	const writeDelay = ref(parseInt(localStorage.getItem("pos_bt_write_delay") || "10", 10))
	const enableQueuePersistence = ref(localStorage.getItem("pos_bt_queue_persistence") === "0" ? 0 : 1) // Default to 1 (enabled)
	const lineFeedsAfterPrint = ref(parseInt(localStorage.getItem("pos_bt_line_feeds_after_print") || "3", 10))

	// Watchers to persist values in localStorage
	watch(isEnabled, (newVal) => {
		localStorage.setItem("pos_bt_printer_enabled", newVal === 1 ? "1" : "0")
	})

	watch(paperSize, (newVal) => {
		localStorage.setItem("pos_bt_paper_size", newVal)
	})

	watch(savedPrinterId, (newVal) => {
		if (newVal) {
			localStorage.setItem("pos_bt_printer_id", newVal)
		} else {
			localStorage.removeItem("pos_bt_printer_id")
		}
	})

	watch(savedPrinterName, (newVal) => {
		if (newVal) {
			localStorage.setItem("pos_bt_printer_name", newVal)
		} else {
			localStorage.removeItem("pos_bt_printer_name")
		}
	})

	watch(printMethod, (newVal) => {
		localStorage.setItem("pos_bt_print_method", newVal)
	})

	watch(chunkSize, (newVal) => {
		localStorage.setItem("pos_bt_chunk_size", newVal.toString())
	})

	watch(writeDelay, (newVal) => {
		localStorage.setItem("pos_bt_write_delay", newVal.toString())
	})

	watch(enableQueuePersistence, (newVal) => {
		localStorage.setItem("pos_bt_queue_persistence", newVal === 1 ? "1" : "0")
	})

	watch(lineFeedsAfterPrint, (newVal) => {
		localStorage.setItem("pos_bt_line_feeds_after_print", newVal.toString())
	})

	// Actions
	function setSavedPrinter(id, name) {
		savedPrinterId.value = id
		savedPrinterName.value = name
	}

	function clearSavedPrinter() {
		savedPrinterId.value = ""
		savedPrinterName.value = ""
	}

	// Make sure we have setter functions to update the configuration
	function setPrinterConfig(config) {
		if (config.chunkSize !== undefined) chunkSize.value = config.chunkSize
		if (config.writeDelay !== undefined) writeDelay.value = config.writeDelay
		if (config.enableQueuePersistence !== undefined) enableQueuePersistence.value = config.enableQueuePersistence ? 1 : 0
		if (config.lineFeedsAfterPrint !== undefined) lineFeedsAfterPrint.value = parseInt(config.lineFeedsAfterPrint, 10)
	}

	function setConnected(deviceId, connectedState) {
		connectedDeviceId.value = deviceId
		isConnected.value = connectedState
	}

	function setPrintMethod(method) {
		if (method === "image" || method === "text") {
			printMethod.value = method
		}
	}

	return {
		isEnabled,
		paperSize,
		savedPrinterId,
		savedPrinterName,
		printMethod,
		connectedDeviceId,
		isConnected,
		chunkSize,
		writeDelay,
		enableQueuePersistence,
		lineFeedsAfterPrint,
		setSavedPrinter,
		clearSavedPrinter,
		setConnected,
		setPrintMethod,
		setPrinterConfig,
	}
})
