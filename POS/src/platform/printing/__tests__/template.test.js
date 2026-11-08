import { beforeAll, describe, expect, it } from "vitest"
import { buildOfflinePrintDoc } from "@/utils/offline/offlinePrintDoc"
import { buildPrintContext } from "../context"
import { paperCss, renderTemplate, TemplateError } from "../template"
import { createHelpers } from "../templateHelpers"
import { bundle, LOGO, queuedSale, saleTotals } from "./fixtures"

const [receipt80, kitchen58, invoiceA4] = bundle.templates

function offlineContext(template, print = {}) {
	const doc = buildOfflinePrintDoc({
		invoiceData: queuedSale,
		totals: saleTotals,
		doctype: "Sales Invoice",
		posProfile: "Main POS",
		company: "Sanad Trading",
		currency: "SAR",
		customerLabel: "<b>Sara</b> & Co",
		customer: { name: "CUST-0001", tax_id: "310000000000003" },
		cashier: { user: "lina@example.com", full_name: "Lina" },
	})
	return buildPrintContext({ doc, bundle, template, print: { lang: "ar", rtl: true, ...print } })
}

function parse(html) {
	return new DOMParser().parseFromString(html, "text/html")
}

beforeAll(() => {
	globalThis.__ = (text, args) =>
		args ? String(text).replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match) : text
})

describe("an 80mm template", () => {
	it("renders a whole right-to-left document on 80mm paper", () => {
		const html = renderTemplate(receipt80, offlineContext(receipt80))
		const doc = parse(html)

		expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
		expect(doc.documentElement.getAttribute("dir")).toBe("rtl")
		expect(doc.documentElement.getAttribute("lang")).toBe("ar")
		const style = doc.querySelector("style").textContent
		expect(style).toContain("@page { size: 80mm auto; margin: 0 }")
		expect(style).toContain(".receipt { padding: 2mm 3mm")
		expect(doc.body.classList.contains("paper-80mm")).toBe(true)
	})

	it("prints the company, the rows, the tax lines and the totals in Arabic", () => {
		const doc = parse(renderTemplate(receipt80, offlineContext(receipt80)))
		const text = doc.body.textContent

		expect(text).toContain("شركة سند التجارية")
		expect(text).toContain("300000000000003")
		expect(text).toContain("شاي أخضر")
		expect(doc.querySelector("tr.tax").textContent).toContain("ضريبة القيمة المضافة VAT (15%)")
		expect(doc.querySelector("tr.tax").textContent).toContain("5.25 ر.س")
		expect(doc.querySelector("tr.grand").textContent).toContain("40.25 ر.س")
		expect(text).toContain("فقط أربعون ريالاً سعودياً وخمسة وعشرون هللة لا غير")
		// The unused card row is not printed
		expect(text).toContain("Cash: 40.25 ر.س")
		expect(text).not.toContain("Card:")
		expect(text).toContain("Lina")
	})

	it("embeds the logo and a QR code as data URIs", () => {
		const images = parse(renderTemplate(receipt80, offlineContext(receipt80))).querySelectorAll("img")

		expect(images[0].getAttribute("src")).toBe(LOGO)
		const qr = images[1].getAttribute("src")
		expect(qr.startsWith("data:image/svg+xml;base64,")).toBe(true)
		const svg = atob(qr.split(",")[1])
		expect(svg).toContain("<svg")
		expect(svg).toContain('shape-rendering="crispEdges"')
	})

	it("escapes what a cashier typed", () => {
		const html = renderTemplate(receipt80, offlineContext(receipt80))

		expect(html).toContain("&lt;b&gt;Sara&lt;/b&gt; &amp; Co")
		expect(html).not.toContain("<b>Sara</b>")
	})
})

describe("a 58mm template", () => {
	it("sets 58mm paper and lays the body out at that width", () => {
		const html = renderTemplate(kitchen58, offlineContext(kitchen58))
		const style = parse(html).querySelector("style").textContent

		expect(style).toContain("@page { size: 58mm auto; margin: 0 }")
		expect(style).toContain("html,body{width:58mm}")
		expect(parse(html).querySelector(".big").textContent).toBe("Takeaway #pos_offline_7f3a")
	})
})

describe("an A4 template", () => {
	it("uses an A4 page with margins and no roll width", () => {
		const context = offlineContext(invoiceA4, { lang: "en", rtl: false })
		const html = renderTemplate(invoiceA4, context)
		const doc = parse(html)
		const style = doc.querySelector("style").textContent

		expect(style).toContain("@page { size: A4; margin: 10mm }")
		expect(style).not.toContain("width:80mm")
		expect(doc.documentElement.getAttribute("dir")).toBe("ltr")
		expect(doc.querySelectorAll("table.items tr")).toHaveLength(3)
		expect(doc.querySelector("table.items tr:nth-child(2)").textContent).toContain("SAR 20.00")
		expect(doc.body.textContent).toContain("310000000000003")
		expect(doc.body.textContent).toContain("SAR Forty and Twenty-Five Halala only.")
	})
})

