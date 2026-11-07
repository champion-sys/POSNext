import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { usePOSCartStore } from "../posCart"

const toast = vi.hoisted(() => ({
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showWarning: vi.fn(),
}))
const invoice = vi.hoisted(() => ({
	items: null,
	recalculateItem: vi.fn(),
	rebuildIncrementalCache: vi.fn(),
}))

vi.mock("frappe-ui", () => ({ call: vi.fn(), createResource: vi.fn() }))
vi.mock("@/composables/useToast", () => ({ useToast: () => toast }))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/stores/posOffers", () => ({ usePOSOffersStore: () => ({}) }))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({}) }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		invoiceType: "Sales Invoice",
		shouldEnforceStockValidation: () => true,
	}),
}))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { subscribe: vi.fn() },
}))
vi.mock("@/utils/errorHandler", () => ({
	parseError: (error) => error.message,
}))
vi.mock("@/composables/useInvoice", async () => {
	const { computed, ref: makeRef } = await vi.importActual("vue")
	return {
		useInvoice: () => {
			const empty = () => makeRef(null)
			return {
				invoiceItems: invoice.items,
				customer: empty(),
				subtotal: computed(() => 0),
				totalTax: computed(() => 0),
				totalDiscount: computed(() => 0),
				grandTotal: computed(() => 0),
				posProfile: empty(),
				posOpeningShift: empty(),
				posOrderType: empty(),
				payments: makeRef([]),
				salesTeam: makeRef([]),
				additionalDiscount: makeRef(0),
				taxInclusive: makeRef(false),
				invoiceRemarks: makeRef(""),
				isSubmitting: makeRef(false),
				posTableNo: empty(),
				recalculateItem: invoice.recalculateItem,
				rebuildIncrementalCache: invoice.rebuildIncrementalCache,
			}
		},
	}
})

const line = (extra) => ({
	item_code: "ITEM-1",
	item_name: "قهوة",
	uom: "Nos",
	quantity: 2,
	rate: 50,
	is_stock_item: 1,
	actual_qty: 10,
	...extra,
})

describe("updateItemDetails", () => {
	let cart

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.stubGlobal("__", (text, values = []) =>
			text.replace(/\{(\d)\}/g, (_match, index) => values[index]),
		)
		toast.showError.mockClear()
		toast.showSuccess.mockClear()
		invoice.items = ref([line()])
		cart = usePOSCartStore()
	})

	it("tells the cashier about an edit from the dialog", async () => {
		await cart.updateItemDetails("ITEM-1", { quantity: 3 }, "Nos")
		expect(toast.showSuccess).toHaveBeenCalledWith("قهوة updated")
	})

	it("stays quiet for an edit made in the row", async () => {
		const saved = await cart.updateItemDetails(
			"ITEM-1",
			{ quantity: 3 },
			"Nos",
			{ silent: true },
		)
		expect(saved).toBe(true)
		expect(toast.showSuccess).not.toHaveBeenCalled()
		expect(invoice.items.value[0].quantity).toBe(3)
		expect(invoice.recalculateItem).toHaveBeenCalled()
	})

	it("still reports a refusal when silent", async () => {
		const saved = await cart.updateItemDetails(
			"ITEM-1",
			{ quantity: 99 },
			"Nos",
			{ silent: true },
		)
		expect(saved).toBe(false)
		expect(toast.showError).toHaveBeenCalled()
		expect(invoice.items.value[0].quantity).toBe(2)
	})
})
