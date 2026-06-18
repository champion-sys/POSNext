import { logger } from "./logger"
import { useBluetoothPrinterStore } from "../stores/bluetoothPrinter"
import { PrinterService } from "../services/printerService"

const log = logger.create("ESCPOS")

// ESC/POS Command Constants
const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

export const COMMANDS = {
	INITIALIZE: new Uint8Array([ESC, 0x40]),
	LINE_FEED: new Uint8Array([LF]),
	ALIGN_LEFT: new Uint8Array([ESC, 0x61, 0]),
	ALIGN_CENTER: new Uint8Array([ESC, 0x61, 1]),
	ALIGN_RIGHT: new Uint8Array([ESC, 0x61, 2]),
	BOLD_ON: new Uint8Array([ESC, 0x45, 1]),
	BOLD_OFF: new Uint8Array([ESC, 0x45, 0]),
	CUT: new Uint8Array([GS, 0x56, 66, 0]), // Feed and cut
	SELECT_CP1256: new Uint8Array([ESC, 0x74, 50]), // Select Arabic code page
	CANCEL_CHINESE: new Uint8Array([0x1c, 0x2e]), // FS . (Cancel Chinese/Kanji mode)
}

// Map Arabic unicode characters to CP1256 (Windows-1256)
const ARABIC_TO_CP1256: Record<number, number> = {
	0x060c: 0xa1, 0x061b: 0xba, 0x061f: 0xbf, 0x0621: 0xc1, 0x0622: 0xc2,
	0x0623: 0xc3, 0x0624: 0xc4, 0x0625: 0xc5, 0x0626: 0xc6, 0x0627: 0xc7,
	0x0628: 0xc8, 0x0629: 0xc9, 0x062a: 0xca, 0x062b: 0xcb, 0x062c: 0xcc,
	0x062d: 0xcd, 0x062e: 0xce, 0x062f: 0xcf, 0x0630: 0xd0, 0x0631: 0xd1,
	0x0632: 0xd2, 0x0633: 0xd3, 0x0634: 0xd4, 0x0635: 0xd5, 0x0636: 0xd6,
	0x0637: 0xd7, 0x0638: 0xd8, 0x0639: 0xd9, 0x063a: 0xda, 0x0640: 0xdc,
	0x0641: 0xe1, 0x0642: 0xe2, 0x0643: 0xe3, 0x0644: 0xe4, 0x0645: 0xe5,
	0x0646: 0xe6, 0x0647: 0xe7, 0x0648: 0xe8, 0x0649: 0xe9, 0x064a: 0xea,
	0x064b: 0xf0, 0x064c: 0xf1, 0x064d: 0xf2, 0x064e: 0xf3, 0x064f: 0xf5,
	0x0650: 0xf6, 0x0651: 0xf8, 0x0652: 0xfa, 0x067e: 0x81, 0x0679: 0x8a,
	0x0686: 0x8d, 0x0688: 0x8f, 0x0691: 0x9a, 0x0698: 0x8e, 0x06a9: 0x98,
	0x06af: 0x90, 0x06ba: 0x9f, 0x06be: 0xaa, 0x06c1: 0xc0, 0x06d2: 0xff,
	0x200c: 0x9d, 0x200d: 0x9e, 0x200e: 0xfd, 0x200f: 0xfe,
	0x0660: 0x30, 0x0661: 0x31, 0x0662: 0x32, 0x0663: 0x33, 0x0664: 0x34,
	0x0665: 0x35, 0x0666: 0x36, 0x0667: 0x37, 0x0668: 0x38, 0x0669: 0x39,
	0x06f0: 0x30, 0x06f1: 0x31, 0x06f2: 0x32, 0x06f3: 0x33, 0x06f4: 0x34,
	0x06f5: 0x35, 0x06f6: 0x36, 0x06f7: 0x37, 0x06f8: 0x38, 0x06f9: 0x39,
}