describe("a broken template", () => {
	it("throws a TemplateError naming the template", () => {
		const broken = { ...receipt80, html: "{% for item in doc.items %}{{ item.item_name }}" }

		expect(() => renderTemplate(broken, offlineContext(broken))).toThrow(TemplateError)
		expect(() => renderTemplate(broken, offlineContext(broken))).toThrow(/Receipt 80mm/)
	})

	it("throws when a helper fails at render time", () => {
		const broken = { ...receipt80, html: "{{ doc.missing.deeper() }}" }

		expect(() => renderTemplate(broken, offlineContext(broken))).toThrow(TemplateError)
	})

	it("cannot close its style element early", () => {
		const sneaky = { ...kitchen58, css: "</style><script>alert(1)</script>" }
		const doc = parse(renderTemplate(sneaky, offlineContext(sneaky)))

		expect(doc.querySelector("script")).toBeNull()
	})
})

describe("the paper rule", () => {
	it("knows A5 and falls back to 80mm", () => {
		expect(paperCss("A5")).toContain("@page { size: A5; margin: 10mm }")
		expect(paperCss("")).toContain("size: 80mm auto")
		expect(paperCss("58")).toContain("size: 58mm auto")
	})
})

describe("the helpers", () => {
	const ar = createHelpers({ lang: "ar" })
	const en = createHelpers({ lang: "en" })

	it("write money in Arabic with the right noun forms", () => {
		expect(ar.money_in_words(1, "SAR")).toBe("فقط ريال سعودي لا غير")
		expect(ar.money_in_words(2, "SAR")).toBe("فقط ريالان سعوديان لا غير")
		expect(ar.money_in_words(5, "SAR")).toBe("فقط خمسة ريالات سعودية لا غير")
		expect(ar.money_in_words(1250.5, "SAR")).toBe("فقط ألف ومائتان وخمسون ريالاً سعودياً وخمسون هللة لا غير")
		// After a round hundred, thousand or million the noun is singular
		expect(ar.money_in_words(3000000, "SAR")).toBe("فقط ثلاثة ملايين ريال سعودي لا غير")
		expect(ar.money_in_words(1.5, "KWD")).toBe("فقط دينار كويتي وخمسمائة فلس لا غير")
		expect(ar.money_in_words(15000, "SAR")).toBe("فقط خمسة عشر ألف ريال سعودي لا غير")
		expect(ar.money_in_words(15250, "SAR")).toBe("فقط خمسة عشر ألفاً ومائتان وخمسون ريالاً سعودياً لا غير")
		expect(ar.money_in_words(0.25, "SAR")).toBe("فقط صفر ريال سعودي وخمسة وعشرون هللة لا غير")
	})

	it("write money in English as Frappe does", () => {
		expect(en.money_in_words(125.5, "SAR")).toBe("SAR One Hundred Twenty-Five and Fifty Halala only.")
		expect(en.money_in_words(1000000, "USD")).toBe("USD One Million only.")
	})

	it("format currency by language, with three decimals where the currency has them", () => {
		expect(ar.format_currency(1234.5, "SAR")).toBe("1,234.50 ر.س")
		expect(en.format_currency(1234.5, "SAR")).toBe("SAR 1,234.50")
		expect(en.format_currency(-3, "USD")).toBe("-$3.00")
		expect(en.format_currency(2, "KWD")).toBe("KWD 2.000")
	})

	it("read a Frappe date as local time", () => {
		expect(en.format_date("2026-11-08")).toBe("08-11-2026")
		expect(en.format_date("2026-11-08", "yyyy/mm/dd")).toBe("2026/11/08")
		expect(en.format_datetime("2026-11-08 09:05:00")).toBe("08-11-2026 09:05")
		expect(en.format_number(1234.5678, 2)).toBe("1,234.57")
	})

	it("draw a barcode as an SVG data URI", () => {
		const uri = en.barcode("ABC-123")
		expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true)
		expect(atob(uri.split(",")[1])).toContain("<rect")
	})

	it("translate through the app's __", () => {
		const helpers = createHelpers({ translate: (text) => (text === "Total" ? "الإجمالي" : text) })
		expect(helpers._("Total")).toBe("الإجمالي")
	})
})
