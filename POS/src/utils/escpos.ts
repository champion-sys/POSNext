import { logger } from "./logger"
import { useBluetoothPrinterStore } from "../stores/bluetoothPrinter"
import { printerService } from "../services/printerService"
import { call } from "./apiWrapper"
import { usePOSSettingsStore } from "../stores/posSettings"

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

	let feedsCount = 3
	try {
		const store = useBluetoothPrinterStore()
		feedsCount = store.lineFeedsAfterPrint !== undefined ? Number(store.lineFeedsAfterPrint) : 3
	} catch (e) {
		// Ignore store error in non-vue context
	}

	for (let i = 0; i < feedsCount; i++) {
		payload.push(LF)
	}
	payload.push(...COMMANDS.CUT)
	payload.push(...COMMANDS.INITIALIZE) // Reset state machine to default at the end

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

	// Dynamic text wrapping utility
	const wrapText = (c: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
		if (!text) return [""]
		const words = text.split(" ")
		const wrappedLines: string[] = []
		let currentLine = ""

		for (let n = 0; n < words.length; n++) {
			const testLine = currentLine ? currentLine + " " + words[n] : words[n]
			const metrics = c.measureText(testLine)
			const testWidth = metrics.width
			if (testWidth > maxWidth && n > 0) {
				wrappedLines.push(currentLine)
				currentLine = words[n]
			} else {
				currentLine = testLine
			}
		}
		if (currentLine) {
			wrappedLines.push(currentLine)
		}
		return wrappedLines
	}

	// FIX: Comprehensive mobile Arabic font stack
	const fontFamily = `"Inter", "Arial", "Tahoma", "Droid Arabic Naskh", system-ui, sans-serif`

	// First pass: Measure height dynamically with text wrapping
	let currentY = 15
	const maxTextWidth = printWidth - 10

	lines.forEach((line) => {
		const isLarge = line.size === "large"
		ctx.font = `${line.bold ? "bold" : "normal"} ${isLarge ? largeFontSize : normalFontSize}px ${fontFamily}`
		const wrapped = wrapText(ctx, line.text, maxTextWidth)
		currentY += wrapped.length * (isLarge ? lineHeightLarge : lineHeightNormal)
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
		const activeLineHeight = isLarge ? lineHeightLarge : lineHeightNormal
		ctx.font = `${line.bold ? "bold" : "normal"} ${isLarge ? largeFontSize : normalFontSize}px ${fontFamily}`
		
		const wrapped = wrapText(ctx, line.text, maxTextWidth)
		wrapped.forEach((wrappedLine) => {
			const textWidth = ctx.measureText(wrappedLine).width

			let x = 0
			if (line.align === "center") {
				x = (printWidth - textWidth) / 2
			} else if (line.align === "right") {
				x = printWidth - textWidth - 5
			} else {
				x = 5
			}

			ctx.fillText(wrappedLine, x, currentY)
			currentY += activeLineHeight
		})
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
	let feedsCount = 3
	try {
		const store = useBluetoothPrinterStore()
		feedsCount = store.lineFeedsAfterPrint !== undefined ? Number(store.lineFeedsAfterPrint) : 3
	} catch (e) {
		// Ignore store error in non-vue context
	}
	// INITIALIZE (2 bytes) + GS v 0 header (8 bytes) + raster data + LINE_FEED (feedsCount) + CUT (4 bytes) + INITIALIZE (2 bytes)
	const escposBytes = new Uint8Array(2 + 8 + rasterSize + feedsCount + 4 + 2)

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

	// Pack 8 pixels into 1 byte (optimized 32-bit sequential access, integer math)
	const pixels = new Uint32Array(data.buffer)
	let pixelIndex = 0
	let destIndex = 10
	for (let y = 0; y < height; y++) {
		for (let xByte = 0; xByte < widthBytes; xByte++) {
			let byteVal = 0
			for (let bit = 0; bit < 8; bit++) {
				const pixel = pixels[pixelIndex++]
				const a = (pixel >> 24) & 0xff

				if (a > 50) {
					const r = pixel & 0xff
					const g = (pixel >> 8) & 0xff
					const b = (pixel >> 16) & 0xff

					// Fast integer luminance: (r * 77 + g * 150 + b * 29) >> 8
					const luminance = (r * 77 + g * 150 + b * 29) >> 8
					if (luminance < 200) {
						byteVal |= 1 << (7 - bit)
					}
				}
			}
			escposBytes[destIndex++] = byteVal
		}
	}

	// Add margin and cut paper
	for (let i = 0; i < feedsCount; i++) {
		escposBytes[destIndex++] = 0x0a // LINE_FEED
	}
	escposBytes[destIndex++] = GS
	escposBytes[destIndex++] = 0x56
	escposBytes[destIndex++] = 66
	escposBytes[destIndex++] = 0 // CUT

	// Reset printer state at the end
	escposBytes[destIndex++] = COMMANDS.INITIALIZE[0]
	escposBytes[destIndex++] = COMMANDS.INITIALIZE[1]

	return escposBytes
}

export function formatInvoiceToReceiptLines(invoice: any): ReceiptLine[] {
	const lines: ReceiptLine[] = []
	const isRtl = !!invoice.is_offline

	// Company Name
	lines.push({
		text: invoice.company || "POS Next",
		align: "center",
		bold: true,
		size: "large"
	})

	// Header / Tax Invoice
	const headerText = isRtl
		? (invoice.status === "Draft" ? "مسودة" : "فاتورة ضريبية مبسطة")
		: (invoice.header || "TAX INVOICE")

	lines.push({
		text: headerText,
		align: "center",
		bold: true,
		size: "normal"
	})

	lines.push({ text: "--------------------------------", align: "center" })

	if (invoice.is_offline) {
		lines.push({ text: "*** غير متصل بالشبكة ***", align: "center", bold: true })
	}

	// Invoice Info
	lines.push({ text: isRtl ? `رقم الفاتورة: ${invoice.name}` : `Invoice #: ${invoice.name}`, align: isRtl ? "right" : "left" })
	
	const dateStr = invoice.posting_date
		? new Date(invoice.posting_date).toLocaleString(isRtl ? "ar-EG" : undefined)
		: new Date().toLocaleString(isRtl ? "ar-EG" : undefined)
	lines.push({ text: isRtl ? `التاريخ والوقت: ${dateStr}` : `Date: ${dateStr}`, align: isRtl ? "right" : "left" })

	if (invoice.owner) {
		lines.push({ text: isRtl ? `الكاشير: ${invoice.owner}` : `Cashier: ${invoice.owner}`, align: isRtl ? "right" : "left" })
	}

	if (invoice.pos_order_type) {
		lines.push({ text: isRtl ? `نوع الطلب: ${invoice.pos_order_type}` : `Order Type: ${invoice.pos_order_type}`, align: isRtl ? "right" : "left" })
	}

	const customer = invoice.customer_name || invoice.customer
	if (customer) {
		lines.push({ text: isRtl ? `العميل: ${customer}` : `Customer: ${customer}`, align: isRtl ? "right" : "left" })
	}

	lines.push({ text: "--------------------------------", align: "center" })

	// Items Header
	lines.push({ text: isRtl ? "الأصناف" : "Items", align: isRtl ? "right" : "left", bold: true })

	// Items List
	const items = invoice.items || []
	items.forEach((item: any) => {
		const name = item.item_name || item.item_code
		const qty = item.quantity || item.qty || 0
		const rate = item.price_list_rate || item.rate || 0
		const subtotal = qty * rate
		const isFree = item.is_free_item

		let itemText = name
		if (isFree) itemText += isRtl ? " (مجاني)" : " (FREE)"

		lines.push({ text: itemText, align: isRtl ? "right" : "left", bold: true })
		lines.push({
			text: isRtl 
				? `${subtotal.toFixed(2)}   ${rate.toFixed(2)} × ${qty}`
				: `${qty} x ${rate.toFixed(2)}   ${subtotal.toFixed(2)}`,
			align: isRtl ? "left" : "right"
		})

		const hasDiscount = (item.discount_percentage && Number(item.discount_percentage) > 0) || (item.discount_amount && Number(item.discount_amount) > 0)
		if (hasDiscount) {
			lines.push({
				text: isRtl 
					? `-${Number(item.discount_amount || 0).toFixed(2)} :خصم`
					: `Discount: -${Number(item.discount_amount || 0).toFixed(2)}`,
				align: isRtl ? "left" : "right"
			})
		}

		if (item.serial_no) {
			lines.push({
				text: isRtl 
					? `أرقام تسلسلية: ${String(item.serial_no).replace(/\n/g, ", ")}`
					: `S/N: ${String(item.serial_no).replace(/\n/g, ", ")}`,
				align: isRtl ? "right" : "left"
			})
		}
	})

	lines.push({ text: "--------------------------------", align: "center" })

	// Totals
	const totalTax = invoice.total_taxes_and_charges || 0
	if (totalTax > 0) {
		const subtotal = (invoice.grand_total || 0) - totalTax
		lines.push({ 
			text: isRtl ? `${subtotal.toFixed(2)} :المجموع الفرعي` : `Subtotal: ${subtotal.toFixed(2)}`, 
			align: isRtl ? "left" : "right" 
		})
		lines.push({ 
			text: isRtl ? `${totalTax.toFixed(2)} :الضريبة` : `Tax: ${totalTax.toFixed(2)}`, 
			align: isRtl ? "left" : "right" 
		})
	}

	if (invoice.discount_amount) {
		lines.push({ 
			text: isRtl 
				? `-${Math.abs(invoice.discount_amount).toFixed(2)} :خصم إضافي` 
				: `Discount: -${Math.abs(invoice.discount_amount).toFixed(2)}`, 
			align: isRtl ? "left" : "right" 
		})
	}

	lines.push({
		text: isRtl ? `${(invoice.grand_total || 0).toFixed(2)} :الإجمالي` : `TOTAL: ${(invoice.grand_total || 0).toFixed(2)}`,
		align: isRtl ? "left" : "right",
		bold: true,
		size: "large"
	})

	// Payments
	const payments = invoice.payments || []
	if (payments.length > 0) {
		lines.push({ text: isRtl ? "المدفوعات:" : "Payments:", align: isRtl ? "right" : "left", bold: true })
		let totalPaid = 0
		payments.forEach((p: any) => {
			const amt = Number(p.amount) || 0
			totalPaid += amt
			lines.push({ 
				text: isRtl ? `${amt.toFixed(2)} :${p.mode_of_payment}` : `${p.mode_of_payment}: ${amt.toFixed(2)}`, 
				align: isRtl ? "left" : "right" 
			})
		})

		lines.push({ 
			text: isRtl ? `${totalPaid.toFixed(2)} :إجمالي المدفوع` : `Total Paid: ${totalPaid.toFixed(2)}`, 
			align: isRtl ? "left" : "right", 
			bold: true 
		})

		if (invoice.change_amount && invoice.change_amount > 0) {
			lines.push({ 
				text: isRtl ? `${Number(invoice.change_amount).toFixed(2)} :المتبقي (الفكة)` : `Change: ${Number(invoice.change_amount).toFixed(2)}`, 
				align: isRtl ? "left" : "right", 
				bold: true 
			})
		}

		if (invoice.outstanding_amount && invoice.outstanding_amount > 0) {
			lines.push({ 
				text: isRtl ? `${Number(invoice.outstanding_amount).toFixed(2)} :المبلغ المتبقي` : `Balance Due: ${Number(invoice.outstanding_amount).toFixed(2)}`, 
				align: isRtl ? "left" : "right", 
				bold: true 
			})
		}
	}

	lines.push({ text: "--------------------------------", align: "center" })

	// Footer
	const footerText = invoice.footer || (isRtl ? "شكراً لتعاملكم معنا!" : "Thank you for your business!")
	lines.push({ text: footerText, align: "center" })

	return lines
}

export async function printInvoiceToBluetooth(invoiceData: any): Promise<void> {
	const store = useBluetoothPrinterStore()
	if (!printerService.isConnected()) {
		throw new Error("Bluetooth printer is not connected.")
	}

	const lines = formatInvoiceToReceiptLines(invoiceData)
	const widthPixels = store.paperSize === "80" ? 576 : 384

	if (store.printMethod === "image") {
		const rasterData = await renderReceiptToRaster(lines, widthPixels)
		await printerService.printRaw(rasterData)
	} else {
		const payload = generateTextPrintPayload(lines)
		await printerService.printRaw(payload)
	}
}


const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function fetchAsDataURL(url: string): Promise<string> {
	try {
		const absoluteUrl = url.startsWith("/")
			? window.location.origin + url
			: (url.startsWith("http") ? url : window.location.origin + "/" + url)

		const res = await fetch(absoluteUrl)
		if (!res.ok) throw new Error("Fetch failed")
		const blob = await res.blob()
		return new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onloadend = () => resolve(reader.result as string)
			reader.onerror = reject
			reader.readAsDataURL(blob)
		})
	} catch (e) {
		console.warn("Failed to fetch asset for inlining:", url, e)
		return BLANK_PNG
	}
}

