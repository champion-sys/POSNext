/**
 * What a print template sees: {doc, company, pos_profile, cashier, customer, print}.
 * The server sends this for a posted invoice; offline it is built here from the sale the
 * device kept, with the company and profile from the cached print bundle.
 *
 * @module platform/printing/context
 */

import { isDeviceName } from "@/utils/offline/localNumber"
import { normalizePaper } from "./template"

const num = (value) => {
	const number = typeof value === "number" ? value : Number.parseFloat(value)
	return Number.isFinite(number) ? number : 0
}

const round = (value, digits = 2) => Math.round(num(value) * 10 ** digits) / 10 ** digits

/**
 * The language and direction receipts print in: the interface's.
 * @returns {{lang: string, rtl: boolean}}
 */
export function currentPrintLanguage() {
	let lang = ""
	let dir = ""
	try {
		lang = document.documentElement.getAttribute("lang") || ""
		dir = document.documentElement.getAttribute("dir") || ""
	} catch {}
	if (!lang) {
		try {
			lang = localStorage.getItem("pos_next_language") || ""
		} catch {}
	}
	lang = (lang || "en").toLowerCase()
	return { lang, rtl: dir ? dir === "rtl" : lang.startsWith("ar") }
}

/**
 * One invoice row with the fields Frappe templates use, whatever kept it.
 * @param {Object} item
 * @param {number} index
 * @param {boolean} queued - A row the cart queued: its discount_amount is the whole
 *   line's, where ERPNext's is per unit
 * @returns {Object}
 */
function normalizeItem(item, index, queued) {
	const qty = num(item.qty ?? item.quantity)
	const rate = num(item.rate ?? item.price_list_rate)
	const amount = item.amount != null ? num(item.amount) : round(qty * rate)
	const discount = num(item.discount_amount)
	return {
		...item,
		idx: item.idx ?? index + 1,
		item_name: item.item_name || item.item_code || "",
		qty,
		quantity: qty,
		rate,
		price_list_rate: num(item.price_list_rate ?? rate),
		amount,
		net_amount: item.net_amount != null ? num(item.net_amount) : amount,
		discount_amount: queued && qty ? round(discount / qty, 6) : discount,
		discount_percentage: num(item.discount_percentage),
		uom: item.uom || item.stock_uom || "",
	}
}

/**
 * The invoice a template prints. Fields the device lacks are worked out from the ones
 * it has, so a template written for a posted invoice also prints a queued one.
 *
 * @param {Object} source - A server invoice, or the receipt the checkout kept offline
 * @param {Object} [defaults] - {currency, company}
 * @returns {Object}
 */
