/**
 * Print templates rendered on the device. A manager writes them in Desk with HTML, CSS
 * and Jinja; Nunjucks reads the same syntax, so a receipt prints with no server.
 *
 * Nunjucks can run JavaScript from a template, which is why only a manager may write one.
 *
 * @module platform/printing/template
 */

import nunjucks from "nunjucks"
import { frappeShim, withDocMethods } from "./frappeCompat"
import { createHelpers } from "./templateHelpers"

/** Paper by the names the device uses; the server maps Print Format's Paper Size to them */
export const PAPERS = {
	"58mm": { widthMm: 58, roll: true },
	"80mm": { widthMm: 80, roll: true },
	A4: { widthMm: 210, heightMm: 297, roll: false },
	A5: { widthMm: 148, heightMm: 210, roll: false },
}

export const DEFAULT_PAPER = "80mm"

/**
 * @param {string} paper - "58mm", "80mm", "A4" or "A5"; "58" and "a4" are understood too
 * @returns {string} One of the PAPERS keys
 */
export function normalizePaper(paper) {
	const value = String(paper || "").trim()
	if (PAPERS[value]) return value
	if (/^58/.test(value)) return "58mm"
	if (/^80/.test(value)) return "80mm"
	if (/^a4$/i.test(value)) return "A4"
	if (/^a5$/i.test(value)) return "A5"
	return DEFAULT_PAPER
}

/**
 * The page rule for a paper. A roll has no fixed height, so the page is as long as the receipt.
 * @param {string} paper
 * @returns {string} CSS
 */
export function paperCss(paper) {
	const name = normalizePaper(paper)
	const { widthMm, roll } = PAPERS[name]
	const base =
		"*{box-sizing:border-box}" +
		"body{margin:0;color:#000;background:#fff;" +
		'font-family:"Tahoma","Arial","Noto Naskh Arabic","Noto Sans Arabic","DejaVu Sans",sans-serif}' +
		"img{max-width:100%}"
	if (roll) {
		return `@page { size: ${widthMm}mm auto; margin: 0 }\n${base}\nhtml,body{width:${widthMm}mm}`
	}
	return `@page { size: ${name}; margin: 10mm }\n${base}`
}

/** A template failed to render. Its message says where, so the manager can fix it. */
export class TemplateError extends Error {
	constructor(message, cause) {
		super(message)
		this.name = "TemplateError"
		this.cause = cause
	}
}

let environment = null

function getEnvironment() {
	if (!environment) {
		// No loaders: a template cannot read files or fetch other templates
		environment = new nunjucks.Environment([], { autoescape: true, throwOnUndefined: false })
		// Python's literals, which Frappe templates use. installJinjaCompat is not used: it
		// makes doc.items return dict.items() instead of the invoice's rows.
		environment.addGlobal("True", true)
		environment.addGlobal("False", false)
		environment.addGlobal("None", null)
	}
	return environment
}

const escapeAttribute = (value) =>
	String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * Render a template into a whole HTML document.
 *
 * @param {{html: string, css?: string, paper?: string, template_name?: string, name?: string}} template
 * @param {Object} context - {doc, company, pos_profile, cashier, customer, print}
 * @param {{translate?: Function, dateFormat?: string, precision?: number}} [options]
 * @returns {string} The document, with the template's CSS and the paper rule
 * @throws {TemplateError} When the template does not compile or fails while rendering
 */
export function renderTemplate(template, context = {}, options = {}) {
	if (!template || typeof template.html !== "string") {
		throw new TemplateError(__("The print template has no HTML"))
	}
	const paper = normalizePaper(template.paper || context.print?.paper)
	const print = { paper, rtl: false, lang: "en", copy: 1, copies: 1, reprint: false, ...(context.print || {}) }
	print.paper = paper
	const lang = print.lang || "en"
	const currency = context.doc?.currency || context.company?.currency || context.pos_profile?.currency
	const helpers = createHelpers({ lang, currency, ...options })

	// What Frappe's renderer gets from pos_print_context(doc), so one template prints alike there
	const parts = {
		company: context.company ?? null,
		pos_profile: context.pos_profile ?? null,
		cashier: context.cashier ?? null,
		customer: context.customer ?? null,
	}
	const posContext = { ...parts, print, ...helpers }
	const names = {
		// Frappe's own print context, empty: the device prints no letter head
		letter_head: "",
		footer: "",
		no_letterhead: 1,
		print_settings: {},
		...helpers,
		...context,
		doc: withDocMethods(context.doc, helpers),
		frappe: frappeShim(helpers, currency),
		pos_print_context: () => posContext,
		print,
	}

	let body
	try {
		body = getEnvironment().renderString(template.html, names)
	} catch (error) {
		const where = template.template_name || template.name || ""
		const detail = String(error?.message || error).replace(/^\(unknown path\)\s*/, "")
		throw new TemplateError(
			where ? __("Print template {0} has an error: {1}", [where, detail]) : detail,
			error,
		)
	}

	// The template's CSS is the manager's own; it only must not close the style element early
	const css = String(template.css || "").replace(/<\/style/gi, "<\\/style")
	const dir = print.rtl ? "rtl" : "ltr"
	const head = [
		'<meta charset="utf-8">',
		`<title>${escapeAttribute(context.doc?.name || "")}</title>`,
		`<style>${paperCss(paper)}\n${css}</style>`,
	].join("")
	return [
		"<!DOCTYPE html>",
		`<html lang="${escapeAttribute(lang)}" dir="${dir}">`,
		`<head>${head}</head>`,
		`<body class="pos-print paper-${paper.toLowerCase()}">${body}</body>`,
		"</html>",
	].join("")
}