const XML_ENTITY_MAP: { [key: string]: string } = {
	"&nbsp;": "&#160;",
	"&iexcl;": "&#161;",
	"&cent;": "&#162;",
	"&pound;": "&#163;",
	"&curren;": "&#164;",
	"&yen;": "&#165;",
	"&brvbar;": "&#166;",
	"&sect;": "&#167;",
	"&uml;": "&#168;",
	"&copy;": "&#169;",
	"&ordf;": "&#170;",
	"&laquo;": "&#171;",
	"&not;": "&#172;",
	"&shy;": "&#173;",
	"&reg;": "&#174;",
	"&macr;": "&#175;",
	"&deg;": "&#176;",
	"&plusmn;": "&#177;",
	"&sup2;": "&#178;",
	"&sup3;": "&#179;",
	"&acute;": "&#180;",
	"&micro;": "&#181;",
	"&para;": "&#182;",
	"&middot;": "&#183;",
	"&cedil;": "&#184;",
	"&sup1;": "&#185;",
	"&ordm;": "&#186;",
	"&raquo;": "&#187;",
	"&frac14;": "&#188;",
	"&frac12;": "&#189;",
	"&frac34;": "&#190;",
	"&wish;": "&#9734;",
	"&iquest;": "&#191;",
	"&times;": "&#215;",
	"&divide;": "&#247;",
	"&trade;": "&#8482;",
	"&bull;": "&#8226;",
	"&hellip;": "&#8230;",
	"&euro;": "&#8364;",
};