// ----------------------------------------------------------------------
// TEXT MODE FUNCTIONS (CP1256)
// ----------------------------------------------------------------------

export function encodeCP1256(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length)
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 128) {
			bytes[i] = code
		} else if (ARABIC_TO_CP1256[code] !== undefined) {
			bytes[i] = ARABIC_TO_CP1256[code]
		} else {
			bytes[i] = 0x3f // '?'
		}
	}
	return bytes
}

export function reshapeArabic(text: string): string {
	const shapingMap: Record<number, [string, string, string, string]> = {
		0x0627: ["ا", "ـا", "ـا", "ا"], 0x0628: ["ب", "ـب", "ـبـ", "بـ"],
		0x062a: ["ت", "ـت", "ـتـ", "تـ"], 0x062b: ["ث", "ـث", "ـثـ", "ثـ"],
		0x062c: ["ج", "ـج", "ـجـ", "جـ"], 0x062d: ["ح", "ـح", "ـحـ", "حـ"],
		0x062e: ["خ", "ـخ", "ـخـ", "خـ"], 0x062f: ["د", "ـد", "ـد", "د"],
		0x0630: ["ذ", "ـذ", "ـذ", "ذ"], 0x0631: ["ر", "ـر", "ـر", "ر"],
		0x0632: ["ز", "ـز", "ـز", "ز"], 0x0633: ["س", "ـس", "ـسـ", "سـ"],
		0x0634: ["ش", "ـش", "ـشـ", "شـ"], 0x0635: ["ص", "ـص", "ـصـ", "صـ"],
		0x0636: ["ض", "ـض", "ـضـ", "ضـ"], 0x0637: ["ط", "ـط", "ـطـ", "طـ"],
		0x0638: ["ظ", "ـظ", "ـظـ", "ظـ"], 0x0639: ["ع", "ـع", "ـعـ", "عـ"],
		0x063a: ["غ", "ـغ", "ـغـ", "غـ"], 0x0641: ["ف", "ـف", "ـفـ", "فـ"],
		0x0642: ["ق", "ـق", "ـقـ", "قـ"], 0x0643: ["ك", "ـك", "ـكـ", "كـ"],
		0x0644: ["ل", "ـل", "ـلـ", "لـ"], 0x0645: ["م", "ـم", "ـمـ", "مـ"],
		0x0646: ["ن", "ـن", "ـنـ", "نـ"], 0x0647: ["ه", "ـه", "ـهـ", "هـ"],
		0x0648: ["و", "ـو", "ـو", "و"], 0x064a: ["ي", "ـي", "ـيـ", "يـ"],
		0x0629: ["ة", "ـة", "ـة", "ة"], 0x0649: ["ى", "ـى", "ـى", "ى"]
	}

	const isLinkerBefore = (char: string): boolean => {
		if (!char) return false
		const code = char.charCodeAt(0)
		const nonLinkers = [0x0627, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0622, 0x0623, 0x0625, 0x0629, 0x0649]
		return shapingMap[code] !== undefined && !nonLinkers.includes(code)
	}

	const isLinkerAfter = (char: string): boolean => {
		if (!char) return false
		const code = char.charCodeAt(0)
		return shapingMap[code] !== undefined
	}

	const words = text.split(" ")
	const reshapedWords = words.map((word) => {
		let reshapedWord = ""
		for (let i = 0; i < word.length; i++) {
			const char = word[i]
			const code = char.charCodeAt(0)
			const mapping = shapingMap[code]

			if (mapping) {
				const prev = i > 0 ? word[i - 1] : ""
				const next = i < word.length - 1 ? word[i + 1] : ""

				const connectsBefore = isLinkerBefore(prev)
				const connectsAfter = isLinkerAfter(next)

				if (connectsBefore && connectsAfter) {
					reshapedWord += mapping[2]
				} else if (connectsBefore) {
					reshapedWord += mapping[1]
				} else if (connectsAfter) {
					reshapedWord += mapping[3]
				} else {
					reshapedWord += mapping[0]
				}
			} else {
				reshapedWord += char
			}
		}

		const containsArabic = /[\u0600-\u06FF]/.test(word)
		if (!containsArabic) return reshapedWord

		return reshapedWord.split("").reverse().join("")
	})

	return reshapedWords.reverse().join(" ")
}

