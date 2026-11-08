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

const VAT = [{ charge_type: "On Net Total", rate: 15, account_head: "VAT" }]

function product(code, price) {
	return { item_code: code, item_name: code, rate: price, price_list_rate: price, uom: "Nos", stock_uom: "Nos" }
}

describe("money: a coupon follows the cart", () => {
	it("stops applying once the cart is below the coupon's minimum", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 100), 1)
		invoice.addItem(product("ITEM-B", 100), 1)
		invoice.applyDiscount({
			name: "MIN150",
			code: "MIN150",
			percentage: 10,
			amount: 20,
			apply_on: "Grand Total",
			coupon: { discount_type: "Percentage", discount_percentage: 10, min_amount: 150, apply_on: "Grand Total" },
		})
		expect(invoice.additionalDiscount.value).toBe(20)

		invoice.removeItem("ITEM-B")

		expect(invoice.additionalDiscount.value).toBe(0)
		expect(invoice.couponCode.value).toBe(null)
		expect(invoice.grandTotal.value).toBe(100)
		expect(invoice.couponDropped.value).toMatchObject({ code: "MIN150", minAmount: 150 })
	})

	it("a fixed-amount coupon never takes the sale below zero", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 40), 1)
		invoice.addItem(product("ITEM-B", 20), 1)
		invoice.applyDiscount({ name: "FIFTY", code: "FIFTY", percentage: 0, amount: 50, apply_on: "Grand Total" })
		expect(invoice.grandTotal.value).toBe(10)

		invoice.removeItem("ITEM-A")

		expect(invoice.additionalDiscount.value).toBe(20)
		expect(invoice.grandTotal.value).toBe(0)
	})

	it("a quantity change is priced against the coupon's maximum", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 10), 1)
		invoice.applyDiscount({
			name: "HALF",
			code: "HALF",
			percentage: 50,
			amount: 5,
			apply_on: "Grand Total",
			coupon: { discount_type: "Percentage", discount_percentage: 50, max_amount: 30, apply_on: "Grand Total" },
		})
		expect(invoice.additionalDiscount.value).toBe(5)

		invoice.updateItemQuantity("ITEM-A", 10)

		// 50% of 100 is 50, the coupon gives at most 30
		expect(invoice.additionalDiscount.value).toBe(30)
		expect(invoice.grandTotal.value).toBe(70)
	})

	it("a discount the cashier types replaces the coupon instead of being worked over", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = []
		invoice.addItem(product("ITEM-A", 100), 1)
		invoice.applyDiscount({ name: "TEN", code: "TEN", percentage: 10, amount: 10, apply_on: "Grand Total" })

		invoice.setAdditionalDiscount(5)
		invoice.addItem(product("ITEM-B", 100), 1)

		expect(invoice.couponCode.value).toBe(null)
		expect(invoice.additionalDiscount.value).toBe(5)
		expect(invoice.grandTotal.value).toBe(195)
	})
})

describe("money: ERPNext's rounded total", () => {
	function sale(price, qty) {
		const invoice = useInvoice()
		invoice.taxRules.value = VAT
		invoice.taxInclusive.value = false
		invoice.addItem(product("ITEM-BL", price), qty)
		return invoice
	}

	it("rounds to a whole number when the currency has no smallest fraction, as ERPNext does", () => {
		const one = sale(10, 1)
		one.setRounding(true, 0)
		expect(one.grandTotal.value).toBe(11.5)
		expect(one.roundedTotal.value).toBe(12)
		expect(one.roundingAdjustment.value).toBe(0.5)
		expect(one.remainingAmount.value).toBe(12)

		// Banker's rounding, the site's method: 34.5 goes to the even 34
		const three = sale(10, 3)
		three.setRounding(true, 0)
		expect(three.roundedTotal.value).toBe(34)
		expect(three.roundingAdjustment.value).toBe(-0.5)
	})

	it("rounds to the currency's smallest fraction", () => {
		const invoice = sale(10.11, 1)
		invoice.setRounding(true, 0.05)
		expect(invoice.grandTotal.value).toBe(11.63)
		expect(invoice.roundedTotal.value).toBe(11.65)
	})

	it("collects the grand total when rounding is off or its fraction is unknown", () => {
		const off = sale(10, 1)
		off.setRounding(false, 0)
		expect(off.roundedTotal.value).toBe(11.5)

		const unknown = sale(10, 1)
		unknown.setRounding(true, null)
		expect(unknown.roundedTotal.value).toBe(11.5)
	})
})

describe("money: tax rounded per tax line, as ERPNext does", () => {
	it("rounds each tax line once, not their sum", () => {
		const invoice = useInvoice()
		invoice.taxRules.value = [
			{ charge_type: "On Net Total", rate: 10, account_head: "VAT A" },
			{ charge_type: "On Net Total", rate: 5, account_head: "VAT B" },
		]
		invoice.taxInclusive.value = false
		invoice.addItem(product("ITEM-A", 10.04), 1)

		// ERPNext: 1.004 -> 1.00 and 0.502 -> 0.50
		expect(invoice.totalTax.value).toBe(1.5)
		expect(invoice.grandTotal.value).toBe(11.54)
	})
})
