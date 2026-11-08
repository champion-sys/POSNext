import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({ handlers: {}, calls: [] }))
const toast = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() }))

vi.mock("frappe-ui", () => ({
	createResource: (options) => ({
		...options,
		error: null,
		submit: async (params) => {
			server.calls.push({ url: options.url, params })
			const handler = server.handlers[options.url]
			return handler ? handler(params) : {}
		},
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
vi.mock("@/stores/serialNumber", () => ({ useSerialNumberStore: () => ({ returnSerials: vi.fn() }) }))
vi.mock("@/stores/bluetoothPrinter", () => ({ useBluetoothPrinterStore: () => ({}) }))
vi.mock("@/utils/escpos", () => ({ prefetchPrintFormat: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/composables/useToast", () => ({ useToast: () => toast }))
vi.mock("@/stores/posOffers", () => ({ usePOSOffersStore: () => ({ hasFetched: true, updateCartSnapshot: () => {}, checkOfferEligibility: () => ({ eligible: true }), allEligibleOffers: [], autoEligibleOffers: [], ensureOffersFetched: async () => {} }) }))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ currentProfile: {} }) }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		invoiceType: "Sales Invoice",
		shouldEnforceStockValidation: () => false,
		disableRoundedTotal: false,
		roundingFraction: 0,
	}),
}))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({ offlineState: { subscribe: vi.fn(), isOffline: false } }))
vi.mock("@/utils/errorHandler", () => ({ parseError: (error) => error.message }))

import { usePOSCartStore } from "../posCart"

const APPLY_OFFERS = "pos_next.api.invoices.apply_offers"

function product(code, price) {
	return { item_code: code, item_name: code, rate: price, price_list_rate: price, uom: "Nos", stock_uom: "Nos" }
}

function line(cart, code) {
	return cart.invoiceItems.find((item) => item.item_code === code)
}

describe("money: offers and coupons in the cart store", () => {
	let cart

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
		server.handlers = {}
		server.calls = []
		toast.showWarning.mockClear()
		cart = usePOSCartStore()
		cart.cancelPendingOfferProcessing()
		cart.posProfile = "SI Main"
		cart.addItem(product("X", 100), 1)
		cart.addItem(product("Y", 50), 1)
	})

	it("removing the only offer leaves the coupon on the sale", async () => {
		cart.applyDiscountToCart({ name: "TEN", code: "TEN", percentage: 10, amount: 15, apply_on: "Grand Total" })
		server.handlers[APPLY_OFFERS] = () => ({
			items: [
				{ item_code: "X", price_list_rate: 100, discount_percentage: 10, discount_amount: 10, pricing_rules: "OFFER-A" },
				{ item_code: "Y", price_list_rate: 50, discount_percentage: 0, discount_amount: 0, pricing_rules: "" },
			],
			free_items: [],
			applied_pricing_rules: ["OFFER-A"],
		})
		await cart.applyOffer({ name: "OFFER-A", title: "A" }, {})

		await cart.removeOffer("OFFER-A", {})

		expect(cart.appliedCoupon?.code).toBe("TEN")
		expect(line(cart, "X").amount).toBe(100)
		// 10% of 150, worked out on the cart as it is now
		expect(cart.additionalDiscount).toBe(15)
		const { invoiceData } = cart.buildCheckoutPayload()
		expect(invoiceData.coupon_code).toBe("TEN")
	})

	it("a Rate offer's price goes when the offer goes, and the server is always sent the list price", async () => {
		server.handlers[APPLY_OFFERS] = () => ({
			items: [
				{ item_code: "X", price_list_rate: 80, rate: 100, discount_percentage: 0, discount_amount: 0, pricing_rules: "OFFER-RATE" },
				{ item_code: "Y", price_list_rate: 50, rate: 50, discount_percentage: 0, discount_amount: 0, pricing_rules: "" },
			],
			free_items: [],
			applied_pricing_rules: ["OFFER-RATE"],
		})
		await cart.applyOffer({ name: "OFFER-RATE", title: "X for 80" }, {})
		expect(line(cart, "X").amount).toBe(80)

		const sent = cart.buildOfferEvaluationPayload({}).items.find((item) => item.item_code === "X")
		expect(sent.price_list_rate).toBe(100)

		await cart.removeOffer("OFFER-RATE", {})

		expect(line(cart, "X").amount).toBe(100)
		expect(line(cart, "X").price_list_rate).toBe(100)
		expect(cart.subtotal).toBe(150)
	})

	it("a coupon whose minimum the cart no longer reaches is taken off, and the cashier is told", async () => {
		cart.applyDiscountToCart({
			name: "MIN120",
			code: "MIN120",
			percentage: 10,
			amount: 15,
			apply_on: "Grand Total",
			coupon: { discount_type: "Percentage", discount_percentage: 10, min_amount: 120, apply_on: "Grand Total" },
		})

		cart.removeItem("X")
		await nextTick()

		expect(cart.appliedCoupon).toBe(null)
		expect(cart.additionalDiscount).toBe(0)
		expect(toast.showWarning).toHaveBeenCalledWith(expect.stringContaining("MIN120"))
	})

	it("collects the rounded total the POS Profile asks for", () => {
		cart.clearCart()
		cart.addItem(product("Z", 11.5), 1)

		expect(cart.grandTotal).toBe(11.5)
		expect(cart.roundedTotal).toBe(12)
		expect(cart.roundingAdjustment).toBe(0.5)
	})
})
