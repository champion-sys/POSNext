/**
 * The renderer for the POS Print Template preview in Desk, built on its own as
 * /assets/pos_next/js/pos_print_template.js. It is the device's renderer, so the
 * preview is what the device prints.
 *
 *   frappe.require("/assets/pos_next/js/pos_print_template.js", async () => {
 *       const html = await window.posPrintTemplate.render(template, context)
 *   })
 *
 * Desk's own __ lacks the POS wording (pos_screens), so "Total" would preview as Desk
 * words it. Pass options.translate, or let render use the dictionary the POS itself
 * loads, from pos_next.api.localization.get_app_translations.
 *
 * @module platform/printing/desk
 */

import { buildPrintContext } from "./context"
import { normalizePaper, paperCss, renderTemplate, TemplateError } from "./template"
import { createHelpers } from "./templateHelpers"

const TRANSLATIONS_METHOD = "pos_next.api.localization.get_app_translations"
const TRANSLATIONS_TIMEOUT_MS = 5000

const fill = (text, args) =>
	args ? String(text).replace(/\{(\d+)\}/g, (match, index) => (args[index] ?? match)) : String(text)

/** Untranslated, for when the dictionary cannot be had */
const identity = (text, args) => fill(text == null ? "" : text, args)

/**
 * @param {Object} messages - {source: translated}
 * @returns {(text: string, args?: Array) => string}
 */
export function translatorFrom(messages) {
	return (text, args) => {
		const source = text == null ? "" : String(text)
		const translated = messages && Object.hasOwn(messages, source) && messages[source] ? messages[source] : source
		return fill(translated, args)
	}
}

async function fetchMessages() {
	const frappe = globalThis.frappe
	if (typeof frappe?.xcall === "function") return frappe.xcall(TRANSLATIONS_METHOD)
	const response = await fetch(`/api/method/${TRANSLATIONS_METHOD}`, {
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	})
	if (!response.ok) throw new Error(`${response.status}`)
	return (await response.json()).message
}

let loading = null

/**
 * The POS's own dictionary, asked for once. A failure, or no answer in time, gives
 * the untranslated wording rather than no preview.
 * @returns {Promise<(text: string, args?: Array) => string>}
 */
export function loadTranslator() {
	if (!loading) {
		const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TRANSLATIONS_TIMEOUT_MS))
		loading = Promise.race([fetchMessages().catch(() => null), timeout]).then((messages) => {
			if (!messages || typeof messages !== "object") {
				loading = null // asked again next time
				return identity
			}
			return translatorFrom(messages)
		})
	}
	return loading
}

/**
 * @param {Object} template
 * @param {Object} context - What get_print_context returns, with print if the caller set it
 * @param {Function} translate
 * @param {Object} [print]
 */
function renderWith(template, context, translate, print) {
	const full = buildPrintContext({
		doc: context.doc || {},
		server: context,
		template,
		print: { ...(context.print || {}), ...(print || {}) },
	})
	return renderTemplate(template, full, { translate })
}

/**
 * @param {{html: string, css?: string, paper?: string, copies?: number}} template
 * @param {Object} context - {doc, company, pos_profile, cashier, customer, print?}
 * @param {{translate?: (text: string, args?: Array) => string, print?: Object}} [options]
 * @returns {string|Promise<string>} The whole HTML document; a promise when it waits for
 *   the POS dictionary, so callers should await it
 * @throws {TemplateError}
 */
function render(template, context = {}, options = {}) {
	if (typeof options.translate === "function") {
		return renderWith(template, context, options.translate, options.print)
	}
	return loadTranslator().then((translate) => renderWith(template, context, translate, options.print))
}

window.posPrintTemplate = {
	render,
	loadTranslator,
	renderTemplate,
	buildPrintContext,
	createHelpers,
	normalizePaper,
	paperCss,
	TemplateError,
}
