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

	// Actions
	function setSavedPrinter(id, name) {
		savedPrinterId.value = id
		savedPrinterName.value = name
	}

	function clearSavedPrinter() {
		savedPrinterId.value = ""
		savedPrinterName.value = ""
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
		setSavedPrinter,
		clearSavedPrinter,
		setConnected,
		setPrintMethod,
	}
})
