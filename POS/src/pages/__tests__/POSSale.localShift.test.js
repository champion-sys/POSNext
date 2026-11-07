/**
 * The page's side of a shift opened offline, once the connection is back but the server
 * has not created that shift. Children are stubbed, and frappe-ui is faked because it does
 * not load under vitest.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"
import { abandonLocalShift, shiftState } from "@/composables/useShift"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSSyncStore } from "@/stores/posSync"
import { usePOSUIStore } from "@/stores/posUI"
import POSSale from "../POSSale.vue"

const { workerProxy } = vi.hoisted(() => {
	globalThis.__ = (text) => text

	return {
		workerProxy: new Proxy(
			{},
			{
				get: (_target, name) => {
					if (name === "then") return undefined
					if (name === "getOfflineInvoices" || name === "getQueueRows") return async () => []
					if (name === "getOfflineInvoiceCount") return async () => 0
					return async () => ({ success: true })
				},
			},
		),
	}
})

vi.mock("frappe-ui", () => {
	const stub = { template: "<div><slot /></div>" }
	return {
		Badge: stub,
		Button: stub,
		Card: stub,
		Dialog: stub,
		FeatherIcon: stub,
		FormControl: stub,
		Input: stub,
		LoadingIndicator: stub,
		call: vi.fn(async () => null),
		createResource: () =>
			reactive({
				data: null,
				loading: false,
				error: null,
				fetch: async () => null,
				reload: async () => null,
				submit: async () => null,
				reset: () => {},
			}),
	}
})

// The real monitor pings on a timer and would change isOffline in the middle of a test
vi.mock("@/utils/offline/offlineState", () => {
	const offlineState = {
		isOffline: false,
		manualOffline: false,
		serverOnline: true,
		checkConnectivity: async () => true,
		getConnectionQuality: () => "good",
		getState: () => ({ isOffline: false }),
		initialize: () => {},
		setManualOffline: () => {},
		setServerOnline: () => {},
		subscribe: () => () => {},
		toggleManualOffline: () => {},
		updateState: () => {},
	}
	return {
		offlineState,
		isOffline: () => false,
		checkConnectivity: async () => true,
		getConnectionQuality: () => "good",
		getOfflineState: () => ({ isOffline: false }),
		setManualOffline: () => {},
		toggleManualOffline: () => {},
	}
})

vi.mock("@/data/session", () => ({
	session: {
		user: "a@example.com",
		isLoggedIn: true,
		logout: { loading: false, submit: vi.fn() },
	},
}))
vi.mock("@/data/user", () => ({
	useUserData: () => ({ userName: { value: "Cashier" }, userImage: { value: null } }),
	userResource: { reset: vi.fn() },
	userData: { refresh: vi.fn() },
}))

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn(async () => []) }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: workerProxy }))
vi.mock("@/platform/store", () => ({ localStore: workerProxy }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: vi.fn() }))
vi.mock("@/composables/useRealtimeStock", () => ({
	useRealtimeStock: () => ({ onStockUpdate: () => () => {} }),
}))
vi.mock("@/composables/useRealtimePosProfile", () => ({
	useRealtimePosProfile: () => ({ onPosProfileUpdate: vi.fn() }),
}))

const PAYMENT = {
	payments: [{ mode_of_payment: "Cash", amount: 10, type: "Cash" }],
	paid_amount: 10,
	change_amount: 0,
}

const LOCAL_SHIFT = "pos_offline_shift-1"

const openShift = (name) => {
	shiftState.value = {
		pos_opening_shift: { name, user: "a@example.com" },
		pos_profile: { name: "Main", company: "Acme" },
		company: { name: "Acme" },
		isOpen: true,
		_initialElapsedMs: 0,
		_receivedAt: 1,
	}
}

describe("POSSale with a shift the server does not know yet", () => {
	let wrapper
	let cartStore
	let offlineStore
	let settingsStore
	let uiStore

	const checkout = async () => {
		await wrapper.vm.handlePaymentCompleted(PAYMENT)
		await flushPromises()
	}

	beforeEach(async () => {
		openShift(LOCAL_SHIFT)

		// Named everywhere, because a timer left by an earlier test's store makes its Pinia active
		const pinia = createPinia()
		setActivePinia(pinia)

		wrapper = shallowMount(POSSale, {
			global: { plugins: [pinia], mocks: { __: (text) => text }, stubs: { teleport: true } },
		})
		await flushPromises()

		cartStore = usePOSCartStore(pinia)
		offlineStore = usePOSSyncStore(pinia)
		settingsStore = usePOSSettingsStore(pinia)
		uiStore = usePOSUIStore(pinia)

		cartStore.posOpeningShift = LOCAL_SHIFT
		cartStore.customer = { name: "CUST-1", customer_name: "Customer" }
		cartStore.submitInvoice = vi.fn(async () => ({ name: "SINV-1", grand_total: 10 }))
		cartStore.buildCheckoutPayload = () => ({
			invoiceData: { items: [{ item_code: "A", qty: 1 }], payments: PAYMENT.payments },
			redeemedCustomerCredit: 0,
			customerCreditDict: [],
		})
		offlineStore.isOffline = false
		offlineStore.saveInvoiceOffline = vi.fn(async () => ({ offline_id: "pos_offline_new" }))
		settingsStore.settings.sync_mode = "Realtime"
	})

	afterEach(() => {
		wrapper.unmount()
		shiftState.value = { pos_opening_shift: null, pos_profile: null, company: null, isOpen: false }
	})

	it("queues a sale behind its shift, even with a connection and in realtime mode", async () => {
		await checkout()

		expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
		expect(cartStore.submitInvoice).not.toHaveBeenCalled()
	})

	it("sells online again once the shift has its real name", async () => {
		openShift("POSA-OS-1")
		await flushPromises()

		await checkout()

		expect(cartStore.submitInvoice).toHaveBeenCalledTimes(1)
		expect(offlineStore.saveInvoiceOffline).not.toHaveBeenCalled()
	})

	it("keeps the shift on the cart from one sale to the next", async () => {
		cartStore.clearCart({ sold: true })
		await flushPromises()

		expect(cartStore.posOpeningShift).toBe(LOCAL_SHIFT)
	})

	it("puts later sales on the real name as soon as it is known", async () => {
		openShift("POSA-OS-1")
		await flushPromises()

		expect(cartStore.posOpeningShift).toBe("POSA-OS-1")
	})

	it("leaves the cart of a shift from the server alone", async () => {
		cartStore.posOpeningShift = "POSA-OS-1"
		openShift("POSA-OS-2")
		await flushPromises()

		expect(cartStore.posOpeningShift).toBe("POSA-OS-1")
	})

	it("will not queue a sale on a gift card, which only the server can confirm", async () => {
		cartStore.appliedCoupon = { name: "GIFT-1", coupon: { coupon_type: "Gift Card" } }
		uiStore.showPaymentDialog = true

		await checkout()

		expect(offlineStore.saveInvoiceOffline).not.toHaveBeenCalled()
		expect(cartStore.submitInvoice).not.toHaveBeenCalled()
		expect(uiStore.showPaymentDialog).toBe(false)
	})

	it("queues a sale on an ordinary coupon, which the device can check", async () => {
		cartStore.appliedCoupon = { name: "SAVE5", coupon: { coupon_type: "Promotional" } }

		await checkout()

		expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
	})

	it("sends a gift card straight to the server once the shift has its real name", async () => {
		openShift("POSA-OS-1")
		cartStore.appliedCoupon = { name: "GIFT-1", coupon: { coupon_type: "Gift Card" } }

		await checkout()

		expect(cartStore.submitInvoice).toHaveBeenCalledTimes(1)
		expect(offlineStore.saveInvoiceOffline).not.toHaveBeenCalled()
	})

	it("closes the payment dialog when a manager voids the shift, so nothing is paid into it", async () => {
		uiStore.showPaymentDialog = true

		await abandonLocalShift(LOCAL_SHIFT)
		await flushPromises()

		expect(uiStore.showPaymentDialog).toBe(false)
	})

	it("offers no payment that needs the server", async () => {
		expect(wrapper.vm.mustQueue).toBe(true)

		openShift("POSA-OS-1")
		await flushPromises()

		expect(wrapper.vm.mustQueue).toBe(false)
	})

	describe("closing it", () => {
		beforeEach(() => {
			offlineStore.updatePendingCount = vi.fn()
			offlineStore.syncAllPending = vi.fn()
			offlineStore.loadPendingInvoices = vi.fn()
			offlineStore.pendingCount = 1
			offlineStore.pendingInvoicesList = [{ id: 1, offline_id: LOCAL_SHIFT, entity: "shift_open", sync_failed: true }]
		})

		it("joins the queue when the setting allows it", async () => {
			settingsStore.settings.allow_offline_shift_close = 1

			expect(await wrapper.vm.ensureInvoicesSyncedBeforeClose()).toBe(true)
		})

		it("waits for the shift when the setting does not, even if its record is under review", async () => {
			settingsStore.settings.allow_offline_shift_close = 0

			expect(await wrapper.vm.ensureInvoicesSyncedBeforeClose()).toBe(false)
			expect(uiStore.showOfflineInvoicesDialog).toBe(true)
		})
	})
})
