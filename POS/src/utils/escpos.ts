import { logger } from "./logger"

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
	SELECT_CP1256: new Uint8Array([ESC, 0x74, 50]), // Select Arabic code page (often 50 or 22/WCP1256)
}

// Map Arabic unicode characters to CP1256 (Windows-1256)
const ARABIC_TO_CP1256: Record<number, number> = {
	0x060c: 0xa1, // Arabic comma
	0x061b: 0xba, // Arabic semicolon
	0x061f: 0xbf, // Arabic question mark
	0x0621: 0xc1, // Hamza
	0x0622: 0xc2, // Alef with Madda
	0x0623: 0xc3, // Alef with Hamza Above
	0x0624: 0xc4, // Waw with Hamza Above
	0x0625: 0xc5, // Alef with Hamza Below
	0x0626: 0xc6, // Yeh with Hamza Above
	0x0627: 0xc7, // Alef
	0x0628: 0xc8, // Beh
	0x0629: 0xc9, // Teh Marbuta
	0x062a: 0xca, // Teh
	0x062b: 0xcb, // Theh
	0x062c: 0xcc, // Jeem
	0x062d: 0xcd, // Hah
	0x062e: 0xce, // Khav
	0x062f: 0xcf, // Dal
	0x0630: 0xd0, // Thal
	0x0631: 0xd1, // Reh
	0x0632: 0xd2, // Zain
	0x0633: 0xd3, // Seen
	0x0634: 0xd4, // Sheen
	0x0635: 0xd5, // Sad
	0x0636: 0xd6, // Dad
	0x0637: 0xd7, // Tah
	0x0638: 0xd8, // Zah
	0x0639: 0xd9, // Ain
	0x063a: 0xda, // Ghain
	0x0641: 0xe1, // Feh
	0x0642: 0xe2, // Qaf
	0x0643: 0xe3, // Kaf
	0x0644: 0xe4, // Lam
	0x0645: 0xe5, // Meem
	0x0646: 0xe6, // Noon
	0x0647: 0xe7, // Heh
	0x0648: 0xe8, // Waw
	0x0649: 0xe9, // Alef Maksura
	0x064a: 0xea, // Yeh
	// Perso-Arabic extensions (optional, fallback)
	0x067e: 0x81, // Peh
	0x0686: 0x8d, // Tcheh
	0x0698: 0x8f, // Jeh
	0x06a9: 0x8e, // Keheh
	0x06af: 0x90, // Gaf
}

/**
 * Encodes a string into CP1256 (Arabic Windows) byte array
 */
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

/**
 * Basic Arabic character reshaping for older printers
 * Converts text into correct forms (Isolated, Initial, Medial, Final) and reverses word order for RTL
 */
