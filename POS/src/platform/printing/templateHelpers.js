/**
 * The functions a print template may call. The device and the Desk preview both use
 * this module, so what the manager sees in the preview is what the printer gets.
 *
 * Nothing here may load anything from the network: images come back as data URIs, so
 * a receipt prints offline and a canvas that draws it is never tainted.
 *
 * @module platform/printing/templateHelpers
 */

import JsBarcode from "jsbarcode"
import QRCode from "qrcode"

// ============================================================================
// Currencies
// ============================================================================

/** Symbols that read well on paper. The app's own SAR symbol needs a font a receipt does not carry. */
const SYMBOLS = {
	SAR: { ar: "ر.س", en: "SAR" },
	AED: { ar: "د.إ", en: "AED" },
	EGP: { ar: "ج.م", en: "EGP" },
	KWD: { ar: "د.ك", en: "KWD" },
	BHD: { ar: "د.ب", en: "BHD" },
	OMR: { ar: "ر.ع", en: "OMR" },
	QAR: { ar: "ر.ق", en: "QAR" },
	JOD: { ar: "د.أ", en: "JOD" },
	YER: { ar: "ر.ي", en: "YER" },
	USD: "$",
	EUR: "€",
	GBP: "£",
}

/** Currencies with three decimal places */
const THREE_DECIMALS = new Set(["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"])

/**
 * Names for money in words. Arabic nouns take one form for one, another for two,
 * a plural from three to ten and the singular accusative from eleven on.
 */
const MONEY_NAMES = {
	YER: {
		fractionEn: "Fils",
		ar: [
			["ريال يمني", "ريالان يمنيان", "ريالات يمنية", "ريالاً يمنياً"],
			["فلس", "فلسان", "فلوس", "فلساً"],
		],
	},
	SAR: {
		fractionEn: "Halala",
		ar: [
			["ريال سعودي", "ريالان سعوديان", "ريالات سعودية", "ريالاً سعودياً"],
			["هللة", "هللتان", "هللات", "هللة"],
		],
	},
	AED: {
		fractionEn: "Fils",
		ar: [
			["درهم إماراتي", "درهمان إماراتيان", "دراهم إماراتية", "درهماً إماراتياً"],
			["فلس", "فلسان", "فلوس", "فلساً"],
		],
	},
	EGP: {
		fractionEn: "Piastre",
		ar: [
			["جنيه مصري", "جنيهان مصريان", "جنيهات مصرية", "جنيهاً مصرياً"],
			["قرش", "قرشان", "قروش", "قرشاً"],
		],
	},
	KWD: {
		fractionEn: "Fils",
		ar: [
			["دينار كويتي", "ديناران كويتيان", "دنانير كويتية", "ديناراً كويتياً"],
			["فلس", "فلسان", "فلوس", "فلساً"],
		],
	},
	BHD: {
		fractionEn: "Fils",
		ar: [
			["دينار بحريني", "ديناران بحرينيان", "دنانير بحرينية", "ديناراً بحرينياً"],
			["فلس", "فلسان", "فلوس", "فلساً"],
		],
	},
	OMR: {
		fractionEn: "Baisa",
		ar: [
			["ريال عماني", "ريالان عمانيان", "ريالات عمانية", "ريالاً عمانياً"],
			["بيسة", "بيستان", "بيسات", "بيسة"],
		],
	},
	QAR: {
		fractionEn: "Dirham",
		ar: [
			["ريال قطري", "ريالان قطريان", "ريالات قطرية", "ريالاً قطرياً"],
			["درهم", "درهمان", "دراهم", "درهماً"],
		],
	},
	JOD: {
		fractionEn: "Fils",
		ar: [
			["دينار أردني", "ديناران أردنيان", "دنانير أردنية", "ديناراً أردنياً"],
			["فلس", "فلسان", "فلوس", "فلساً"],
		],
	},
	USD: {
		fractionEn: "Cent",
		ar: [
			["دولار", "دولاران", "دولارات", "دولاراً"],
			["سنت", "سنتان", "سنتات", "سنتاً"],
		],
	},
	EUR: {
		fractionEn: "Cent",
		ar: [
			["يورو", "يوروان", "يوروهات", "يورو"],
			["سنت", "سنتان", "سنتات", "سنتاً"],
		],
	},
}

/**
 * @param {string} currency
 * @returns {number} Decimal places the currency is written with
 */
export function currencyDecimals(currency) {
	return THREE_DECIMALS.has(String(currency || "").toUpperCase()) ? 3 : 2
}

const isArabic = (lang) => String(lang || "").toLowerCase().startsWith("ar")

const toNumber = (value) => {
	const number = typeof value === "number" ? value : Number.parseFloat(value)
	return Number.isFinite(number) ? number : 0
}

// ============================================================================
// Numbers in words
// ============================================================================

const EN_ONES = [
	"Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
	"Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
]
const EN_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]
const EN_SCALES = ["", "Thousand", "Million", "Billion", "Trillion"]

