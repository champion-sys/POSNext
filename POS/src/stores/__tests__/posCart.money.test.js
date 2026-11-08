import { createPinia, setActivePinia } from "pinia"
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
	usePOSSettingsStore: () => ({ invoiceType: "Sales Invoice", shouldEnforceStockValidation: () => false }),
}))
vi.mock("@/utils/offline/entities", () => ({ isLocalName: () => false }))
vi.mock("@/utils/offline/offlineState", () => ({ offlineState: { subscribe: vi.fn(), isOffline: false } }))
vi.mock("@/utils/errorHandler", () => ({ parseError: (error) => error.message }))

import { usePOSCartStore } from "../posCart"

function product(code, price) {
	return { item_code: code, item_name: code, rate: price, price_list_rate: price, uom: "Nos", stock_uom: "Nos" }
}

/** What apply_offers returns: every row it priced, cleared, then the rules that still apply */
function offerResponse(rows) {
	return {
		items: rows.map(([code, price, percent, rule]) => ({
			item_code: code,
			price_list_rate: price,
			rate: price,
			discount_percentage: percent,
			discount_amount: percent ? (price * percent) / 100 : 0,
			pricing_rules: rule || "",
		})),
		free_items: [],
		applied_pricing_rules: [...new Set(rows.map((r) => r[3]).filter(Boolean))],
	}
}

function lineTotal(cart, code) {
	const line = cart.invoiceItems.find((item) => item.item_code === code)
	return line.amount
}

describe("money: offers", () => {
	let cart

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
		server.handlers = {}
		server.calls = []
		cart = usePOSCartStore()
		cart.cancelPendingOfferProcessing()
		cart.posProfile = "SI Main"
		cart.addItem(product("X", 100), 1)
		cart.addItem(product("Y", 50), 1)
	})

	async function applyBoth() {
		server.handlers["pos_next.api.invoices.apply_offers"] = () =>
			offerResponse([
				["X", 100, 10, "OFFER-A"],
				["Y", 50, 10, "OFFER-B"],
			])
		await cart.applyOffer({ name: "OFFER-A", title: "A" }, {})
		await cart.applyOffer({ name: "OFFER-B", title: "B" }, {})
		expect(lineTotal(cart, "X")).toBe(90)
		expect(lineTotal(cart, "Y")).toBe(45)
	}

	it("removing one of two offers takes its discount off the line", async () => {
		await applyBoth()

		// The server, asked for OFFER-B only, returns X cleared
		server.handlers["pos_next.api.invoices.apply_offers"] = () =>
			offerResponse([
				["X", 100, 0, null],
				["Y", 50, 10, "OFFER-B"],
			])
		await cart.removeOffer("OFFER-A", {})

		expect(cart.appliedOffers.map((o) => o.code)).toEqual(["OFFER-B"])
		expect(lineTotal(cart, "X")).toBe(100)
		expect(cart.subtotal - cart.totalDiscount).toBe(145)
	})

	it("removing the only offer takes its discount off the line", async () => {
		server.handlers["pos_next.api.invoices.apply_offers"] = () => offerResponse([["X", 100, 10, "OFFER-A"], ["Y", 50, 0, null]])
		await cart.applyOffer({ name: "OFFER-A", title: "A" }, {})
		expect(lineTotal(cart, "X")).toBe(90)

		await cart.removeOffer("OFFER-A", {})

		expect(cart.appliedOffers).toEqual([])
		expect(lineTotal(cart, "X")).toBe(100)
		const row = cart.formatItemsForSubmission(cart.invoiceItems).find((r) => r.item_code === "X")
		expect(row.rate).toBe(100)
	})

	it("a fixed-rate offer (Pricing Rule 'Rate') changes the price the cart charges", async () => {
		// apply_offers puts the rule's rate in price_list_rate, with no discount
		server.handlers["pos_next.api.invoices.apply_offers"] = () => ({
			items: [
				{ item_code: "X", price_list_rate: 80, rate: 100, discount_percentage: 0, discount_amount: 0, pricing_rules: "OFFER-RATE" },
				{ item_code: "Y", price_list_rate: 50, rate: 50, discount_percentage: 0, discount_amount: 0, pricing_rules: "" },
			],
			free_items: [],
			applied_pricing_rules: ["OFFER-RATE"],
		})
		const applied = await cart.applyOffer({ name: "OFFER-RATE", title: "X for 80" }, {})

		expect(applied).toBe(true)
		expect(toast.showSuccess).toHaveBeenCalledWith("X for 80 applied successfully")
		expect(lineTotal(cart, "X")).toBe(80)
	})
})

describe("money: write-off", () => {
	let cart

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.stubGlobal("__", (text, values = []) => text.replace(/\{(\d)\}/g, (_m, i) => values[i]))
		server.handlers = {}
		server.calls = []
		cart = usePOSCartStore()
		cart.cancelPendingOfferProcessing()
		cart.posProfile = "SI Main"
		cart.setCustomer("Walk-in")
	})

	it("a write-off from a sale that failed is not applied to the next sale", async () => {
		// Sale 1: 99.50 paid on 100, 0.50 written off, and the server refuses it
		cart.addItem(product("X", 100), 1)
		cart.payments.push({ mode_of_payment: "Cash", amount: 99.5, type: "Cash" })
		cart.setWriteOffAmount(0.5)
		server.handlers["pos_next.api.invoices.update_invoice"] = () => {
			throw new Error("Not enough stock")
		}
		await expect(cart.submitInvoice()).rejects.toThrow("Not enough stock")

		// The cashier starts again and the customer pays a new sale in full
		cart.clearCart()
		cart.setCustomer("Walk-in")
		cart.addItem(product("Y", 50), 1)
		cart.payments.push({ mode_of_payment: "Cash", amount: 50, type: "Cash" })
		server.handlers["pos_next.api.invoices.update_invoice"] = () => ({ name: "SINV-2", doctype: "Sales Invoice" })
		server.handlers["pos_next.api.invoices.submit_invoice"] = () => ({ name: "SINV-2" })
		await cart.submitInvoice()

		const submitted = server.calls.find((c) => c.url === "pos_next.api.invoices.submit_invoice")
		expect(submitted.params.data.write_off_amount).toBe(0)
	})
})
