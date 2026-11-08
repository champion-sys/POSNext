/**
 * The renderer for the POS Print Template preview in Desk, built on its own as
 * /assets/pos_next/js/pos_print_template.js. It is the device's renderer, so the
 * preview is what the device prints.
 *
 *   frappe.require("/assets/pos_next/js/pos_print_template.js", () => {
 *       const html = window.posPrintTemplate.render(template, context)
 *   })
 *
 * @module platform/printing/desk
 */

import { buildPrintContext } from "./context"
import { normalizePaper, paperCss, renderTemplate, TemplateError } from "./template"
import { createHelpers } from "./templateHelpers"

/**
 * @param {{html: string, css?: string, paper?: string, copies?: number}} template
 * @param {Object} context - What get_print_context returns: {doc, company, pos_profile, cashier, customer}
 * @param {Object} [print] - Overrides for the print variable, such as {reprint: true}
 * @returns {string} The whole HTML document
 * @throws {TemplateError}
 */
function render(template, context = {}, print = {}) {
	const full = buildPrintContext({
		doc: context.doc || {},
		server: context,
		template,
		print: { ...(context.print || {}), ...print },
	})
	return renderTemplate(template, full)
}

window.posPrintTemplate = {
	render,
	renderTemplate,
	buildPrintContext,
	createHelpers,
	normalizePaper,
	paperCss,
	TemplateError,
}
