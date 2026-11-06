import { beforeEach, describe, expect, it, vi } from "vitest"

const returnSerials = vi.hoisted(() => vi.fn())

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({
		...options,
		submit: async () => ({}),
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
	useSerialNumberStore: () => ({ returnSerials }),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({}) }))
vi.mock("@/stores/bluetoothPrinter", () => ({
	useBluetoothPrinterStore: () => ({}),
}))
vi.mock("@/utils/escpos", () => ({ prefetchPrintFormat: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))

import { useInvoice } from "@/composables/useInvoice"

const serialItem = {
	item_code: "PHONE",
	has_serial_no: 1,
	serial_no: "S1\nS2",
	rate: 10,
}

describe("clearing a cart with serials", () => {
	beforeEach(() => {
		returnSerials.mockClear()
	})

	it("gives them back when the cart is abandoned", async () => {
		const invoice = useInvoice()
		invoice.addItem(serialItem, 2)

		await invoice.clearCart()

		expect(returnSerials).toHaveBeenCalledWith("PHONE", "S1\nS2")
	})

	it("keeps them taken when the items left as a sale", async () => {
		const invoice = useInvoice()
		invoice.addItem(serialItem, 2)

		await invoice.clearCart({ sold: true })

		expect(returnSerials).not.toHaveBeenCalled()
		expect(invoice.invoiceItems.value).toEqual([])
	})

	it("still forgets the sale's id, so the next sale gets its own", async () => {
		const invoice = useInvoice()
		const sale = { customer: "C", items: [], payments: [] }
		const first = invoice.getCheckoutOfflineId(sale)

		await invoice.clearCart({ sold: true })

		expect(invoice.getCheckoutOfflineId(sale)).not.toBe(first)
	})
})