export function normalizePrintDoc(source = {}, defaults = {}) {
	const queued = Boolean(source.is_offline)
	const items = (source.items || []).map((item, index) => normalizeItem(item, index, queued))
	const allPayments = (source.payments || []).map((payment) => ({ ...payment, amount: num(payment.amount) }))
	// Modes of payment left at zero are not printed, unless none was used at all
	const usedPayments = allPayments.filter((payment) => payment.amount !== 0)
	const payments = usedPayments.length ? usedPayments : allPayments
	const taxes = (source.taxes || []).map((tax, index) => ({
		...tax,
		idx: tax.idx ?? index + 1,
		description: tax.description || tax.account_head || "",
		rate: num(tax.rate),
		tax_amount: num(tax.tax_amount),
	}))
	const totalTaxes = num(source.total_taxes_and_charges ?? source.total_tax)
	const grandTotal = num(source.grand_total)
	const netTotal =
		source.net_total != null
			? num(source.net_total)
			: round(items.reduce((sum, item) => sum + item.net_amount, 0))
	const paid =
		source.paid_amount != null
			? num(source.paid_amount)
			: round(payments.reduce((sum, payment) => sum + payment.amount, 0))

	const docName = source.name || source.offline_id || ""
	const localNumber = source.posa_local_number || ""
	// A sale the server has not named prints its local number, never the device's id
	const onDeviceOnly = queued || !docName || isDeviceName(docName)

	return {
		...source,
		name: onDeviceOnly && localNumber ? localNumber : docName,
		posa_local_number: localNumber,
		offline_id: source.offline_id || (queued || isDeviceName(source.name) ? source.name : null) || null,
		is_offline: Boolean(source.is_offline),
		is_return: Boolean(num(source.is_return)),
		return_against: source.return_against || null,
		currency: source.currency || defaults.currency || "",
		company: source.company || defaults.company || "",
		customer: source.customer || source.customer_name || "",
		customer_name: source.customer_name || source.customer || "",
		posting_date: source.posting_date || "",
		posting_time: source.posting_time || "",
		items,
		taxes,
		payments,
		total_qty: source.total_qty != null ? num(source.total_qty) : items.reduce((sum, item) => sum + item.qty, 0),
		total: source.total != null ? num(source.total) : netTotal,
		net_total: netTotal,
		total_taxes_and_charges: totalTaxes,
		discount_amount: num(source.discount_amount ?? source.additional_discount_amount),
		grand_total: grandTotal,
		rounded_total: source.rounded_total != null ? num(source.rounded_total) : grandTotal,
		rounding_adjustment: num(source.rounding_adjustment),
		paid_amount: paid,
		change_amount: num(source.change_amount),
		outstanding_amount: num(source.outstanding_amount),
	}
}

/**
 * The whole template context.
 *
 * @param {Object} options
 * @param {Object} options.doc - The invoice, from the server or the device
 * @param {Object} [options.bundle] - The print bundle kept for the profile
 * @param {Object} [options.template] - The template, for its paper and copies
 * @param {{user?: string, full_name?: string}} [options.cashier]
 * @param {Object} [options.customer] - Customer details the device has
 * @param {Object} [options.print] - lang, rtl and reprint, to override the interface's
 * @param {Object} [options.server] - {company, pos_profile, cashier, customer} from get_print_context
 * @returns {{doc: Object, company: Object, pos_profile: Object, cashier: Object, customer: Object, print: Object}}
 */
/**
 * An address as plain lines, as the server sends it. Frappe keeps address_display as HTML
 * with <br>, which a template would print as text.
 * @param {string} [value]
 * @returns {string}
 */
export function addressLines(value) {
	if (!value) return ""
	const text = String(value)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n")
}

export function buildPrintContext({ doc, bundle, template, cashier, customer, print, server } = {}) {
	const company = { ...(bundle?.company || {}), ...(server?.company || {}) }
	const posProfile = { ...(bundle?.pos_profile || {}), ...(server?.pos_profile || {}) }
	const printDoc = normalizePrintDoc(doc, {
		currency: posProfile.currency || company.currency,
		company: company.name,
	})

	const cashierInfo = {
		user: printDoc.cashier || printDoc.owner || "",
		full_name: printDoc.cashier_name || printDoc.owner || "",
		...(cashier || {}),
		...(server?.cashier || {}),
	}
	if (!cashierInfo.full_name) cashierInfo.full_name = cashierInfo.user

	const customerInfo = {
		name: printDoc.customer,
		customer_name: printDoc.customer_name,
		tax_id: printDoc.customer_tax_id || printDoc.tax_id || "",
		mobile_no: printDoc.customer_mobile || printDoc.contact_mobile || "",
		address: addressLines(printDoc.customer_address_display || printDoc.address_display),
		...(customer || {}),
		...(server?.customer || {}),
	}

	const language = currentPrintLanguage()
	return {
		doc: printDoc,
		company,
		pos_profile: posProfile,
		cashier: cashierInfo,
		customer: customerInfo,
		print: {
			paper: normalizePaper(template?.paper),
			lang: language.lang,
			rtl: language.rtl,
			copy: 1,
			copies: Math.max(1, Number.parseInt(template?.copies, 10) || 1),
			reprint: false,
			...(print || {}),
		},
	}
}