function englishBelowThousand(number) {
	const parts = []
	const hundreds = Math.floor(number / 100)
	const rest = number % 100
	if (hundreds) parts.push(`${EN_ONES[hundreds]} Hundred`)
	if (rest >= 20) parts.push(EN_TENS[Math.floor(rest / 10)] + (rest % 10 ? `-${EN_ONES[rest % 10]}` : ""))
	else if (rest) parts.push(EN_ONES[rest])
	return parts.join(" ")
}

/**
 * @param {number} number - A whole number
 * @returns {string}
 */
export function englishWords(number) {
	let rest = Math.floor(Math.abs(number))
	if (rest === 0) return EN_ONES[0]
	const groups = []
	for (let scale = 0; rest > 0 && scale < EN_SCALES.length; scale++) {
		const group = rest % 1000
		if (group) groups.unshift([englishBelowThousand(group), EN_SCALES[scale]].filter(Boolean).join(" "))
		rest = Math.floor(rest / 1000)
	}
	return groups.join(" ")
}

const AR_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"]
const AR_TEENS = [
	"عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر",
]
const AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"]
const AR_HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"]
/** [one and after hundreds, two, three to ten, eleven to ninety-nine] */
const AR_SCALES = [
	null,
	["ألف", "ألفان", "آلاف", "ألفاً"],
	["مليون", "مليونان", "ملايين", "مليوناً"],
	["مليار", "ملياران", "مليارات", "ملياراً"],
	["تريليون", "تريليونان", "تريليونات", "تريليوناً"],
]

function arabicBelowThousand(number) {
	const parts = []
	const hundreds = Math.floor(number / 100)
	const rest = number % 100
	if (hundreds) parts.push(AR_HUNDREDS[hundreds])
	if (rest >= 20) {
		parts.push(rest % 10 ? `${AR_ONES[rest % 10]} و${AR_TENS[Math.floor(rest / 10)]}` : AR_TENS[Math.floor(rest / 10)])
	} else if (rest >= 10) {
		parts.push(AR_TEENS[rest - 10])
	} else if (rest) {
		parts.push(AR_ONES[rest])
	}
	return parts.join(" و")
}

/**
 * Which of a noun's four forms goes with a count: the singular for one and after a
 * round hundred (مائة ريال), the dual for two, the plural from three to ten (خمسة
 * ريالات), and the accusative singular from eleven to ninety-nine (عشرون ريالاً).
 * @param {number} count
 * @returns {0|1|2|3}
 */
export function arabicCountForm(count) {
	const lastTwo = count % 100
	if (count === 2) return 1
	if (lastTwo >= 3 && lastTwo <= 10) return 2
	if (lastTwo >= 11) return 3
	return 0
}

/**
 * @param {number} number - A whole number
 * @returns {string}
 */
export function arabicWords(number) {
	let rest = Math.floor(Math.abs(number))
	if (rest === 0) return "صفر"
	const groups = []
	for (let scale = 0; rest > 0 && scale < AR_SCALES.length; scale++) {
		const group = rest % 1000
		if (group) {
			const names = AR_SCALES[scale]
			// The last word before the currency is joined to it: خمسة عشر ألف ريال, not ألفاً
			const form = arabicCountForm(group) === 3 && groups.length === 0 ? 0 : arabicCountForm(group)
			if (!names) groups.unshift(arabicBelowThousand(group))
			else if (group === 1) groups.unshift(names[0])
			else if (group === 2) groups.unshift(names[1])
			else groups.unshift(`${arabicBelowThousand(group)} ${names[form]}`)
		}
		rest = Math.floor(rest / 1000)
	}
	return groups.join(" و")
}

// ============================================================================
// Dates
// ============================================================================

const pad = (number) => String(number).padStart(2, "0")

/**
 * Read a Frappe date or datetime as local time. new Date("2026-11-08") would be UTC
 * midnight, which is the day before west of Greenwich.
 * @param {string|number|Date} value
 * @returns {Date|null}
 */
