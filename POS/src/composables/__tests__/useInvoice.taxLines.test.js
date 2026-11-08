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

function product(code, price) {
	return { item_code: code, item_name: code, rate: price, price_list_rate: price, uom: "Nos", stock_uom: "Nos" }
}

function sell(rules, inclusive, prices) {
	const invoice = useInvoice()
	invoice.taxRules.value = rules
	invoice.taxInclusive.value = inclusive
	for (const [index, price] of prices.entries()) invoice.addItem(product(`ITEM-${index}`, price), 1)
	return invoice
}

const sum = (lines) => Math.round(lines.reduce((total, line) => total + line.tax_amount, 0) * 100) / 100

describe("the tax lines a receipt prints", () => {
	it("is one line per rated rule, named by its description", () => {
		const invoice = sell(
			[
				{ charge_type: "On Net Total", rate: 15, account_head: "VAT - S", description: "VAT 15%" },
				{ charge_type: "Actual", rate: 0, account_head: "Delivery - S", description: "Delivery" },
			],
			false,
			[100, 33.33],
		)

		expect(invoice.taxLines.value).toEqual([
			{
				description: "VAT 15%",
				account_head: "VAT - S",
				charge_type: "On Net Total",
				rate: 15,
				included_in_print_rate: 0,
				tax_amount: invoice.totalTax.value,
			},
		])
		expect(invoice.totalTax.value).toBe(20)
	})

	it("adds up to the cart's tax with two exclusive rules", () => {
		const invoice = sell(
			[
				{ charge_type: "On Net Total", rate: 5, account_head: "A", description: "City" },
				{ charge_type: "On Net Total", rate: 10, account_head: "B", description: "State" },
			],
			false,
			[99.83, 39.83, 9.83],
		)

		expect(invoice.taxLines.value.map((line) => line.description)).toEqual(["City", "State"])
		expect(sum(invoice.taxLines.value)).toBe(invoice.totalTax.value)
	})

	it("adds up to the cart's tax when prices include it", () => {
		const invoice = sell(
			[
				{ charge_type: "On Net Total", rate: 5, account_head: "A", description: "City" },
				{ charge_type: "On Net Total", rate: 10, account_head: "B", description: "State" },
			],
			true,
			[115, 23, 9.99],
		)

		expect(invoice.taxLines.value.every((line) => line.included_in_print_rate === 1)).toBe(true)
		expect(sum(invoice.taxLines.value)).toBe(invoice.totalTax.value)
	})

	it("is empty without rated taxes", () => {
		expect(sell([], false, [10]).taxLines.value).toEqual([])
	})
})
