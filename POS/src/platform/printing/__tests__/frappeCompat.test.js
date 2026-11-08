import { beforeAll, describe, expect, it } from "vitest"
import { buildPrintContext } from "../context"
import { renderTemplate } from "../template"
import { bundle } from "./fixtures"

const doc = {
	name: "ACC-SINV-0007",
	currency: "SAR",
	posting_date: "2026-11-08",
	grand_total: 115,
	items: [{ item_code: "TEA", item_name: "Tea", qty: 2, rate: 50, amount: 100 }],
	taxes: [{ description: "VAT", tax_amount: 15 }],
}

const render = (html) => {
	const context = buildPrintContext({ doc, bundle, template: { paper: "80mm" }, print: { lang: "en", rtl: false } })
	const page = renderTemplate({ name: "T", paper: "80mm", html }, context)
	return new DOMParser().parseFromString(page, "text/html").body.textContent.trim()
}

beforeAll(() => {
	globalThis.__ = (text) => text
})

describe("a Frappe Print Format on the device", () => {
	it("gives pos_print_context the names Frappe's renderer gives", () => {
		const text = render(
			"{% set pos = pos_print_context(doc) %}{{ pos.company.company_name }}|{{ pos.cashier.full_name or pos.cashier.user }}|{{ pos.format_currency(doc.grand_total) }}|{{ pos.print.paper }}",
		)
		expect(text).toBe(`${bundle.company.company_name}|${render("{{ cashier.full_name }}")}|SAR 115.00|80mm`)
	})

	it("answers doc.get_formatted and doc.get on the invoice and its rows", () => {
		expect(render("{{ doc.get_formatted('grand_total') }}")).toBe("SAR 115.00")
		expect(render("{% for row in doc.items %}{{ row.get_formatted('qty') }} x {{ row.get_formatted('rate') }}{% endfor %}")).toBe("2 x SAR 50.00")
		expect(render("{{ doc.get('name') }}")).toBe("ACC-SINV-0007")
	})

	it("has the formatting parts of frappe and frappe.utils", () => {
		expect(render("{{ frappe.utils.fmt_money(doc.grand_total, 2, 'SAR') }}")).toBe("SAR 115.00")
		expect(render("{{ frappe.format_value(doc.grand_total, {'fieldtype': 'Currency'}) }}")).toBe("SAR 115.00")
		expect(render("{{ frappe.utils.flt('2.345', 2) }}")).toBe("2.35")
		expect(render("{{ _('Total') }}")).toBe("Total")
	})

	it("leaves the invoice it was given as it was", () => {
		render("{{ doc.get_formatted('grand_total') }}")
		expect(Object.hasOwn(doc, "get_formatted")).toBe(false)
		expect(Object.hasOwn(doc.items[0], "get")).toBe(false)
	})
})
