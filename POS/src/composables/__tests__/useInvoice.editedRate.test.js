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

/**
 * A cart of one line at 115 with 15% tax, as the cashier left it.
 * @returns {{grandTotal: number, row: Object}} What the screen shows and what goes up
 */
function checkout({ taxInclusive, edit = {} }) {
	const invoice = useInvoice()
	invoice.taxRules.value = [{ charge_type: "On Net Total", rate: 15, account_head: "VAT" }]
	invoice.taxInclusive.value = taxInclusive
	invoice.invoiceItems.value = [
		{
			item_code: "A",
			item_name: "A",
			quantity: 2,
			rate: 115,
			price_list_rate: 115,
			uom: "Nos",
			discount_percentage: 0,
			discount_amount: 0,
			...edit,
		},
	]
	invoice.recalculateItem(invoice.invoiceItems.value[0])
	invoice.rebuildIncrementalCache()

	return {
		grandTotal: invoice.grandTotal.value,
		row: invoice.formatItemsForSubmission(invoice.invoiceItems.value)[0],
	}
}

describe("the rate sent for a sale", () => {
	describe("when prices include tax", () => {
		it("is the edited rate, so the invoice is what the cashier collected", () => {
			const { grandTotal, row } = checkout({ taxInclusive: true, edit: buildRateUpdate(100, 115) })

			expect(grandTotal).toBe(200)
			expect(row.rate * row.qty).toBe(200)
		})

		it("is the edited rate less the discount", () => {
			const { grandTotal, row } = checkout({
				taxInclusive: true,
				edit: { ...buildRateUpdate(100, 115), discount_percentage: 10 },
			})

			expect(grandTotal).toBe(180)
			expect(row.rate * row.qty).toBe(180)
		})

		it("is the list price on a line nobody edited", () => {
			const { grandTotal, row } = checkout({ taxInclusive: true })

			expect(row.rate).toBe(115)
			expect(row.rate * row.qty).toBe(grandTotal)
		})

		it("keeps the list price and the first rate for the audit", () => {
			const { row } = checkout({ taxInclusive: true, edit: buildRateUpdate(100, 115) })

			expect(row.price_list_rate).toBe(115)
			expect(row.original_rate).toBe(115)
			expect(row.is_rate_manually_edited).toBe(1)
		})
	})

	it("is the edited rate when tax is added on top", () => {
		const { row } = checkout({ taxInclusive: false, edit: buildRateUpdate(100, 115) })

		expect(row.rate).toBe(100)
	})
})
