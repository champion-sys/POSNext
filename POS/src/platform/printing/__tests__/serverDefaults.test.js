import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { buildOfflinePrintDoc } from "@/utils/offline/offlinePrintDoc"
import { buildPrintContext } from "../context"
import { renderTemplate } from "../template"
import { bundle, queuedSale, saleTotals } from "./fixtures"

/** The templates the server installs, read from the app, so both halves stay in step */
const DEFAULTS = path.resolve(__dirname, "../../../../../pos_next/pos_next/doctype/pos_print_template/defaults")
const file = (name) => readFileSync(path.join(DEFAULTS, name), "utf8")

const defaults = [
	{ name: "POS Receipt 80mm", paper: "80mm", html: file("receipt.html"), css: file("receipt_80mm.css") },
	{ name: "POS Receipt 58mm", paper: "58mm", html: file("receipt.html"), css: file("receipt_58mm.css") },
	{ name: "A4 Tax Invoice", paper: "A4", html: file("a4_tax_invoice.html"), css: file("a4_tax_invoice.css") },
]

const offlineDoc = buildOfflinePrintDoc({
	invoiceData: {
		...queuedSale,
		items: [...queuedSale.items, { item_code: "MUG", item_name: "Mug", qty: 2, rate: 18, price_list_rate: 20, discount_amount: 4, discount_percentage: 10 }],
	},
	paymentData: { paid_amount: 50, change_amount: 9.75 },
	totals: saleTotals,
	doctype: "Sales Invoice",
	posProfile: "Main POS",
	currency: "SAR",
	customerLabel: "Sara",
	customer: { name: "CUST-0001", tax_id: "310000000000003", mobile_no: "0500000000" },
	cashier: { user: "lina@example.com", full_name: "Lina" },
})

const parse = (html) => new DOMParser().parseFromString(html, "text/html")

beforeAll(() => {
	globalThis.__ = (text) => text
})

describe.each(defaults)("the server's default template $name", (template) => {
	it("prints an offline sale on the device", () => {
		const context = buildPrintContext({ doc: offlineDoc, bundle, template, print: { lang: "ar", rtl: true, reprint: true } })
		const doc = parse(renderTemplate(template, context))
		const text = doc.body.textContent

		expect(text).toContain("شاي أخضر")
		expect(text).toContain("ضريبة القيمة المضافة VAT")
		expect(text).toContain("5.25")
		expect(text).toContain("pos_offline_7f3a")
		expect(text).toContain("Reprint")
		// The mug's discount, 2 x 2.00, as the server's own rows print it (not 2 x 4.00)
		expect(text).toMatch(/(^|[^0-9.])4\.00 ر\.س/)
		expect(text).not.toMatch(/(^|[^0-9.])8\.00 ر\.س/)
		const qr = Array.from(doc.images).find((image) => image.getAttribute("src")?.startsWith("data:image/svg+xml"))
		expect(qr).toBeTruthy()
	})

	it("prints a posted invoice from get_print_context", () => {
		const server = {
			doc: {
				name: "ACC-SINV-2026-00042",
				doctype: "Sales Invoice",
				currency: "SAR",
				posting_date: "2026-11-08",
				posting_time: "14:05:09",
				items: [{ item_code: "TEA", item_name: "Tea", qty: 1, rate: 10, amount: 10, uom: "Nos" }],
				taxes: [{ description: "VAT 15%", rate: 15, tax_amount: 1.5 }],
				payments: [{ mode_of_payment: "Cash", amount: 11.5 }],
				total: 10,
				net_total: 10,
				grand_total: 11.5,
				rounded_total: 11.5,
			},
			company: bundle.company,
			pos_profile: bundle.pos_profile,
			cashier: { user: "amal@example.com", full_name: "Amal" },
			customer: { name: "Walk-in", customer_name: "Walk-in" },
		}
		const context = buildPrintContext({ doc: server.doc, server, bundle, template, print: { lang: "en", rtl: false } })
		const text = parse(renderTemplate(template, context)).body.textContent

		expect(text).toContain("ACC-SINV-2026-00042")
		expect(text).toContain("VAT 15%")
		expect(text).toContain("SAR 11.50")
		expect(text).toContain("Amal")
	})
})
