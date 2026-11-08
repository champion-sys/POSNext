/**
 * The cart's stock check when a row changes: its quantity, its unit, or a unit that
 * merges it into another row. Stock is counted in the stock UOM over every row of the
 * item, against the server's quantity less what queued offline sales took.
 */
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	addItemToInvoice: vi.fn(),
	baseUpdateItemQuantity: vi.fn(),
	showWarning: vi.fn(),
	showError: vi.fn(),
	invoiceItems: null,
}))

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn(async () => []) }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: { getOfflineInvoices: vi.fn(async () => []), updateStockQuantities: vi.fn(async () => {}) },
}))
vi.mock("frappe-ui", () => ({ call: vi.fn(), createResource: () => ({ fetch: vi.fn(), submit: vi.fn() }) }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		invoiceType: "Sales Invoice",
		shouldEnforceStockValidation: () => true,
	}),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ profileWarehouse: "Main" }) }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showError: mocks.showError, showSuccess: vi.fn(), showWarning: mocks.showWarning }),
}))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/stores/posOffers", () => ({ usePOSOffersStore: () => ({}) }))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({ offlineState: { subscribe: vi.fn() } }))
vi.mock("@/utils/errorHandler", () => ({ parseError: (error) => error.message }))
vi.mock("@/composables/useInvoice", async () => {
	const { computed, ref } = await vi.importActual("vue")
	return {
		useInvoice: () => {
			const empty = () => ref(null)
			mocks.invoiceItems = ref([])
			return {
				invoiceItems: mocks.invoiceItems,
				customer: empty(),
				subtotal: computed(() => 0),
				totalTax: computed(() => 0),
				totalDiscount: computed(() => 0),
				grandTotal: computed(() => 0),
				posProfile: empty(),
				posOpeningShift: empty(),
				posOrderType: empty(),
				payments: ref([]),
				salesTeam: ref([]),
				additionalDiscount: ref(0),
				taxInclusive: ref(false),
				invoiceRemarks: ref(""),
				isSubmitting: ref(false),
				posTableNo: empty(),
				addItem: mocks.addItemToInvoice,
				updateItemQuantity: mocks.baseUpdateItemQuantity,
				resolveUomPricing: vi.fn(async () => ({ rate: 120, price_list_rate: 120 })),
				recalculateItem: vi.fn(),
				rebuildIncrementalCache: vi.fn(),
			}
		},
	}
})

const { useStockStore } = await import("../stock")
const { usePOSCartStore } = await import("../posCart")

const PROFILE = { name: "Main", warehouse: "Main" }
const UOMS = [
	{ uom: "Nos", conversion_factor: 1 },
	{ uom: "Box", conversion_factor: 12 },
]

function row(uom, quantity) {
	return {
		item_code: "SKU",
		item_name: "SKU",
		is_stock_item: 1,
		stock_uom: "Nos",
		uom,
		conversion_factor: uom === "Box" ? 12 : 1,
		quantity,
		rate: uom === "Box" ? 120 : 10,
		warehouse: "Main",
		item_uoms: UOMS,
		// What the server held when the row went in. The live numbers are in the stock store
		original_stock: 100,
		actual_qty: 100,
	}
}

function setup({ server, queued = 0, rows = [] }) {
	const stock = useStockStore()
	stock.setWarehouse("Main")
	stock.init([{ item_code: "SKU", actual_qty: server, warehouse: "Main" }])
	stock.setQueued(new Map([["SKU", queued]]))
	const cart = usePOSCartStore()
	mocks.invoiceItems.value.push(...rows)
	return cart
}

describe("the cart's stock check when a row changes", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
	})

	it("counts what queued sales took when a quantity goes up", () => {
		const cart = setup({ server: 5, queued: 3, rows: [row("Nos", 1)] })

		cart.updateItemQuantity("SKU", 3, "Nos")

		expect(mocks.showWarning).toHaveBeenCalled()
		expect(mocks.baseUpdateItemQuantity).not.toHaveBeenCalled()
	})

	it("lets a quantity go up within what is left", () => {
		const cart = setup({ server: 5, queued: 3, rows: [row("Nos", 1)] })

		cart.updateItemQuantity("SKU", 2, "Nos")

		expect(mocks.baseUpdateItemQuantity).toHaveBeenCalledWith("SKU", 2, "Nos")
	})

	it("counts the item's rows in every unit when one is added", () => {
		const cart = setup({ server: 15, rows: [row("Box", 1)] })

		// 12 in the box row and 4 more units is 16, over 15
		expect(() => cart.addItem({ ...row("Nos", 0), quantity: undefined }, 4, false, PROFILE)).toThrow()
		expect(mocks.addItemToInvoice).not.toHaveBeenCalled()
	})

	it("checks a change of unit in the edit dialog", async () => {
		const cart = setup({ server: 5, rows: [row("Nos", 1)] })

		const saved = await cart.updateItemDetails("SKU", { uom: "Box" }, "Nos")

		expect(saved).toBe(false)
		expect(mocks.invoiceItems.value[0].uom).toBe("Nos")
	})

	it("checks a change of unit that merges two rows", async () => {
		// A box (12) and 2 units is 14 of 15. Moving the 2 into the box row makes 3 boxes, 36
		const cart = setup({ server: 15, rows: [row("Box", 1), row("Nos", 2)] })

		await cart.changeItemUOM("SKU", "Box", "Nos")

		expect(mocks.showWarning).toHaveBeenCalled()
		expect(mocks.invoiceItems.value.map((item) => [item.uom, item.quantity])).toEqual([
			["Box", 1],
			["Nos", 2],
		])
	})

	it("never refuses a change that needs less stock", async () => {
		const cart = setup({ server: 5, queued: 5, rows: [row("Box", 1)] })

		const saved = await cart.updateItemDetails("SKU", { uom: "Nos" }, "Box")

		expect(saved).toBe(true)
		expect(mocks.invoiceItems.value[0].uom).toBe("Nos")
	})
})
