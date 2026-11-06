/**
 * Printing through the operating system, in the desktop app.
 *
 * @module platform/printing/system
 */

const SYSTEM_PRINTER_KEY = "pos_next_system_printer"

/** @returns {string} The default printer, or empty to ask each time */
export function getSystemPrinter() {
	return localStorage.getItem(SYSTEM_PRINTER_KEY) || ""
}

/** @param {string} name - Printer name, or empty to ask each time */
export function saveSystemPrinter(name) {
	if (name) {
		localStorage.setItem(SYSTEM_PRINTER_KEY, name)
	} else {
		localStorage.removeItem(SYSTEM_PRINTER_KEY)
	}
}

/** @returns {Promise<Array<{name: string, displayName?: string, isDefault?: boolean}>>} */
export function listSystemPrinters() {
	return window.electronAPI.getPrinters()
}

/**
 * Print a document. With no saved printer, Electron shows the system's printer dialog.
 * @param {string} html
 */
export function printSystemHTML(html) {
	return window.electronAPI.printReceipt(html, getSystemPrinter())
}
