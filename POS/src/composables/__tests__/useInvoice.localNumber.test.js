import { beforeEach, describe, expect, it, vi } from "vitest"

const { calls, allocate } = vi.hoisted(() => {
	let counter = 0
	return {
		calls: { update: [], submit: [] },
		allocate: vi.fn(async () => {
			counter += 1
			return `LACC-SINV-2026-3-${String(counter).padStart(5, "0")}`
		}),
	}
})

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({
		...options,
		error: null,
		submit: async (params) => {
			if (options.url === "pos_next.api.invoices.update_invoice") {
				calls.update.push(params)
				// A server that does not keep the field yet
				const { posa_local_number: _dropped, ...draft } = params.data
				return { ...draft, name: "ACC-SINV-2026-00042" }
			}
			if (options.url === "pos_next.api.invoices.submit_invoice") {
				calls.submit.push(params)
				return { name: params.invoice.name }
			}
			return { customer: "DEFAULT-CUSTOMER" }
		},
		reload: async () => ({}),
	}),
	call: async () => ({}),
}))
vi.mock("@/utils/offline", () => ({
	isOffline: () => false,
	getCachedItem: vi.fn(),
	getSetting: vi.fn(),
	setSetting: vi.fn(),
}))
vi.mock("@/utils/offline/localNumbering", () => ({ allocateLocalNumber: allocate }))
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
	posa_pos_opening_shift: "POSA-OS-26-0000003",
	pos_profile: "Main",
	items: [{ item_code: "COFFEE", qty, rate: 10, uom: "Nos" }],
	payments: [{ mode_of_payment: "Cash", amount: 10 * qty }],
})

beforeEach(() => {
	allocate.mockClear()
	calls.update.length = 0
	calls.submit.length = 0
})

describe("the local number of a checkout", () => {
	it("is handed out once for a cart, however often it is retried", async () => {
		const invoice = useInvoice()
		const first = await invoice.getCheckoutLocalNumber(sale())
		const again = await invoice.getCheckoutLocalNumber(sale())

		expect(again).toBe(first)
		expect(allocate).toHaveBeenCalledTimes(1)
	})

	it("is handed out once to two attempts started together", async () => {
		const invoice = useInvoice()
		const [a, b] = await Promise.all([invoice.getCheckoutLocalNumber(sale()), invoice.getCheckoutLocalNumber(sale())])

		expect(a).toBe(b)
		expect(allocate).toHaveBeenCalledTimes(1)
	})

	it("is a new one for a changed cart and for the next sale", async () => {
		const invoice = useInvoice()
		const first = await invoice.getCheckoutLocalNumber(sale(1))
		const changed = await invoice.getCheckoutLocalNumber(sale(2))
		await invoice.clearCart()
		const next = await invoice.getCheckoutLocalNumber(sale(2))

		expect(new Set([first, changed, next]).size).toBe(3)
	})

	it("is asked for again when none could be handed out", async () => {
		const invoice = useInvoice()
		allocate.mockResolvedValueOnce(null)

		expect(await invoice.getCheckoutLocalNumber(sale())).toBeNull()
		expect(await invoice.getCheckoutLocalNumber(sale())).toMatch(/^LACC-/)
	})

	it("goes with the draft and with the submit of an online sale", async () => {
		const invoice = useInvoice()
		invoice.posProfile.value = "Main"
		invoice.posOpeningShift.value = "POSA-OS-26-0000003"
		invoice.invoiceItems.value = [
			{ item_code: "COFFEE", item_name: "Coffee", quantity: 1, rate: 10, price_list_rate: 10, amount: 10, uom: "Nos" },
		]
		invoice.payments.value = [{ mode_of_payment: "Cash", amount: 10 }]

		await invoice.submitInvoice()

		const number = calls.update[0].data.posa_local_number
		expect(number).toMatch(/^LACC-SINV-2026-3-\d{5}$/)
		expect(calls.submit[0].invoice.posa_local_number).toBe(number)
		expect(calls.submit[0].data.offline_id).toMatch(/^pos_offline_/)
		expect(calls.submit[0].data.offline_id).not.toBe(number)
	})
})