export function parseDate(value) {
	if (value == null || value === "") return null
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
	if (typeof value === "number") return new Date(value)
	const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
	if (match) {
		const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match
		return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
	}
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

function writeDate(date, format) {
	return String(format || "dd-mm-yyyy")
		.replace(/yyyy/i, date.getFullYear())
		.replace(/mm/i, pad(date.getMonth() + 1))
		.replace(/dd/i, pad(date.getDate()))
}

// ============================================================================
// Images
// ============================================================================

/** @param {string} text - May hold Arabic */
function base64(text) {
	const bytes = new TextEncoder().encode(text)
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const svgDataUri = (svg) => `data:image/svg+xml;base64,${base64(svg)}`

/**
 * A QR code as an SVG data URI. Drawn as squares, so it stays sharp at any printer's
 * resolution.
 * @param {string} text
 * @param {{margin?: number}} [options]
 * @returns {string}
 */
export function qrDataUri(text, { margin = 2 } = {}) {
	const value = text == null ? "" : String(text)
	if (!value) return ""
	const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" })
	const size = modules.size + margin * 2
	let path = ""
	for (let y = 0; y < modules.size; y++) {
		for (let x = 0; x < modules.size; x++) {
			if (modules.data[y * modules.size + x]) path += `M${x + margin} ${y + margin}h1v1h-1z`
		}
	}
	return svgDataUri(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 4}" height="${size * 4}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`,
	)
}

/**
 * A CODE128 barcode as an SVG data URI.
 * @param {string} text
 * @param {Object} [options] - JsBarcode options, such as format, height or displayValue
 * @returns {string}
 */
export function barcodeDataUri(text, options = {}) {
	const value = text == null ? "" : String(text)
	if (!value || typeof document === "undefined") return ""
	const draw = (extra) => {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
		JsBarcode(svg, value, {
			format: "CODE128",
			height: 50,
			margin: 4,
			fontSize: 14,
			...options,
			...extra,
			xmlDocument: document,
		})
		return svg
	}
	let svg
	try {
		svg = draw({})
	} catch {
		// The text under the bars is measured on a canvas; with none, the bars alone still scan
		svg = draw({ displayValue: false })
	}
	svg.setAttribute("xmlns", "http://www.w3.org/2000/svg")
	return svgDataUri(new XMLSerializer().serializeToString(svg))
}

// ============================================================================
// The helpers a template sees
// ============================================================================

/**
 * @param {{lang?: string, dateFormat?: string, timeFormat?: string, precision?: number, translate?: Function}} [options]
 * @returns {Object} Functions by the names templates call them
 */
export function createHelpers(options = {}) {
	const lang = options.lang || "en"
	const arabic = isArabic(lang)

	function translate(text, args) {
		const source = text == null ? "" : String(text)
		const own = options.translate || (typeof globalThis.__ === "function" ? globalThis.__ : null)
		const translated = own ? String(own(source, args) ?? source) : source
		// A plain (text) => string translator leaves the placeholders to fill here
		return args ? translated.replace(/\{(\d+)\}/g, (match, index) => (args[index] ?? match)) : translated
	}

	function format_number(value, precision) {
		const digits = precision == null ? undefined : Number(precision)
		return new Intl.NumberFormat("en-US", {
			minimumFractionDigits: digits ?? 0,
			maximumFractionDigits: digits ?? 3,
		}).format(toNumber(value))
	}

	function format_currency(value, currency, precision) {
		const code = String(currency || options.currency || "").toUpperCase()
		const digits = precision ?? (THREE_DECIMALS.has(code) ? 3 : (options.precision ?? 2))
		const number = toNumber(value)
		const amount = format_number(Math.abs(number), digits)
		const sign = number < 0 ? "-" : ""
		const symbol = SYMBOLS[code]
		if (typeof symbol === "string") return `${sign}${symbol}${amount}`
		const label = symbol ? symbol[arabic ? "ar" : "en"] : code
		if (!label) return `${sign}${amount}`
		return arabic ? `${sign}${amount} ${label}` : `${sign}${label} ${amount}`
	}

	function format_date(value, format) {
		const date = parseDate(value)
		return date ? writeDate(date, format || options.dateFormat) : ""
	}

	function format_datetime(value, format) {
		const date = parseDate(value)
		if (!date) return ""
		return `${writeDate(date, format || options.dateFormat)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
	}

	function money_in_words(value, currency) {
		const code = String(currency || options.currency || "").toUpperCase()
		const decimals = currencyDecimals(code)
		const scale = 10 ** decimals
		const total = Math.round(Math.abs(toNumber(value)) * scale)
		const main = Math.floor(total / scale)
		const fraction = total % scale
		const names = MONEY_NAMES[code]

		if (arabic) {
			const [mainNames, fractionNames] = names?.ar || [[code, code, code, code], null]
			const mainText = main
				? main <= 2
					? mainNames[main - 1]
					: `${arabicWords(main)} ${mainNames[arabicCountForm(main)]}`
				: `صفر ${mainNames[0]}`
			let text = `فقط ${mainText}`
			if (fraction) {
				text += fractionNames
					? ` و${fraction <= 2 ? fractionNames[fraction - 1] : `${arabicWords(fraction)} ${fractionNames[arabicCountForm(fraction)]}`}`
					: ` و${fraction}/${scale}`
			}
			return `${text} لا غير`
		}

		// As Frappe writes it: "SAR One Hundred and Fifty Halala only."
		const fractionName = names?.fractionEn
		let text = [code, englishWords(main)].filter(Boolean).join(" ")
		if (fraction) {
			text += fractionName ? ` and ${englishWords(fraction)} ${fractionName}` : ` and ${fraction}/${scale}`
		}
		return `${text} only.`
	}

	return {
		_: translate,
		format_currency,
		format_number,
		format_date,
		format_datetime,
		money_in_words,
		format_time: (value) => (value == null ? "" : String(value).split(".")[0]),
		qr: (text) => qrDataUri(text),
		barcode: (text, barcodeOptions) => barcodeDataUri(text, barcodeOptions || {}),
	}
}
