/**
 * Turns an invoice into a print job from the print template that applies to it. When no
 * template applies, or one fails, the answer is null and the caller prints the built-in
 * layouts exactly as before.
 *
 * @module platform/printing/templatePrint
 */

import { call } from "@/utils/apiWrapper"
import { useToast } from "@/composables/useToast"
import { logger } from "@/utils/logger"
import { chooseTemplate, getPrintBundle } from "./bundle"
import { buildPrintContext } from "./context"
import { normalizePaper, PAPERS, renderTemplate } from "./template"

const log = logger.create("TemplatePrint")

/** Sales the server does not have yet carry the device's own id */
const isLocalOnly = (name) =>
	typeof name === "string" && (name.startsWith("OFFLINE-") || name.startsWith("pos_offline_"))

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false

/**
 * An invoice the server has, read from the invoice history the device keeps.
 * @param {string} name
 * @param {string} profile
 * @returns {Promise<Object|null>}
 */
async function findInHistory(name, profile) {
	try {
		const { getCachedInvoiceHistory } = await import("@/utils/offline/sync")
		const invoices = await getCachedInvoiceHistory(profile, { limit: 100000 })
		return invoices.find((invoice) => invoice.name === name && invoice.items?.length) || null
	} catch (error) {
		log.warn("Invoice history not readable:", error?.message || error)
		return null
	}
}

/**
 * The context for an invoice. A sale only the device has is printed from what it kept;
 * one the server has comes from get_print_context, or from the device's copy offline.
 * @returns {Promise<Object|null>}
 */
async function contextFor(invoice, { bundle, template, profile, cashier, reprint }) {
	const print = { reprint: Boolean(reprint) }
	if (isLocalOnly(invoice.name) || invoice.is_offline) {
		if (!invoice.items?.length) return null
		return buildPrintContext({ doc: invoice, bundle, template, cashier, print })
	}

	if (isOnline()) {
		try {
			const server = await call("pos_next.api.print_templates.get_print_context", {
				invoice: invoice.name,
				doctype: invoice.doctype || "Sales Invoice",
			})
			if (server?.doc) return buildPrintContext({ doc: server.doc, server, bundle, template, print })
		} catch (error) {
			log.warn("Print context not fetched, printing from the device's copy:", error?.message || error)
		}
	}

	const kept = invoice.items?.length ? invoice : await findInHistory(invoice.name, profile)
	return kept ? buildPrintContext({ doc: kept, bundle, template, cashier, print }) : null
}

/**
 * @typedef {Object} TemplatePrintJob
 * @property {Object} template
 * @property {string} html - The whole document
 * @property {string} paper - "58mm", "80mm", "A4" or "A5"
 * @property {number} copies
 */

/**
 * @param {Object} invoice - Hydrated: a local sale carries its rows
 * @param {Object} options
 * @param {string} [options.profile] - The POS Profile, when the invoice does not name one
 * @param {string} [options.printerTemplate] - The printer's own choice of template
 * @param {{user?: string, full_name?: string}} [options.cashier]
 * @param {boolean} [options.reprint]
 * @param {(message: string) => void} [options.onError] - Told when the template is broken
 * @returns {Promise<TemplatePrintJob|null>} null prints the built-in layouts
 */
export async function prepareTemplatePrint(invoice, options = {}) {
	if (!invoice?.name) return null
	const profile = invoice.pos_profile || options.profile
	if (!profile) return null

	let bundle
	try {
		bundle = await getPrintBundle(profile)
	} catch (error) {
		log.warn("No print bundle:", error?.message || error)
		return null
	}
	const template = chooseTemplate(bundle, options.printerTemplate)
	if (!template) return null

	const context = await contextFor(invoice, { ...options, bundle, template, profile })
	if (!context) {
		log.warn("No invoice data to print the template with:", invoice.name)
		return null
	}

	try {
		const html = renderTemplate(template, context)
		return {
			template,
			html,
			paper: normalizePaper(template.paper),
			copies: Math.max(1, Number.parseInt(template.copies, 10) || 1),
		}
	} catch (error) {
		// A broken template must never stop a sale: say why, and print the built-in receipt
		log.error("Print template failed:", error)
		const message = `${error?.message || error}. ${__("The standard receipt was printed instead.")}`
		;(options.onError || useToast().showError)(message)
		return null
	}
}

/**
 * The paper's size in millimetres, for QZ Tray.
 * @param {string} paper
 * @returns {{width: number, height: number|null}}
 */
export function paperSizeMm(paper) {
	const { widthMm, heightMm, roll } = PAPERS[normalizePaper(paper)]
	return { width: widthMm, height: roll ? null : heightMm }
}

/**
 * The document with its copies one after another, each on its own page, for the
 * browser's print dialog, which has no copies of its own to set.
 * @param {string} html
 * @param {number} copies
 * @returns {string}
 */
export function withCopies(html, copies) {
	if (!(copies > 1)) return html
	const match = html.match(/<body([^>]*)>([\s\S]*)<\/body>/i)
	if (!match) return html
	const pageBreak = '<div style="break-after:page;page-break-after:always"></div>'
	const body = Array.from({ length: copies }, () => match[2]).join(pageBreak)
	// A function, so a "$" in the receipt is not read as a replacement pattern
	return html.replace(match[0], () => `<body${match[1]}>${body}</body>`)
}
