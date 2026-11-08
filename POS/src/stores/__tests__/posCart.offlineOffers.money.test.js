import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const offers = vi.hoisted(() => ({ list: [] }))

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({ ...options, error: null, submit: async () => ({}), reload: async () => ({}) }),
	call: async () => ({}),
}))
vi.mock("@/utils/offline", () => ({
	isOffline: () => true,
	getCachedItem: vi.fn(),
	getSetting: vi.fn(),
	setSetting: vi.fn(),
}))
vi.mock("@/stores/serialNumber", () => ({ useSerialNumberStore: () => ({ returnSerials: vi.fn() }) }))
vi.mock("@/stores/bluetoothPrinter", () => ({ useBluetoothPrinterStore: () => ({}) }))
vi.mock("@/utils/escpos", () => ({ prefetchPrintFormat: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/stores/posOffers", () => ({
	usePOSOffersStore: () => ({
		hasFetched: true,
		updateCartSnapshot: () => {},
		checkOfferEligibility: () => ({ eligible: true }),
		allEligibleOffers: [],
		get autoEligibleOffers() {
			return offers.list
		},
		ensureOffersFetched: async () => {},
	}),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ currentProfile: {} }) }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ invoiceType: "Sales Invoice", shouldEnforceStockValidation: () => false }),
}))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({ offlineState: { subscribe: vi.fn(), isOffline: true } }))
vi.mock("@/utils/errorHandler", () => ({ parseError: (error) => error.message }))

import { usePOSCartStore } from "../posCart"

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("money: offers applied offline", () => {
	let cart

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
		cart = usePOSCartStore()
		cart.cancelPendingOfferProcessing()
		cart.posProfile = "SI Main"
		// 3 x X at 20
		cart.addItem({ item_code: "X", item_name: "X", rate: 20, price_list_rate: 20, uom: "Nos", stock_uom: "Nos" }, 3)
	})

	async function applyOffline(offer) {
		offers.list = [{ name: "OFFER-1", title: "Offer", offer: "Item Price", apply_on: "Item Code", eligible_items: ["X"], ...offer }]
		cart.forceRefreshOffers()
		await settle()
		expect(cart.appliedOffers.map((o) => o.code)).toEqual(["OFFER-1"])
		return cart.invoiceItems.find((i) => i.item_code === "X")
	}

	it("a 'Discount Amount' of 5 takes 5 off each unit, as the online path does", async () => {
		const line = await applyOffline({ discount_type: "Discount Amount", discount_amount: 5 })
		// Online, apply_offers sends discount_amount = 5 x qty = 15
		expect(line.amount).toBe(45)
	})

	it("a 'Rate' offer of 15 sells each unit at 15", async () => {
		const line = await applyOffline({ discount_type: "Rate", rate: 15 })
		expect(line.amount).toBe(45)
	})
})
