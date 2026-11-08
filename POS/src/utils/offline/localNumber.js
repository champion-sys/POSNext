/**
 * The local invoice number every sale and return made on this device gets at once:
 * "L" + the naming series ERPNext would use, resolved for the sale's date, + the shift's
 * number + "-" + a counter. LACC-SINV-2026-3-00001 is the first sale of shift
 * POSA-OS-26-0000003 under ACC-SINV-.YYYY.-.
 *
 * It is printed before the server has a name for the sale, and stays on the invoice after
 * it gets one, so either number finds it. It is not what the server dedupes by: offline_id is.
 *
 * Pure helpers, no store or database imports.
 *
 * @module utils/offline/localNumber
 */

import { isLocalName } from "./entities"

export const SALE = "sale"
export const RETURN = "return"

/** Digits of the counter, as in LACC-SINV-2026-3-00001 */
const COUNTER_DIGITS = 5

/** Given to a shift opened offline, which has no number until the server names it */
const LOCAL_SHIFT_PREFIX = "OF"

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

/** ERPNext's naming_series_variables the device cannot work out: dropped */
const UNRESOLVED_VARIABLES = new Set(["FY", "TFY", "ABBR", "timestamp"])

/** A part Frappe would read from a field of the document, which the device does not have */
const FIELD_PART = /^[a-z_][a-z0-9_]*$/

const pad = (value, digits = 2) => String(value).padStart(digits, "0")

/**
 * @param {string|Date|number} [value] - posting_date as "YYYY-MM-DD", or a date
 * @returns {Date} On the device's calendar, so a date string does not move a day in UTC
 */
function toLocalDate(value) {
	if (typeof value === "string") {
		const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
		if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
	}
	const date = value instanceof Date ? value : new Date(value ?? Date.now())
	return Number.isNaN(date.getTime()) ? new Date() : date
}

function dayOfYear(date) {
	const start = new Date(date.getFullYear(), 0, 1)
	return Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000) + 1
}

/** As Frappe's determine_consecutive_week_number: the ISO week, kept in order across the year */
function consecutiveWeek(date) {
	const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
	const weekday = day.getUTCDay() || 7
	day.setUTCDate(day.getUTCDate() + 4 - weekday)
	const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
	const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7)
	if (date.getMonth() === 0 && week >= 52) return "00"
	if (date.getMonth() === 11 && week <= 1) return "53"
	return pad(week)
}

function resolvePart(part, date) {
	if (!part || part.startsWith("#")) return ""
	switch (part) {
		case "YYYY":
			return String(date.getFullYear())
		case "YY":
			return pad(date.getFullYear() % 100)
		case "MM":
			return pad(date.getMonth() + 1)
		case "DD":
			return pad(date.getDate())
		case "MON":
			return MONTHS[date.getMonth()]
		case "JJJ":
			return pad(dayOfYear(date), 3)
		case "WW":
			return consecutiveWeek(date)
	}
	if (part.startsWith("{") || UNRESOLVED_VARIABLES.has(part) || FIELD_PART.test(part)) return ""
	return part
}

/**
 * A naming series as Frappe's parse_naming_series reads it, without the counter: the parts
 * between dots, date parts for the sale's date, # parts and parts it cannot work out left out.
 * @param {string} series - e.g. ACC-SINV-.YYYY.-
 * @param {string|Date} [date] - The sale's posting_date
 * @returns {string} e.g. ACC-SINV-2026-
 */
export function resolveNamingSeries(series, date) {
	if (!series) return ""
	const day = toLocalDate(date)
	return String(series)
		.split(".")
		.map((part) => resolvePart(part, day))
		.join("")
}

/** FNV-1a, so a name gives the same four hex digits on every device */
function shortHash(text) {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return (hash & 0xffff).toString(16).toUpperCase().padStart(4, "0")
}

/**
 * The shift's part of the number: the server's when it sent one, otherwise the last group of
 * digits in the shift's name as a number (POSA-OS-26-0000003 is 3). A shift opened offline
 * has a device id for a name, so it gets OF and four letters from that id instead: never a
 * number, so it cannot match a real shift's.
 * @param {string} shiftName - POS Opening Shift
 * @param {string|number|null} [serverNumber] - local_numbering.shift_number
 * @returns {string|null} null without a shift
 */
