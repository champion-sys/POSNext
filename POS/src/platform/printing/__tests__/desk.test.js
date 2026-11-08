import { beforeEach, describe, expect, it, vi } from "vitest"
import { bundle } from "./fixtures"

const template = {
	name: "PT-T",
	template_name: "Words",
	paper: "80mm",
	html: '<p class="t">{{ _("Total") }}</p><p class="a">{{ _("Amount {0}", [doc.name]) }}</p><p class="p">{{ print.paper }} {{ print.lang }} {{ print.reprint }}</p>',
	css: "",
	copies: 1,
}

const context = {
	doc: { name: "ACC-SINV-1", items: [], grand_total: 5 },
	company: bundle.company,
	pos_profile: bundle.pos_profile,
	cashier: { user: "a@x", full_name: "A" },
	customer: { customer_name: "C" },
	print: { paper: "80mm", rtl: true, lang: "ar", copy: 1, reprint: false },
}

const read = (html, selector) => new DOMParser().parseFromString(html, "text/html").querySelector(selector).textContent

async function loadDesk() {
	vi.resetModules()
	window.posPrintTemplate = undefined
	await import("../desk")
	return window.posPrintTemplate
}

beforeEach(() => {
	// Desk's own wording, which the preview must not use
	globalThis.__ = (text) => ({ Total: "الاجمالي غير شامل الضريبة", Amount: "كمية" })[text] || text
	globalThis.frappe = undefined
})

describe("the Desk preview's renderer", () => {
	it("uses the translate function it is given, at once", async () => {
		const desk = await loadDesk()
		const translate = (text) => ({ Total: "الإجمالي", "Amount {0}": "المبلغ {0}" })[text] || text

		const html = desk.render(template, context, { translate })

		expect(typeof html).toBe("string")
		expect(read(html, ".t")).toBe("الإجمالي")
		expect(read(html, ".a")).toBe("المبلغ ACC-SINV-1")
	})

	it("otherwise uses the POS's own dictionary from get_app_translations", async () => {
		globalThis.frappe = {
			xcall: vi.fn(async () => ({ Total: "الإجمالي", "Amount {0}": "المبلغ {0}", __lang__: "ar" })),
		}
		const desk = await loadDesk()

		const html = await desk.render(template, context)

		expect(globalThis.frappe.xcall).toHaveBeenCalledWith("pos_next.api.localization.get_app_translations")
		expect(read(html, ".t")).toBe("الإجمالي")
		expect(read(html, ".a")).toBe("المبلغ ACC-SINV-1")
		// Asked once for every preview after
		await desk.render(template, context)
		expect(globalThis.frappe.xcall).toHaveBeenCalledOnce()
	})

	it("prints the words as written when the dictionary cannot be had", async () => {
		globalThis.frappe = { xcall: vi.fn(async () => Promise.reject(new Error("403"))) }
		const desk = await loadDesk()

		const html = await desk.render(template, context)

		expect(read(html, ".t")).toBe("Total")
		expect(read(html, ".a")).toBe("Amount ACC-SINV-1")
	})

	it("keeps the print names the server templates use, and lets options.print override them", async () => {
		const desk = await loadDesk()

		const html = desk.render(template, context, { translate: (text) => text, print: { reprint: true } })

		expect(read(html, ".p")).toBe("80mm ar true")
		expect(new DOMParser().parseFromString(html, "text/html").documentElement.dir).toBe("rtl")
	})

	it("throws a broken template's error for the form to show", async () => {
		const desk = await loadDesk()

		expect(() => desk.render({ ...template, html: "{% if %}" }, context, { translate: (text) => text })).toThrow(
			desk.TemplateError,
		)
	})
})