/**
 * FIX: Safely generates a byte payload for Text Mode, ensuring Chinese mode 
 * is disabled before applying CP1256 formatting.
 */
export function generateTextPrintPayload(lines: ReceiptLine[]): Uint8Array {
	const payload: number[] = []

	payload.push(...COMMANDS.INITIALIZE)
	payload.push(...COMMANDS.CANCEL_CHINESE) // CRITICAL: Prevent Kanji absorption
	payload.push(...COMMANDS.SELECT_CP1256)

	lines.forEach(line => {
		// Alignment
		if (line.align === "center") payload.push(...COMMANDS.ALIGN_CENTER)
		else if (line.align === "right") payload.push(...COMMANDS.ALIGN_RIGHT)
		else payload.push(...COMMANDS.ALIGN_LEFT)

		// Bold
		if (line.bold) payload.push(...COMMANDS.BOLD_ON)

		const reshaped = reshapeArabic(line.text)
		const bytes = encodeCP1256(reshaped)

		payload.push(...bytes)
		payload.push(...COMMANDS.LINE_FEED)

		if (line.bold) payload.push(...COMMANDS.BOLD_OFF)
	})

	payload.push(...COMMANDS.LINE_FEED)
	payload.push(...COMMANDS.LINE_FEED)
	payload.push(...COMMANDS.CUT)

	return new Uint8Array(payload)
}


// ----------------------------------------------------------------------
// CANVAS MODE FUNCTIONS (RECOMMENDED)
// ----------------------------------------------------------------------

export interface ReceiptLine {
	text: string
	align: "left" | "center" | "right"
	bold?: boolean
	size?: "normal" | "large"
}

/**
 * Renders receipt lines to an HTML Canvas and compiles it into an ESC/POS raster bit image byte array.
 * This guarantees 100% perfect Arabic layout, shaping, and font rendering.
 */