function sanitizeXmlString(str: string): string {
	let res = str;
	for (const [entity, char] of Object.entries(XML_ENTITY_MAP)) {
		res = res.replace(new RegExp(entity, "g"), char);
	}
	// Escape raw ampersands that are not starting a valid XML entity reference
	res = res.replace(/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/g, "&amp;");
	return res;
}

async function replaceCssUrls(cssText: string): Promise<string> {
	const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g
	let match
	let resultText = cssText
	const matches: { full: string, url: string }[] = []

	while ((match = urlRegex.exec(cssText)) !== null) {
		matches.push({ full: match[0], url: match[1] })
	}

	for (const item of matches) {
		if (!item.url.startsWith("data:")) {
			const dataUrl = await fetchAsDataURL(item.url)
			resultText = resultText.replace(item.full, `url("${dataUrl}")`)
		}
	}
	return resultText
}

async function cleanCssString(cssText: string): Promise<string> {
	// Remove @import statements completely
	let cleaned = cssText.replace(/@import\s+[^;]+;/gi, "")
	// Remove @font-face blocks completely
	cleaned = cleaned.replace(/@font-face\s*\{[\s\S]*?\}/gi, "")

	if (cleaned.includes("url(")) {
		cleaned = await replaceCssUrls(cleaned)
	}
	return cleaned
}

