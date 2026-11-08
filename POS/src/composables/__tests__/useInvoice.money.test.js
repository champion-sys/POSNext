import { describe, expect, it, vi } from "vitest"

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({
		...options,
		submit: async () => ({ customer: "DEFAULT-CUSTOMER" }),
		reload: async () => ({}),
	}),
	call: async () => ({}),
}))
vi.mock("@/utils/offline", () => ({
	isOffline: () => true,
	getCachedItem: vi.fn(),
	getSetting: vi.fn(),
	setSetting: vi.fn(),
}))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => ({ returnSerials: vi.fn() }),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({}) }))
vi.mock("@/stores/bluetoothPrinter", () => ({ useBluetoothPrinterStore: () => ({}) }))
vi.mock("@/utils/escpos", () => ({ prefetchPrintFormat: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))

import { useInvoice } from "@/composables/useInvoice"
import { buildRateUpdate } from "@/utils/cartItemEdit"

const VAT = [{ charge_type: "On Net Total", rate: 15, account_head: "VAT" }]

function product(code, price) {
	return { item_code: code, item_name: code, rate: price, price_list_rate: price, uom: "Nos", stock_uom: "Nos" }
}

/** What the invoice will be: the sum of what each row sends up */
function postedNet(invoice) {
	return invoice
		.formatItemsForSubmission(invoice.invoiceItems.value)
		.reduce((sum, row) => sum + row.rate * row.qty, 0)
}

describe("money: the cart total against the rows it sends", () => {
	it("scanning an item again after its rate was edited keeps the total equal to the rows", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = VAT
		invoice.taxInclusive.value = false

		invoice.addItem(product("ITEM-A", 100), 1)
		const line = invoice.invoiceItems.value[0]
		// The cashier edits the rate to 90, as the edit dialog does
		Object.assign(line, buildRateUpdate(90, 100))
		invoice.recalculateItem(line)
		invoice.rebuildIncrementalCache()
		expect(invoice.subtotal.value).toBe(90)

		// The same barcode is scanned again
		invoice.addItem(product("ITEM-A", 100), 1)

		// The rows go up as 2 x 90 = 180 net, 207 with tax
		expect(postedNet(invoice)).toBe(180)
		expect(invoice.subtotal.value).toBe(180)
		expect(invoice.grandTotal.value).toBe(207)
	})
})

describe("money: tax rounding against ERPNext", () => {
	it("the screen total equals the total ERPNext computes for the same rows", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = VAT
		invoice.taxInclusive.value = false

		// Five lines whose 15% tax each ends in a half cent less a little
		for (const [code, price] of [
			["ITEM-A", 99.83],
			["ITEM-B", 39.83],
			["ITEM-BL", 9.83],
			["ITEM-BACKLOG", 9.83],
			["ITEM-Z12", 9.83],
		]) {
			invoice.addItem(product(code, price), 1)
		}

		// ERPNext (round_row_wise_tax off, the default) adds the unrounded tax of every
		// row and rounds the sum once
		const rows = invoice.formatItemsForSubmission(invoice.invoiceItems.value)
		const net = rows.reduce((sum, row) => sum + row.rate * row.qty, 0)
		const erpnextTax = Math.round(rows.reduce((sum, row) => sum + row.rate * row.qty * 0.15, 0) * 100) / 100
		const erpnextGrand = Math.round((net + erpnextTax) * 100) / 100

		console.log("MONEY screen", invoice.grandTotal.value, "tax", invoice.totalTax.value, "erpnext", erpnextGrand, "tax", erpnextTax)
		expect(invoice.grandTotal.value).toBe(erpnextGrand)
	})
})

describe("money: coupons", () => {
	/** The object CouponDialog.applyCoupon emits */
	function couponDiscount({ percent, maxAmount, base }) {
		const amount = Math.min((base * percent) / 100, maxAmount || Number.POSITIVE_INFINITY, base)
		return { name: "SAVE50", code: "SAVE50", percentage: percent, amount, type: "Percentage", base_amount: base }
	}

	it("keeps the coupon's maximum discount amount", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 200), 1)

		// 50% off, at most 20: the dialog shows 20
		const discount = couponDiscount({ percent: 50, maxAmount: 20, base: 200 })
		expect(discount.amount).toBe(20)
		invoice.applyDiscount(discount)

		expect(invoice.additionalDiscount.value).toBe(20)
		expect(invoice.grandTotal.value).toBe(180)
	})

	it("a percentage coupon is not worth more than its percentage of what is left in the cart", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 900), 1)
		invoice.addItem(product("ITEM-B", 100), 1)
		invoice.applyDiscount(couponDiscount({ percent: 10, base: 1000 }))
		expect(invoice.additionalDiscount.value).toBe(100)

		// The customer puts the expensive item back
		invoice.removeItem("ITEM-A")

		expect(invoice.grandTotal.value).toBe(90)
	})
})
