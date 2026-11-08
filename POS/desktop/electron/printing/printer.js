// Adapted from BrainWise-DEV/POSNext, branch feature/electron-desktop, commit 661d32f.
const { BrowserWindow } = require("electron")

/**
 * Native Printing Module for Electron Desktop POS.
 *
 * Replaces QZ Tray with Electron's built-in printing capabilities.
 * Supports both thermal receipt printers and standard printers.
 */

/** Paper a print template may ask for. Rolls are as long as the receipt. */
const PAPERS = {
	"58mm": { widthMm: 58, roll: true },
	"80mm": { widthMm: 80, roll: true },
	A4: { widthMm: 210, heightMm: 297, roll: false },
	A5: { widthMm: 148, heightMm: 210, roll: false },
}

const MAX_COPIES = 10
const MICRONS_PER_CSS_PX = 25400 / 96

/** What the built-in receipt has always printed on: 80mm wide, an A4 length */
const LEGACY_PAGE_SIZE = { width: 80000, height: 297000 }

/**
 * The page's own request, kept to what printing understands. It comes from the renderer,
 * so nothing else it sends reaches webContents.print.
 * @param {{paper?: string, copies?: number}} [options]
 * @returns {{paper: string|null, copies: number}} paper is null for the built-in receipt
 */
function printJobOptions(options = {}) {
	const paper = Object.hasOwn(PAPERS, options?.paper || "") ? options.paper : null
	const copies = Math.min(MAX_COPIES, Math.max(1, Number.parseInt(options?.copies, 10) || 1))
	return { paper, copies }
}

/**
 * The hidden window's width, so the page lays out at the paper's width.
 * @param {string} paper
 * @returns {number} CSS pixels
 */
function windowWidthFor(paper) {
	return Math.ceil((PAPERS[paper].widthMm * 96) / 25.4)
}

/**
 * The page size webContents.print takes, in microns. A roll's height is the receipt's
 * own, so a short receipt does not feed a whole A4 length of paper.
 * @param {string} paper
 * @param {number} contentHeightPx - The laid out page's height in CSS pixels
 * @returns {string|{width: number, height: number}}
 */
function pageSizeFor(paper, contentHeightPx) {
	const { widthMm, roll } = PAPERS[paper]
	if (!roll) return paper
	const height = Math.ceil((Math.max(contentHeightPx, 1) + 8) * MICRONS_PER_CSS_PX)
	return { width: widthMm * 1000, height: Math.max(height, 25000) }
}

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
 * Load a document in a hidden window as wide as its paper.
 * @param {string} html
 * @param {string|null} paper - null for the built-in receipt, which keeps its old page
 * @returns {Promise<{printWindow: BrowserWindow, pageSize: string|Object}>}
 */
async function openPrintWindow(html, paper) {
	const printWindow = new BrowserWindow({
		show: false,
		...(paper ? { width: windowWidthFor(paper), height: 600 } : {}),
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			javascript: true,
		},
	})
	try {
		// Base64 keeps an Arabic receipt with a logo well under Chromium's URL limit
		await printWindow.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`)
		// Wait a moment for rendering
		await new Promise((resolve) => setTimeout(resolve, 500))
		if (!paper) return { printWindow, pageSize: LEGACY_PAGE_SIZE }
		// The content's own height: scrollHeight would never be less than the window's
		const height = await printWindow.webContents.executeJavaScript(
			"Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.getBoundingClientRect().bottom : 0))",
		)
		return { printWindow, pageSize: pageSizeFor(paper, Number(height) || 0) }
	} catch (error) {
		printWindow.close()
		throw error
	}
}

/**
 * Print HTML content to a specific printer.
 * Creates a hidden window, loads the HTML, and sends to printer.
 *
 * @param {string} html - Receipt HTML content
 * @param {string} printerName - Target printer name (empty = the system dialog)
 * @param {{paper?: string, copies?: number}} [options] - The template's paper and copies
 * @returns {Promise<{success: boolean}>}
 */
async function printHTML(html, printerName = "", options = {}) {
	const { paper, copies } = printJobOptions(options)
	const { printWindow, pageSize } = await openPrintWindow(html, paper)

	return new Promise((resolve, reject) => {
		printWindow.webContents.print(
			{
				// No printer chosen in settings: let the system dialog pick one
				silent: Boolean(printerName),
				printBackground: true,
				deviceName: printerName,
				copies,
				margins: { marginType: "none" },
				pageSize,
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
}

module.exports = {
	LEGACY_PAGE_SIZE,
	PAPERS,
	getAvailablePrinters,
	openPrintWindow,
	pageSizeFor,
	printHTML,
	printJobOptions,
	windowWidthFor,
}
