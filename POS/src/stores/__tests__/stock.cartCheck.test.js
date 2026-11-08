/**
 * Review proof: the stock check that runs when an item goes into the cart.
 *
 * The item comes from the grid (itemSearch.filteredItems), which hands over
 * actual_qty = server - cart - queued and original_stock = server. The cart's
 * check (posCart.addItem -> checkStockAvailability) is the only thing between
 * the cashier and an offline sale, because the server sees the sale only later.
 */
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const mocks = vi.hoisted(() => ({
	call: vi.fn(async () => []),
	addItemToInvoice: vi.fn(),
	offlineWorker: {
		getCacheStats: vi.fn(async () => ({ items: 1, cacheReady: true, lastSync: 1 })),
		cacheItems: vi.fn(async () => ({ success: true })),
		searchCachedItems: vi.fn(async () => []),
		setShowVariantsAsItems: vi.fn(),
		getOfflineInvoices: vi.fn(async () => []),
		updateStockQuantities: vi.fn(async () => {}),
	},
}))

vi.mock("@/utils/apiWrapper", () => ({ call: mocks.call }))
vi.mock("@/utils/offline", () => ({
	getSetting: vi.fn(async (_key, fallback) => fallback),
	setSetting: vi.fn(),
	isOffline: () => false,
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: mocks.offlineWorker }))
vi.mock("@/utils/offline/items", () => ({ updateItemBatchSerialData: vi.fn() }))
vi.mock("@/composables/useRealtimePosProfile", () => ({
	useRealtimePosProfile: () => ({ onPosProfileUpdate: vi.fn() }),
}))
vi.mock("frappe-ui", () => ({
	call: vi.fn(),
	createResource: () => ({ fetch: vi.fn(), submit: vi.fn() }),
}))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		showVariantsAsItems: false,
		invoiceType: "Sales Invoice",
		shouldEnforceStockValidation: () => true,
	}),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ profileWarehouse: "Main" }) }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/stores/posOffers", () => ({ usePOSOffersStore: () => ({}) }))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({ offlineState: { subscribe: vi.fn() } }))
vi.mock("@/utils/errorHandler", () => ({ parseError: (error) => error.message }))
vi.mock("@/composables/useInvoice", async () => {
	const { computed, ref: makeRef } = await vi.importActual("vue")
	return {
		useInvoice: () => {
			const empty = () => makeRef(null)
			return {
				invoiceItems: makeRef([]),
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
				addItem: mocks.addItemToInvoice,
			}
		},
	}
})

const { useItemSearchStore } = await import("../itemSearch")
const { useStockStore } = await import("../stock")
const { usePOSCartStore } = await import("../posCart")

const PROFILE = { name: "Main", warehouse: "Main" }
const flush = () => new Promise((resolve) => setTimeout(resolve))

/** The grid row the cashier taps, as itemSearch builds it from the stock store. */
async function gridItem(serverQty, extra = {}) {
	const row = {
		item_code: "SKU",
		item_name: "SKU",
		rate: 10,
		is_stock_item: 1,
		stock_uom: "Nos",
		uom: "Nos",
		warehouse: "Main",
		actual_qty: serverQty,
		...extra,
	}
	mocks.call.mockImplementation(async (method) => (method.endsWith("get_items_count") ? 1 : [row]))
	const items = useItemSearchStore()
	await items.loadAllItems("Main")
	await flush()
	const stock = useStockStore()
	stock.setWarehouse("Main")
	stock.init([row])
	await flush()
	return { items, stock }
}

describe("stock check when an item goes into the cart", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
	})

	it("control: refuses 6 units when 5 are in stock", async () => {
		const { items } = await gridItem(5)
		const tapped = items.filteredItems.find((item) => item.item_code === "SKU")
		expect(() => usePOSCartStore().addItem(tapped, 6, false, PROFILE)).toThrow()
	})

	it("counts units already sold by a sale still waiting in the offline queue", async () => {
		const { items, stock } = await gridItem(5)
		// All 5 units went in an offline sale that has not reached the server yet
		stock.setQueued(new Map([["SKU", 5]]))

		const tapped = items.filteredItems.find((item) => item.item_code === "SKU")
		expect(tapped.actual_qty).toBe(0) // the grid shows the item as out of stock

		const cart = usePOSCartStore()
		// ...yet the cart lets the same 5 units be sold a second time
		expect(() => cart.addItem(tapped, 5, false, PROFILE)).toThrow()
		expect(mocks.addItemToInvoice).not.toHaveBeenCalled()
	})

	it("converts a box to stock units before comparing with stock", async () => {
		const { items } = await gridItem(5, {
			item_uoms: [
				{ uom: "Nos", conversion_factor: 1 },
				{ uom: "Box", conversion_factor: 12 },
			],
		})
		const tapped = items.filteredItems.find((item) => item.item_code === "SKU")

		// POSSale.handleOptionSelected, option.type === "uom"
		const box = { ...tapped, uom: "Box", conversion_factor: 12, rate: 120, price_list_rate: 120 }

		const cart = usePOSCartStore()
		// One box is 12 units and only 5 are in stock
		expect(() => cart.addItem(box, 1, false, PROFILE)).toThrow()
		expect(mocks.addItemToInvoice).not.toHaveBeenCalled()
	})
})