export async function renderReceiptToRaster(
	lines: ReceiptLine[],
	width?: number
): Promise<Uint8Array> {
	let printWidth = width
	if (printWidth === undefined) {
		try {
			const store = useBluetoothPrinterStore()
			printWidth = store.paperSize === "80" ? 576 : 384
		} catch (e) {
			printWidth = 384
		}
	}

	const is80mm = printWidth >= 500
	const normalFontSize = is80mm ? 28 : 24
	const largeFontSize = is80mm ? 38 : 32
	const lineHeightNormal = is80mm ? 38 : 32
	const lineHeightLarge = is80mm ? 50 : 44

	const canvas = document.createElement("canvas")
	canvas.width = printWidth
	const ctx = canvas.getContext("2d")
	if (!ctx) {
		throw new Error("Could not create 2D canvas context")
	}

	// FIX: Comprehensive mobile Arabic font stack
	const fontFamily = `"Inter", "Arial", "Tahoma", "Droid Arabic Naskh", system-ui, sans-serif`

	// First pass: Measure height dynamically
	let currentY = 15
	ctx.font = `normal ${normalFontSize}px ${fontFamily}`

	lines.forEach((line) => {
		if (line.size === "large") {
			currentY += lineHeightLarge
		} else {
			currentY += lineHeightNormal
		}
	})
	currentY += 30 // Padding at bottom

	canvas.height = currentY

	// Second pass: Draw receipt content
	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	ctx.fillStyle = "#000000"

	// FIX: explicitly set text alignment and baseline to prevent vertical clipping
	ctx.textBaseline = "top"

	currentY = 15
	lines.forEach((line) => {
		const isLarge = line.size === "large"
		ctx.font = `${line.bold ? "bold" : "normal"} ${isLarge ? largeFontSize : normalFontSize}px ${fontFamily}`
		const textWidth = ctx.measureText(line.text).width

		let x = 0
		if (line.align === "center") {
			x = (printWidth - textWidth) / 2
		} else if (line.align === "right") {
			x = printWidth - textWidth - 5
		} else {
			x = 5
		}

		// Changed baseline math to "top" so we just pass currentY directly
		ctx.fillText(line.text, x, currentY)
		currentY += isLarge ? lineHeightLarge : lineHeightNormal
	})

	// Convert canvas image to ESC/POS raster bit image format
	const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
	const data = imgData.data
	const height = canvas.height
	const widthBytes = printWidth / 8

	// GS v 0 m xL xH yL yH d1...dk
	const xL = widthBytes % 256
	const xH = Math.floor(widthBytes / 256)
	const yL = height % 256
	const yH = Math.floor(height / 256)

	const rasterSize = height * widthBytes
	// INITIALIZE (2 bytes) + GS v 0 header (8 bytes) + raster data + LINE_FEED (1) + LINE_FEED (1) + CUT (4 bytes)
	const escposBytes = new Uint8Array(2 + 8 + rasterSize + 6)

	// Initialize
	escposBytes[0] = COMMANDS.INITIALIZE[0]
	escposBytes[1] = COMMANDS.INITIALIZE[1]

	// GS v 0 Header
	escposBytes[2] = GS
	escposBytes[3] = 0x76
	escposBytes[4] = 0x30
	escposBytes[5] = 0
	escposBytes[6] = xL
	escposBytes[7] = xH
	escposBytes[8] = yL
	escposBytes[9] = yH

	// Pack 8 pixels into 1 byte (optimized sequential access, no multiplications)
	let pixelIndex = 0
	let destIndex = 10
	for (let y = 0; y < height; y++) {
		for (let xByte = 0; xByte < widthBytes; xByte++) {
			let byteVal = 0
			for (let bit = 0; bit < 8; bit++) {
				const r = data[pixelIndex]
				const g = data[pixelIndex + 1]
				const b = data[pixelIndex + 2]
				const a = data[pixelIndex + 3]
				pixelIndex += 4

				const luminance = 0.299 * r + 0.587 * g + 0.114 * b

				if (a > 50 && luminance < 200) {
					byteVal |= 1 << (7 - bit)
				}
			}
			escposBytes[destIndex++] = byteVal
		}
	}

	// Add margin and cut paper
	escposBytes[destIndex++] = 0x0a // LINE_FEED
	escposBytes[destIndex++] = 0x0a // LINE_FEED
	escposBytes[destIndex++] = GS
	escposBytes[destIndex++] = 0x56
	escposBytes[destIndex++] = 66
	escposBytes[destIndex++] = 0 // CUT

	return escposBytes
}

