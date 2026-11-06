/**
 * The checkout's side of the offline limit, on the real page and the real stores. Children
 * are stubbed, and frappe-ui is faked because it does not load under vitest.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSSyncStore } from "@/stores/posSync"
import { usePOSUIStore } from "@/stores/posUI"
import { SYNC_AFTER_PAYMENT, SYNC_PERIODIC, SYNC_REALTIME } from "@/utils/offline/invoicePayload"
import POSSale from "../POSSale.vue"

const { limit, workerProxy } = vi.hoisted(() => {
	// Some of what this page imports translates as it loads
	globalThis.__ = (text) => text

	return {
		limit: { passed: false },
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

vi.mock("@/platform/auth", async (importOriginal) => ({
	...(await importOriginal()),
	isPastOfflineSaleLimit: () => limit.passed,
}))

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

const QUEUED_SALE = { id: 7, offline_id: "pos_offline_original", data: { customer: "CUST-1", items: [] } }

const NETWORK_FAILURE = new TypeError("Failed to fetch")

const REFUSAL = "Offline limit reached"

describe("POSSale at the offline limit", () => {
	let wrapper
	let cartStore
	let offlineStore
	let uiStore
	let settingsStore

	async function checkout() {
		await wrapper.vm.handlePaymentCompleted(PAYMENT)
		await flushPromises()
	}

	async function editQueuedSale() {
		offlineStore.loadPendingInvoices = vi.fn()
		offlineStore.pendingInvoicesList = [QUEUED_SALE]
		await wrapper.vm.handleEditOfflineInvoice(QUEUED_SALE)
		cartStore.invoiceItems = [{ item_code: "A", qty: 1 }]
		await flushPromises()
	}

	beforeEach(async () => {
		limit.passed = false

		// Named everywhere, because a timer left by an earlier test's store makes its Pinia active
		const pinia = createPinia()
		setActivePinia(pinia)

		wrapper = shallowMount(POSSale, {
			global: { plugins: [pinia], mocks: { __: (text) => text }, stubs: { teleport: true } },
		})
		await flushPromises()

		cartStore = usePOSCartStore(pinia)
		offlineStore = usePOSSyncStore(pinia)
		uiStore = usePOSUIStore(pinia)
		settingsStore = usePOSSettingsStore(pinia)

		cartStore.customer = { name: "CUST-1", customer_name: "Customer" }
		cartStore.clearCart = vi.fn()
		cartStore.submitInvoice = vi.fn(async () => ({ name: "SINV-1", grand_total: 10 }))
		cartStore.buildCheckoutPayload = () => ({
			invoiceData: { items: [{ item_code: "A", qty: 1 }], payments: PAYMENT.payments },
			redeemedCustomerCredit: 0,
			customerCreditDict: [],
		})
		offlineStore.saveInvoiceOffline = vi.fn(async () => ({ offline_id: "pos_offline_new" }))
		uiStore.showPaymentDialog = true
	})

	afterEach(() => {
		wrapper.unmount()
	})

	describe("offline, past the limit", () => {
		beforeEach(() => {
			offlineStore.isOffline = true
			limit.passed = true
		})

		it("refuses the sale and says why", async () => {
			await checkout()

			expect(offlineStore.saveInvoiceOffline).not.toHaveBeenCalled()
			expect(uiStore.showErrorDialog).toBe(true)
			expect(uiStore.errorDialogTitle).toBe(REFUSAL)
			expect(uiStore.showPaymentDialog).toBe(false)
		})

		it("keeps the cart", async () => {
			await checkout()

			expect(cartStore.clearCart).not.toHaveBeenCalled()
		})

		it("keeps the edit of a queued sale, so finishing it later cannot sell it twice", async () => {
			await editQueuedSale()

			await checkout()
			limit.passed = false
			await checkout()

			expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
			expect(offlineStore.saveInvoiceOffline.mock.calls[0][1]).toEqual({ supersedesId: 7 })
		})
	})

	it("queues the sale offline within the limit", async () => {
		offlineStore.isOffline = true

		await checkout()

		expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
		expect(cartStore.clearCart).toHaveBeenCalled()
		expect(uiStore.showErrorDialog).toBe(false)
	})

	describe("online, past the limit", () => {
		beforeEach(() => {
			offlineStore.isOffline = false
			limit.passed = true
		})

		it("sends a Realtime sale straight to the server", async () => {
			settingsStore.settings.sync_mode = SYNC_REALTIME

			await checkout()

			expect(cartStore.submitInvoice).toHaveBeenCalledTimes(1)
			expect(uiStore.showErrorDialog).toBe(false)
		})

		it.each([SYNC_AFTER_PAYMENT, SYNC_PERIODIC])("lets %s use the queue", async (mode) => {
			settingsStore.settings.sync_mode = mode

			await checkout()

			expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
			expect(uiStore.showErrorDialog).toBe(false)
		})

		it("refuses a sale whose connection dropped, and keeps the cart", async () => {
			settingsStore.settings.sync_mode = SYNC_REALTIME
			cartStore.submitInvoice = vi.fn(async () => {
				throw NETWORK_FAILURE
			})

			await checkout()

			expect(offlineStore.saveInvoiceOffline).not.toHaveBeenCalled()
			expect(cartStore.clearCart).not.toHaveBeenCalled()
			expect(uiStore.errorDialogTitle).toBe(REFUSAL)
		})

		it("keeps the edit when the connection drops", async () => {
			settingsStore.settings.sync_mode = SYNC_REALTIME
			await editQueuedSale()
			cartStore.submitInvoice = vi.fn(async () => {
				throw NETWORK_FAILURE
			})

			await checkout()
			limit.passed = false
			await checkout()

			expect(offlineStore.saveInvoiceOffline.mock.calls[0][1]).toEqual({ supersedesId: 7 })
		})
	})

	it("reopens the payment dialog from Try Again", async () => {
		uiStore.showPaymentDialog = false
		uiStore.showError("Error", "It failed", "", "payment")

		await wrapper.vm.handleErrorRetry()
		await new Promise((resolve) => setTimeout(resolve, 320))

		expect(uiStore.showPaymentDialog).toBe(true)
		expect(uiStore.errorRetryAction).toBeNull()
	})

	it("queues a sale whose connection dropped within the limit", async () => {
		offlineStore.isOffline = false
		settingsStore.settings.sync_mode = SYNC_REALTIME
		cartStore.submitInvoice = vi.fn(async () => {
			throw NETWORK_FAILURE
		})

		await checkout()

		expect(offlineStore.saveInvoiceOffline).toHaveBeenCalledTimes(1)
	})
})