export function reshapeArabic(text: string): string {
	// Simple shaping map for primary letters
	// Letter: [Isolated, End, Medial, Beginning]
	const shapingMap: Record<number, [string, string, string, string]> = {
		0x0627: ["ا", "ـا", "ـا", "ا"],
		0x0628: ["ب", "ـب", "ـبـ", "بـ"],
		0x062a: ["ت", "ـت", "ـتـ", "تـ"],
		0x062b: ["ث", "ـث", "ـثـ", "ثـ"],
		0x062c: ["ج", "ـج", "ـجـ", "جـ"],
		0x062d: ["ح", "ـح", "ـحـ", "حـ"],
		0x062e: ["خ", "ـخ", "ـخـ", "خـ"],
		0x062f: ["د", "ـد", "ـد", "د"],
		0x0630: ["ذ", "ـذ", "ـذ", "ذ"],
		0x0631: ["ر", "ـر", "ـر", "ر"],
		0x0632: ["ز", "ـز", "ـز", "ز"],
		0x0633: ["س", "ـس", "ـسـ", "سـ"],
		0x0634: ["ش", "ـش", "ـشـ", "شـ"],
		0x0635: ["ص", "ـص", "ـصـ", "صـ"],
		0x0636: ["ض", "ـض", "ـضـ", "ضـ"],
		0x0637: ["ط", "ـط", "ـطـ", "طـ"],
		0x0638: ["ظ", "ـظ", "ـظـ", "ظـ"],
		0x0639: ["ع", "ـع", "ـعـ", "عـ"],
		0x063a: ["غ", "ـغ", "ـغـ", "غـ"],
		0x0641: ["ف", "ـف", "ـفـ", "فـ"],
		0x0642: ["ق", "ـق", "ـقـ", "قـ"],
		0x0643: ["ك", "ـك", "ـكـ", "كـ"],
		0x0644: ["ل", "ـل", "ـلـ", "لـ"],
		0x0645: ["م", "ـم", "ـمـ", "مـ"],
		0x0646: ["ن", "ـن", "ـنـ", "نـ"],
		0x0647: ["ه", "ـه", "ـهـ", "هـ"],
		0x0648: ["و", "ـو", "ـو", "و"],
		0x064a: ["ي", "ـي", "ـيـ", "يـ"],
		0x0629: ["ة", "ـة", "ـة", "ة"],
		0x0649: ["ى", "ـى", "ـى", "ى"],
	}

	const isLinkerBefore = (char: string): boolean => {
		if (!char) return false
		const code = char.charCodeAt(0)
		// Non-linkers (don't connect to the next character)
		const nonLinkers = [0x0627, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0622, 0x0623, 0x0625]
		return shapingMap[code] !== undefined && !nonLinkers.includes(code)
	}

	const isLinkerAfter = (char: string): boolean => {
		if (!char) return false
		const code = char.charCodeAt(0)
		return shapingMap[code] !== undefined
	}

	let result = ""
	const words = text.split(" ")

	// Reshape each word individually
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
					reshapedWord += mapping[2] // Medial
				} else if (connectsBefore) {
					reshapedWord += mapping[1] // Final
				} else if (connectsAfter) {
					reshapedWord += mapping[3] // Initial
				} else {
					reshapedWord += mapping[0] // Isolated
				}
			} else {
				reshapedWord += char
			}
		}
		// Reverse character order for Right-to-Left print flow
		return reshapedWord.split("").reverse().join("")
	})

	// Reverse word order as well for proper RTL sequence
	return reshapedWords.reverse().join(" ")
}

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
	width: number = 384 // 58mm = 384px, 80mm = 576px
): Promise<Uint8Array> {
	const canvas = document.createElement("canvas")
	canvas.width = width
	const ctx = canvas.getContext("2d")
	if (!ctx) {
		throw new Error("Could not create 2D canvas context")
	}

	// First pass: Measure height dynamically
	let currentY = 10
	ctx.font = "normal 14px sans-serif"
	const lineHeightNormal = 22
	const lineHeightLarge = 30

	lines.forEach((line) => {
		if (line.size === "large") {
			currentY += lineHeightLarge
		} else {
			currentY += lineHeightNormal
		}
	})
	currentY += 20 // Padding at bottom

	canvas.height = currentY

	// Second pass: Draw receipt content with transparent background (will treat non-transparent as black)
	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	ctx.fillStyle = "#000000"

	currentY = 10
	lines.forEach((line) => {
		const isLarge = line.size === "large"
		ctx.font = `${line.bold ? "bold" : "normal"} ${isLarge ? "18px" : "14px"} sans-serif`
		const textWidth = ctx.measureText(line.text).width

		let x = 0
		if (line.align === "center") {
			x = (width - textWidth) / 2
		} else if (line.align === "right") {
			x = width - textWidth - 5
		} else {
			x = 5
		}

		ctx.fillText(line.text, x, currentY + (isLarge ? 16 : 12))
		currentY += isLarge ? lineHeightLarge : lineHeightNormal
	})

	// Convert canvas image to ESC/POS raster bit image format
	const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
	const data = imgData.data
	const height = canvas.height
	const widthBytes = width / 8

	const escposBytes: number[] = []

	// GS v 0 m xL xH yL yH d1...dk
	const xL = widthBytes % 256
	const xH = Math.floor(widthBytes / 256)
	const yL = height % 256
	const yH = Math.floor(height / 256)

	// Command header
	escposBytes.push(GS, 0x76, 0x30, 0, xL, xH, yL, yH)

	// Pack 8 pixels into 1 byte
	for (let y = 0; y < height; y++) {
		for (let xByte = 0; xByte < widthBytes; xByte++) {
			let byteVal = 0
			for (let bit = 0; bit < 8; bit++) {
				const xPixel = xByte * 8 + bit
				const pixelIndex = (y * width + xPixel) * 4

				// Read red, green, blue values
				const r = data[pixelIndex]
				const g = data[pixelIndex + 1]
				const b = data[pixelIndex + 2]
				const a = data[pixelIndex + 3]

				// Calculate luminance (0.299R + 0.587G + 0.114B)
				const luminance = 0.299 * r + 0.587 * g + 0.114 * b

				// If pixel is dark and not transparent, set the bit to 1 (black)
				if (a > 50 && luminance < 128) {
					byteVal |= 1 << (7 - bit)
				}
			}
			escposBytes.push(byteVal)
		}
	}

	return new Uint8Array(escposBytes)
}
