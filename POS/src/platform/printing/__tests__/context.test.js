import { createPinia, setActivePinia } from "pinia"
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/utils/offline/offlineReceiptCache", () => ({}))
vi.mock("@/utils/offline/sync", () => ({}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))
vi.mock("@/utils/qzTray", () => ({ printHTML: vi.fn() }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))
vi.mock("@/utils/offline/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }))

import { formatInvoiceToReceiptLines } from "@/utils/escpos"
import { buildOfflinePrintDoc } from "@/utils/offline/offlinePrintDoc"
import { buildReceiptHTML } from "@/utils/printInvoice"
import { buildPrintContext, normalizePrintDoc } from "../context"
import { bundle, queuedSale, saleTotals } from "./fixtures"

beforeAll(() => {
	globalThis.__ = (text) => text
	setActivePinia(createPinia())
})

const sale = {
	invoiceData: queuedSale,
	paymentData: { paid_amount: 40.25, change_amount: 0 },
	totals: saleTotals,
	doctype: "Sales Invoice",
	posProfile: "Main POS",
	company: "Sanad Trading",
	currency: "SAR",
	customerLabel: "Sara",
	customer: { name: "CUST-0001", customer_name: "Sara", tax_id: "310000000000003", mobile_no: "0500000000" },
	cashier: { user: "lina@example.com", full_name: "Lina" },
}

/** The receipt exactly as POSSale built it before print templates */
function receiptBeforeTemplates() {
	const invoiceData = queuedSale
	const paidAmount = 40.25
	const amountDue = saleTotals.roundedTotal
	return {
		name: invoiceData.offline_id,
		doctype: "Sales Invoice",
		is_offline: true,
		pos_profile: "Main POS",
		owner: "Lina",
		pos_order_type: invoiceData.pos_order_type || undefined,
		posting_date: invoiceData.posting_date,
		company: "Sanad Trading",
		customer_name: "Sara",
		items: invoiceData.items.map((item) => ({ ...item, quantity: item.qty ?? item.quantity })),
		grand_total: saleTotals.grandTotal,
		rounded_total: amountDue,
		rounding_adjustment: saleTotals.roundingAdjustment,
		total_taxes_and_charges: saleTotals.totalTax,
		payments: invoiceData.payments,
		paid_amount: paidAmount,
		change_amount: 0,
		outstanding_amount: Math.max(0, amountDue - paidAmount),
		status: "Paid",
		remarks: invoiceData.remarks,
		docstatus: 0,
	}
}

describe("the receipt kept for an offline sale", () => {
	it("keeps every field the receipt cache and the built-in layouts read", () => {
		const before = receiptBeforeTemplates()
		const now = buildOfflinePrintDoc(sale)

		for (const [field, value] of Object.entries(before)) {
			expect(now[field], field).toEqual(value)
		}
	})

	it("adds the tax lines, the customer and the cashier", () => {
		const now = buildOfflinePrintDoc(sale)

		expect(now.taxes).toEqual([
			{ idx: 1, ...saleTotals.taxLines[0] },
		])
		expect(now).toMatchObject({
			offline_id: "pos_offline_7f3a",
			customer: "CUST-0001",
			customer_tax_id: "310000000000003",
			customer_mobile: "0500000000",
			posting_time: "14:05:09",
			currency: "SAR",
			cashier: "lina@example.com",
			cashier_name: "Lina",
			net_total: 35,
			total: 35,
			total_qty: 3,
		})
	})

	it("prints the built-in receipts exactly as before", () => {
		const before = receiptBeforeTemplates()
		const now = buildOfflinePrintDoc(sale)

		expect(buildReceiptHTML(now)).toBe(buildReceiptHTML(before))
		expect(formatInvoiceToReceiptLines(now)).toEqual(formatInvoiceToReceiptLines(before))
	})
})

describe("the context of an offline sale", () => {
	const template = bundle.templates[0]

	it("has the plan's shape, from the sale and the kept bundle", () => {
		const context = buildPrintContext({
			doc: buildOfflinePrintDoc(sale),
			bundle,
			template,
			print: { lang: "ar", rtl: true },
		})

		expect(Object.keys(context).sort()).toEqual(["cashier", "company", "customer", "doc", "pos_profile", "print"])
		expect(context.company.company_name).toBe("شركة سند التجارية")
		expect(context.company.logo.startsWith("data:image/png;base64,")).toBe(true)
		expect(context.pos_profile).toMatchObject({ name: "Main POS", warehouse: "Stores - S" })
		expect(context.cashier).toEqual({ user: "lina@example.com", full_name: "Lina" })
		expect(context.customer).toMatchObject({ name: "CUST-0001", customer_name: "Sara", tax_id: "310000000000003", mobile_no: "0500000000" })
		expect(context.print).toEqual({ paper: "80mm", lang: "ar", rtl: true, copy: 1, copies: 2, reprint: false })
	})

	it("gives the invoice the fields Frappe templates use", () => {
		const { doc } = buildPrintContext({ doc: buildOfflinePrintDoc(sale), bundle, template })

		expect(doc).toMatchObject({
			name: "pos_offline_7f3a",
			offline_id: "pos_offline_7f3a",
			is_offline: true,
			is_return: false,
			currency: "SAR",
			grand_total: 40.25,
			net_total: 35,
			total_taxes_and_charges: 5.25,
			discount_amount: 0,
			paid_amount: 40.25,
		})
		expect(doc.taxes[0]).toMatchObject({ description: "ضريبة القيمة المضافة VAT", rate: 15, tax_amount: 5.25 })
		expect(doc.items[1]).toMatchObject({ idx: 2, item_name: "Cheese Cake", qty: 1, rate: 15, amount: 15 })
		expect(doc.payments).toEqual([{ mode_of_payment: "Cash", amount: 40.25 }])
	})

	it("lets the server's context override what the device kept", () => {
		const context = buildPrintContext({
			doc: { name: "ACC-SINV-0001", items: [], grand_total: 10 },
			bundle,
			template,
			server: { company: { tax_id: "399999999999993" }, cashier: { user: "a@x", full_name: "Amal" } },
		})

		expect(context.company.tax_id).toBe("399999999999993")
		expect(context.company.company_name).toBe("شركة سند التجارية")
		expect(context.cashier.full_name).toBe("Amal")
		expect(context.doc.offline_id).toBeNull()
	})

	it("gives a queued row's discount per unit, as ERPNext and the server templates read it", () => {
		const queued = normalizePrintDoc({
			is_offline: true,
			items: [{ item_code: "A", qty: 4, rate: 9, price_list_rate: 10, discount_amount: 4 }],
		})
		const posted = normalizePrintDoc({
			items: [{ item_code: "A", qty: 4, rate: 9, price_list_rate: 10, discount_amount: 1 }],
		})

		expect(queued.items[0].discount_amount).toBe(1)
		expect(posted.items[0].discount_amount).toBe(1)
		expect(queued.items[0].amount).toBe(36)
	})

	it("works out totals a queued row does not carry", () => {
		const doc = normalizePrintDoc({
			name: "pos_offline_1",
			is_offline: true,
			items: [{ item_code: "A", quantity: 2, rate: 5 }],
			payments: [{ mode_of_payment: "Cash", amount: "10" }],
			grand_total: 10,
		})

		expect(doc.items[0]).toMatchObject({ qty: 2, amount: 10, item_name: "A" })
		expect(doc.net_total).toBe(10)
		expect(doc.paid_amount).toBe(10)
		expect(doc.taxes).toEqual([])
	})
})