export function formatInvoiceToReceiptLines(invoice: any): ReceiptLine[] {
	const lines: ReceiptLine[] = []

	// Company Name
	lines.push({
		text: invoice.company || "POS Next",
		align: "center",
		bold: true,
		size: "large"
	})

	// Header / Tax Invoice
	lines.push({
		text: invoice.header || "TAX INVOICE",
		align: "center",
		bold: true,
		size: "normal"
	})

	lines.push({ text: "--------------------------------", align: "center" })

	if (invoice.is_offline) {
		lines.push({ text: "*** OFFLINE RECEIPT ***", align: "center", bold: true })
	}

	// Invoice Info
	lines.push({ text: `Invoice #: ${invoice.name}`, align: "left" })
	const dateStr = invoice.posting_date
		? new Date(invoice.posting_date).toLocaleString()
		: new Date().toLocaleString()
	lines.push({ text: `Date: ${dateStr}`, align: "left" })

	const customer = invoice.customer_name || invoice.customer
	if (customer) {
		lines.push({ text: `Customer: ${customer}`, align: "left" })
	}

	lines.push({ text: "--------------------------------", align: "center" })

	// Items Header
	lines.push({ text: "Items", align: "left", bold: true })

	// Items List
	const items = invoice.items || []
	items.forEach((item: any) => {
		const name = item.item_name || item.item_code
		const qty = item.quantity || item.qty || 0
		const rate = item.price_list_rate || item.rate || 0
		const subtotal = qty * rate
		const isFree = item.is_free_item

		let itemText = name
		if (isFree) itemText += " (FREE)"

		lines.push({ text: itemText, align: "left", bold: true })
		lines.push({
			text: `${qty} x ${rate.toFixed(2)}   ${subtotal.toFixed(2)}`,
			align: "right"
		})

		const hasDiscount = (item.discount_percentage && Number(item.discount_percentage) > 0) || (item.discount_amount && Number(item.discount_amount) > 0)
		if (hasDiscount) {
			lines.push({
				text: `Discount: -${Number(item.discount_amount || 0).toFixed(2)}`,
				align: "right"
			})
		}

		if (item.serial_no) {
			lines.push({
				text: `S/N: ${String(item.serial_no).replace(/\n/g, ", ")}`,
				align: "left"
			})
		}
	})

	lines.push({ text: "--------------------------------", align: "center" })

	// Totals
	const totalTax = invoice.total_taxes_and_charges || 0
	if (totalTax > 0) {
		const subtotal = (invoice.grand_total || 0) - totalTax
		lines.push({ text: `Subtotal: ${subtotal.toFixed(2)}`, align: "right" })
		lines.push({ text: `Tax: ${totalTax.toFixed(2)}`, align: "right" })
	}

	if (invoice.discount_amount) {
		lines.push({ text: `Discount: -${Math.abs(invoice.discount_amount).toFixed(2)}`, align: "right" })
	}

	lines.push({
		text: `TOTAL: ${(invoice.grand_total || 0).toFixed(2)}`,
		align: "right",
		bold: true,
		size: "large"
	})

	// Payments
	const payments = invoice.payments || []
	if (payments.length > 0) {
		lines.push({ text: "Payments:", align: "left", bold: true })
		let totalPaid = 0
		payments.forEach((p: any) => {
			const amt = Number(p.amount) || 0
			totalPaid += amt
			lines.push({ text: `${p.mode_of_payment}: ${amt.toFixed(2)}`, align: "right" })
		})

		lines.push({ text: `Total Paid: ${totalPaid.toFixed(2)}`, align: "right", bold: true })

		if (invoice.change_amount && invoice.change_amount > 0) {
			lines.push({ text: `Change: ${Number(invoice.change_amount).toFixed(2)}`, align: "right", bold: true })
		}

		if (invoice.outstanding_amount && invoice.outstanding_amount > 0) {
			lines.push({ text: `Balance Due: ${Number(invoice.outstanding_amount).toFixed(2)}`, align: "right", bold: true })
		}
	}

	lines.push({ text: "--------------------------------", align: "center" })

	// Footer
	const footerText = invoice.footer || "Thank you for your business!"
	lines.push({ text: footerText, align: "center" })

	return lines
}

export async function printInvoiceToBluetooth(invoiceData: any): Promise<void> {
	const store = useBluetoothPrinterStore()
	if (!PrinterService.isConnected()) {
		throw new Error("Bluetooth printer is not connected.")
	}

	const lines = formatInvoiceToReceiptLines(invoiceData)
	const widthPixels = store.paperSize === "80" ? 576 : 384

	if (store.printMethod === "image") {
		const rasterData = await renderReceiptToRaster(lines, widthPixels)
		const printData = new Uint8Array([
			...COMMANDS.INITIALIZE,
			...rasterData,
			...COMMANDS.LINE_FEED,
			...COMMANDS.LINE_FEED,
			...COMMANDS.LINE_FEED,
			...COMMANDS.CUT
		])
		await PrinterService.printRaw(printData)
	} else {
		const payload = generateTextPrintPayload(lines)
		await PrinterService.printRaw(payload)
	}
}