async function prepareHtmlForSvg(html: string, style: string): Promise<{ html: string, style: string }> {
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, "text/html")

	const scripts = doc.querySelectorAll("script")
	scripts.forEach(s => s.remove())

	const links = doc.querySelectorAll("link")
	links.forEach(l => l.remove())

	// Clean all <style> blocks in the HTML
	const styleTags = Array.from(doc.querySelectorAll("style"))
	for (const tag of styleTags) {
		tag.textContent = await cleanCssString(tag.textContent || "")
	}

	const images = Array.from(doc.querySelectorAll("img"))
	for (const img of images) {
		const src = img.getAttribute("src")
		if (src && !src.startsWith("data:")) {
			const dataUrl = await fetchAsDataURL(src)
			img.setAttribute("src", dataUrl)
		}
	}

	const elementsWithStyle = Array.from(doc.querySelectorAll("[style]"))
	for (const el of elementsWithStyle) {
		let styleAttr = el.getAttribute("style") || ""
		if (styleAttr.includes("url(")) {
			styleAttr = await cleanCssString(styleAttr)
			el.setAttribute("style", styleAttr)
		}
	}

	const cleanStyle = await cleanCssString(style)

	return {
		html: sanitizeXmlString(doc.body.innerHTML),
		style: sanitizeXmlString(cleanStyle)
	}
}

