// Adapted from BrainWise-DEV/POSNext, branch feature/electron-desktop, commit 661d32f.
const { BrowserWindow } = require("electron")

/**
 * Native Printing Module for Electron Desktop POS.
 *
 * Replaces QZ Tray with Electron's built-in printing capabilities.
 * Supports both thermal receipt printers and standard printers.
 */

/**
 * Get list of available printers.
 * @param {BrowserWindow} mainWindow
 * @returns {Promise<Array>}
 */
async function getAvailablePrinters(mainWindow) {
	if (!mainWindow) return []
	return mainWindow.webContents.getPrintersAsync()
}

/**
 * Print HTML content to a specific printer.
 * Creates a hidden window, loads the HTML, and sends to printer.
 *
 * @param {string} html - Receipt HTML content
 * @param {string} printerName - Target printer name (empty = default)
 * @param {Object} options - Print options
 * @param {boolean} options.silent - Skip print dialog (default: true)
 * @param {boolean} options.printBackground - Print background colors (default: true)
 * @param {number} options.copies - Number of copies (default: 1)
 * @param {Object} options.margins - Page margins
 * @returns {Promise<{success: boolean}>}
 */
async function printHTML(html, printerName = "", options = {}) {
	const printWindow = new BrowserWindow({
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	})

	try {
		// Load the receipt HTML
		await printWindow.loadURL(
			`data:text/html;charset=utf-8,${encodeURIComponent(html)}`
		)

		// Wait a moment for rendering
		await new Promise((resolve) => setTimeout(resolve, 500))

		return new Promise((resolve, reject) => {
			printWindow.webContents.print(
				{
					silent: options.silent !== false,
					printBackground: options.printBackground !== false,
					deviceName: printerName,
					copies: options.copies || 1,
					margins: options.margins || {
						marginType: "none",
					},
					pageSize: options.pageSize || {
						width: 80000, // 80mm in microns (receipt printer width)
						height: 297000, // Will auto-size based on content
					},
					...options,
				},
				(success, failureReason) => {
					printWindow.close()
					if (success) {
						resolve({ success: true })
					} else {
						reject(new Error(failureReason || "Print failed"))
					}
				},
			)
		})
	} catch (error) {
		printWindow.close()
		throw error
	}
}

module.exports = {
	getAvailablePrinters,
	printHTML,
}