export function getShiftNumber(shiftName, serverNumber = null) {
	const fromServer = Number.parseInt(String(serverNumber ?? "").trim(), 10)
	if (Number.isFinite(fromServer) && fromServer >= 0) return String(fromServer)
	if (!shiftName) return null

	const name = String(shiftName)
	if (!isLocalName(name)) {
		const digits = name.match(/(\d+)\D*$/)
		if (digits) return String(Number.parseInt(digits[1], 10))
	}
	return `${LOCAL_SHIFT_PREFIX}${shortHash(name)}`
}

/**
 * Everything before the counter.
 * A return has its own series. With none, or the sale's own, RET- keeps it apart from the
 * sales, which count separately and would otherwise repeat their numbers.
 * @param {Object} options
 * @param {string} options.saleSeries
 * @param {string} [options.returnSeries]
 * @param {string} options.kind - SALE or RETURN
 * @param {string} options.shiftNumber
 * @param {string|Date} [options.date]
 * @returns {string|null} null without a series or a shift number
 */
export function buildNumberPrefix({ saleSeries, returnSeries, kind, shiftNumber, date }) {
	if (!saleSeries || !shiftNumber) return null
	if (kind !== RETURN) return `L${resolveNamingSeries(saleSeries, date)}${shiftNumber}-`
	if (returnSeries && returnSeries !== saleSeries) {
		return `L${resolveNamingSeries(returnSeries, date)}${shiftNumber}-`
	}
	return `L${resolveNamingSeries(saleSeries, date)}RET-${shiftNumber}-`
}

/**
 * @param {string} prefix - From buildNumberPrefix
 * @param {number} counter - From 1
 * @returns {string}
 */
export function formatLocalNumber(prefix, counter) {
	return `${prefix}${pad(counter, COUNTER_DIGITS)}`
}

/** Sales the server does not have yet carry the device's own id for a name */
export const isDeviceName = (name) =>
	typeof name === "string" && (name.startsWith("OFFLINE-") || isLocalName(name))

/**
 * The numbers to show for an invoice: the local number until the server names it, then the
 * server's name with the local number beside it.
 * @param {Object} invoice - A server row, a queued row ({data}) or a print doc
 * @returns {{primary: string, secondary: string|null}}
 */
export function getInvoiceNumbers(invoice) {
	if (!invoice) return { primary: "", secondary: null }
	const data = invoice.data || {}
	const localNumber = invoice.posa_local_number || data.posa_local_number || null
	const name = invoice.server_invoice || invoice.name || invoice.offline_id || data.offline_id || ""

	if (!name || isDeviceName(name)) return { primary: localNumber || name, secondary: null }
	return { primary: name, secondary: localNumber && localNumber !== name ? localNumber : null }
}

/**
 * Every number an invoice answers to: the server's name, the local number and the device id.
 * @param {Object} invoice
 * @returns {string[]}
 */
export function getInvoiceSearchNumbers(invoice) {
	if (!invoice) return []
	const data = invoice.data || {}
	return [
		invoice.name,
		invoice.posa_local_number,
		invoice.offline_id,
		invoice.server_invoice,
		data.posa_local_number,
		data.offline_id,
		invoice._original_invoice?.posa_local_number,
	].filter((value) => typeof value === "string" && value)
}

/**
 * Whether what the cashier typed is part of one of the invoice's numbers.
 * @param {Object} invoice
 * @param {string} term
 * @returns {boolean}
 */
export function matchesInvoiceNumber(invoice, term) {
	const needle = String(term || "").trim().toLowerCase()
	if (!needle) return false
	return getInvoiceSearchNumbers(invoice).some((number) => number.toLowerCase().includes(needle))
}

/**
 * The invoice whose number is exactly what the cashier typed.
 * @param {Array} invoices
 * @param {string} term
 * @returns {Object|null}
 */
export function findByInvoiceNumber(invoices, term) {
	const needle = String(term || "").trim().toLowerCase()
	if (!needle) return null
	return (
		(invoices || []).find((invoice) =>
			getInvoiceSearchNumbers(invoice).some((number) => number.toLowerCase() === needle),
		) || null
	)
}