export async function htmlToCanvas(rawHtml: string, rawStyle: string, width: number): Promise<HTMLCanvasElement> {
	const { html, style } = await prepareHtmlForSvg(rawHtml, rawStyle)

	const container = document.createElement("div")
	container.style.width = `${width}px`
	container.style.position = "absolute"
	container.style.left = "-9999px"
	container.style.top = "-9999px"
	container.style.visibility = "hidden"
	container.innerHTML = `<style>${style}</style>${html}`
	document.body.appendChild(container)

	await new Promise(resolve => requestAnimationFrame(resolve))

	const height = container.offsetHeight || 800
	document.body.removeChild(container)

	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
			<foreignObject width="100%" height="100%">
				<div xmlns="http://www.w3.org/1999/xhtml" style="background-color: white; color: black; font-family: sans-serif; width: 100%; height: 100%;">
					<style>
						${style}
						body { background-color: white; color: black; }
					</style>
					${html}
				</div>
			</foreignObject>
		</svg>
	`

	const canvas = document.createElement("canvas")
	canvas.width = width
	canvas.height = height
	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("Could not create 2D canvas context")

	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, width, height)

	const img = new Image()
	const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
	const url = URL.createObjectURL(svgBlob)

	await new Promise<void>((resolve, reject) => {
		img.onload = () => {
			ctx.drawImage(img, 0, 0)
			URL.revokeObjectURL(url)
			resolve()
		}
		img.onerror = (err) => {
			URL.revokeObjectURL(url)
			console.error("SVG rendering failed. Generated SVG content was:", svg)
			reject(new Error("Failed to render SVG to image"))
		}
		img.src = url
	})

	return canvas
}



export async function base64ImageToCanvas(imageUrl: string, width: number, height: number): Promise<HTMLCanvasElement> {
	const canvas = document.createElement("canvas")
	canvas.width = width
	canvas.height = height
	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("Could not create 2D canvas context")

	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, width, height)

	const img = new Image()
	await new Promise<void>((resolve, reject) => {
		img.onload = () => {
			ctx.drawImage(img, 0, 0, width, height)
			resolve()
		}
		img.onerror = () => {
			reject(new Error("Failed to load server-rendered PNG image"))
		}
		img.src = imageUrl
	})

	return canvas
}

const prefetchCache = new Map<string, Promise<any>>()

export function prefetchPrintFormat(invoiceData: any, printFormatName: string) {
	const invoiceName = invoiceData?.name
	if (
		!invoiceName ||
		(typeof invoiceName === "string" &&
			(invoiceName.startsWith("OFFLINE-") || invoiceName.startsWith("pos_offline_")))
	) {
		return
	}

	const key = `${invoiceName}:${printFormatName}`
	if (prefetchCache.has(key)) return

	let doctype = invoiceData.doctype
	if (!doctype) {
		try {
			const settingsStore = usePOSSettingsStore()
			doctype = settingsStore.invoiceType || "Sales Invoice"
		} catch (e) {
			doctype = "Sales Invoice"
		}
	}

	const store = useBluetoothPrinterStore()
	const promise = call("pos_next.api.pos_profile.get_rendered_print_format", {
		doc: doctype,
		name: invoiceName,
		print_format: printFormatName,
		paper_size: store.paperSize || "80",
	})
		.then((response) => {
			return response?.message || response
		})
		.catch((err) => {
			log.warn("Prefetch print format failed:", err)
			prefetchCache.delete(key)
			throw err
		})

	prefetchCache.set(key, promise)

	// Clean up after 2 minutes
	setTimeout(() => {
		prefetchCache.delete(key)
	}, 120000)
}

export async function printInvoiceFormatToBluetooth(invoiceData: any, printFormatName: string): Promise<void> {
	const store = useBluetoothPrinterStore()
	if (!printerService.isConnected()) {
		throw new Error("Bluetooth printer is not connected.")
	}

	const invoiceName = invoiceData?.name
	// If it's a local offline invoice (not synced to server yet), we cannot get it from the API, so fall back to local print
	if (typeof invoiceName === "string" && (invoiceName.startsWith("OFFLINE-") || invoiceName.startsWith("pos_offline_"))) {
		return printInvoiceToBluetooth(invoiceData)
	}

	let renderedImage = ""
	let imgWidth = 576
	let imgHeight = 800

	try {
		let doctype = invoiceData.doctype
		if (!doctype) {
			try {
				const settingsStore = usePOSSettingsStore()
				doctype = settingsStore.invoiceType || "Sales Invoice"
			} catch (e) {
				doctype = "Sales Invoice"
			}
		}

		const key = `${invoiceName}:${printFormatName}`
		let result = null
		if (prefetchCache.has(key)) {
			try {
				result = await prefetchCache.get(key)
				prefetchCache.delete(key) // Consume it
			} catch (err) {
				log.warn("Prefetched print format rejected, falling back to fresh API call", err)
			}
		}

		if (!result) {
			const response = await call("pos_next.api.pos_profile.get_rendered_print_format", {
				doc: doctype,
				name: invoiceName,
				print_format: printFormatName,
				paper_size: store.paperSize || "80"
			})
			result = response?.message || response
		}

		renderedImage = result?.image
		imgWidth = result?.width || (store.paperSize === "80" ? 576 : 384)
		imgHeight = result?.height || 800
	} catch (e) {
		log.warn("Failed to get rendered print PNG from server, falling back to standard Bluetooth receipt layout:", e)
		return printInvoiceToBluetooth(invoiceData)
	}

	if (!renderedImage) {
		return printInvoiceToBluetooth(invoiceData)
	}

	const widthPixels = store.paperSize === "80" ? 576 : 384
	const targetHeight = Math.round(imgHeight * (widthPixels / imgWidth))
	const canvas = await base64ImageToCanvas(renderedImage, widthPixels, targetHeight)

	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("Could not create 2D canvas context")

	const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
	const data = imgData.data
	const height = canvas.height
	const widthBytes = widthPixels / 8

	const xL = widthBytes % 256
	const xH = Math.floor(widthBytes / 256)
	const yL = height % 256
	const yH = Math.floor(height / 256)

	const rasterSize = height * widthBytes
	const feedsCount = store.lineFeedsAfterPrint !== undefined ? Number(store.lineFeedsAfterPrint) : 3
	const escposBytes = new Uint8Array(2 + 8 + rasterSize + feedsCount + 4 + 2)

	escposBytes[0] = COMMANDS.INITIALIZE[0]
	escposBytes[1] = COMMANDS.INITIALIZE[1]

	escposBytes[2] = GS
	escposBytes[3] = 0x76
	escposBytes[4] = 0x30
	escposBytes[5] = 0
	escposBytes[6] = xL
	escposBytes[7] = xH
	escposBytes[8] = yL
	escposBytes[9] = yH

	// Pack 8 pixels into 1 byte (optimized 32-bit sequential access, integer math)
	const pixels = new Uint32Array(data.buffer)
	let pixelIndex = 0
	let destIndex = 10
	for (let y = 0; y < height; y++) {
		for (let xByte = 0; xByte < widthBytes; xByte++) {
			let byteVal = 0
			for (let bit = 0; bit < 8; bit++) {
				const pixel = pixels[pixelIndex++]
				const a = (pixel >> 24) & 0xff

				if (a > 50) {
					const r = pixel & 0xff
					const g = (pixel >> 8) & 0xff
					const b = (pixel >> 16) & 0xff

					// Fast integer luminance: (r * 77 + g * 150 + b * 29) >> 8
					const luminance = (r * 77 + g * 150 + b * 29) >> 8
					if (luminance < 200) {
						byteVal |= 1 << (7 - bit)
					}
				}
			}
			escposBytes[destIndex++] = byteVal
		}
	}

	for (let i = 0; i < feedsCount; i++) {
		escposBytes[destIndex++] = 0x0a
	}
	escposBytes[destIndex++] = GS
	escposBytes[destIndex++] = 0x56
	escposBytes[destIndex++] = 66
	escposBytes[destIndex++] = 0

	// Reset printer state at the end
	escposBytes[destIndex++] = COMMANDS.INITIALIZE[0]
	escposBytes[destIndex++] = COMMANDS.INITIALIZE[1]

	await printerService.printRaw(escposBytes)
}

export async function printInvoiceToAllPrinters(invoiceData: any): Promise<void> {
	const store = useBluetoothPrinterStore()
	if (!store.isEnabled || store.printers.length === 0) {
		throw new Error("No printers configured or printer integration is disabled.")
	}

	const originalActiveId = store.activePrinterId
	let printedCount = 0
	let lastError: any = null

	try {
		for (const printer of store.printers) {
			try {
				const printFormatName = printer.printFormat || null
				if (!printFormatName) {
					log.info(`Printer Router: Skipping printer ${printer.name} because it has no Target Print Format`)
					continue
				}

				// Temporarily activate this printer to load its specific configuration
				store.setActivePrinter(printer.id)

				// Check connection and reconnect if device differs
				if (printerService.getConnectedDeviceId() !== printer.deviceId || !printerService.isConnected()) {
					log.info(`Printer Router: Connecting to physical device ${printer.deviceId} for printer ${printer.name}`)
					const success = await printerService.tryAutoReconnect(printer.deviceId, printer.type)
					if (!success) {
						throw new Error(`Could not connect to printer ${printer.name}`)
					}
					// Sync connection state with store
					store.setConnected(printer.deviceId, true)
				}

				log.info(`Printer Router: Printing to ${printer.name} with format ${printFormatName}`)

				try {
					await printInvoiceFormatToBluetooth(invoiceData, printFormatName)
				} catch (fmtError) {
					log.warn("Bluetooth print format failed, falling back to standard Bluetooth receipt layout:", fmtError)
					await printInvoiceToBluetooth(invoiceData)
				}
				printedCount++

				// If there are multiple printers, give a small cooldown delay between jobs
				if (store.printers.length > 1) {
					await new Promise(resolve => setTimeout(resolve, 600))
				}
			} catch (printerErr) {
				log.error(`Failed printing to printer ${printer.name}:`, printerErr)
				lastError = printerErr
			}
		}
	} finally {
		if (originalActiveId) {
			store.setActivePrinter(originalActiveId)
			// Reconnect active printer if it was changed
			const activePrinter = store.printers.find(p => p.id === originalActiveId)
			if (activePrinter && printerService.getConnectedDeviceId() !== activePrinter.deviceId) {
				printerService.tryAutoReconnect(activePrinter.deviceId, activePrinter.type).then(success => {
					if (success) {
						store.setConnected(activePrinter.deviceId, true)
					}
				}).catch(e => log.warn("Failed to reconnect default active printer:", e))
			}
		}
	}

	if (printedCount === 0 && lastError) {
		throw lastError
	}
}