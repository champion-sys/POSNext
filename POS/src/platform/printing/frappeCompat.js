/**
 * What a Frappe Print Format calls that the device can do without a server: doc.get,
 * doc.get_formatted, and the formatting functions on `frappe`. Anything that reads the
 * database is missing on purpose; the server refuses such a format for POS devices.
 *
 * @module platform/printing/frappeCompat
 */

const MONEY_FIELD = /(amount|rate|total|price|tax|paid|change|outstanding|write_off|discount|balance|net|value)$/i
const NUMBER_FIELD = /(qty|percentage|percent|factor|conversion)/i
const DATE_FIELD = /(^|_)date$/i
const DATETIME_FIELD = /(datetime|creation|modified)$/i

const toFloat = (value, precision) => {
	const number = Number.parseFloat(value)
	if (!Number.isFinite(number)) return 0
	return precision == null ? number : Number(number.toFixed(Number(precision)))
}

/**
 * @param {Object} helpers - from createHelpers
 * @param {string} [currency] - The invoice's currency, for money fields
 */
function formatter(helpers, currency) {
	return function formatField(fieldname, value, options = {}) {
		if (value == null || value === "") return ""
		const field = String(fieldname || "")
		if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))) {
			if (NUMBER_FIELD.test(field)) return helpers.format_number(value)
			if (MONEY_FIELD.test(field)) {
				const amount = options.absolute ? Math.abs(Number(value)) : value
				return helpers.format_currency(amount, options.currency || currency)
			}
		}
		if (DATETIME_FIELD.test(field)) return helpers.format_datetime(value)
		if (DATE_FIELD.test(field)) return helpers.format_date(value)
		return String(value)
	}
}

function addMethods(row, formatField, parent) {
	Object.defineProperty(row, "get", {
		value(fieldname, fallback) {
			const value = row[fieldname]
			return value === undefined ? (fallback ?? null) : value
		},
		enumerable: false,
	})
	Object.defineProperty(row, "get_formatted", {
		// Frappe's own: get_formatted(fieldname, doc=None, currency=None, absolute_value=False)
		value(fieldname, _doc, currency, absoluteValue) {
			return formatField(fieldname, row[fieldname], {
				currency: currency || row.currency || parent?.currency,
				absolute: Boolean(absoluteValue),
			})
		},
		enumerable: false,
	})
	return row
}

/**
 * A copy of the invoice whose rows answer get and get_formatted as a Frappe document does.
 * The invoice the device keeps is left as it is.
 * @param {Object} doc
 * @param {Object} helpers
 * @returns {Object}
 */
export function withDocMethods(doc, helpers) {
	const source = doc || {}
	const formatField = formatter(helpers, source.currency)
	const copy = { ...source }
	for (const [key, value] of Object.entries(copy)) {
		if (Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
			copy[key] = value.map((row) => addMethods({ ...row }, formatField, copy))
		}
	}
	return addMethods(copy, formatField, null)
}

/**
 * The parts of `frappe` a template may use on the device.
 * @param {Object} helpers
 * @param {string} [currency]
 */
export function frappeShim(helpers, currency) {
	const formatField = formatter(helpers, currency)
	const formatValue = (value, df = {}) => {
		const type = String(df?.fieldtype || "")
		if (type === "Currency") return helpers.format_currency(value, df.options && !String(df.options).includes(":") ? df.options : currency)
		if (type === "Float" || type === "Int" || type === "Percent") return helpers.format_number(value, df.precision)
		if (type === "Date") return helpers.format_date(value)
		if (type === "Datetime") return helpers.format_datetime(value)
		return formatField(df?.fieldname, value)
	}
	return {
		_: helpers._,
		format: formatValue,
		format_value: formatValue,
		format_date: (value, format) => helpers.format_date(value, format),
		utils: {
			fmt_money: (amount, precision, code) => helpers.format_currency(amount, code || currency, precision ?? undefined),
			formatdate: (value, format) => helpers.format_date(value, format),
			format_date: (value, format) => helpers.format_date(value, format),
			format_datetime: (value, format) => helpers.format_datetime(value, format),
			money_in_words: (value, code) => helpers.money_in_words(value, code || currency),
			flt: (value, precision) => toFloat(value, precision),
			cint: (value) => Number.parseInt(value, 10) || 0,
			cstr: (value) => (value == null ? "" : String(value)),
		},
	}
}
