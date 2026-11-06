import { describe, expect, it, vi } from "vitest"

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({ ...options, submit: async () => ({}), reload: async () => ({}) }),
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

const sale = (qty = 1) => ({
	customer: "Walk-In",
	discount_amount: 0,
	items: [{ item_code: "COFFEE", qty, rate: 10, uom: "Nos" }],
	payments: [{ mode_of_payment: "Cash", amount: 10 * qty }],
})

describe("the id of a checkout", () => {
	it("stays the same when the same cart is retried", () => {
		const invoice = useInvoice()
		expect(invoice.getCheckoutOfflineId(sale())).toBe(invoice.getCheckoutOfflineId(sale()))
	})

	it("changes when the cart changes", () => {
		const invoice = useInvoice()
		expect(invoice.getCheckoutOfflineId(sale(1))).not.toBe(invoice.getCheckoutOfflineId(sale(2)))
	})

	it("is not reused by an identical sale after the cart was cleared", async () => {
		const invoice = useInvoice()
		const first = invoice.getCheckoutOfflineId(sale())

		await invoice.clearCart()

		expect(invoice.getCheckoutOfflineId(sale())).not.toBe(first)
	})
})
