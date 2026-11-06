/**
 * Editing a queued sale on the real page, with the real cart and invoice composable. The
 * timing is the point: a real submit empties the cart before the page gets its answer.
 */
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"

const page = vi.hoisted(() => {
	vi.stubGlobal("__", (message) => message)

	return {
		component: (name) => ({
			default: { name, template: "<div />", inheritAttrs: false },
		}),
		stores: {},
		queue: [],
		toast: {},
		serverAnswer: null,
	}
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button />" },
	Dialog: { template: "<div />" },
	FeatherIcon: { template: "<i />" },
	FrappeUI: {},
	call: vi.fn().mockResolvedValue({}),
	createResource: (options) => ({
		...options,
		data: null,
		error: null,
		loading: false,
		reload: async () => ({}),
		fetch: async () => ({}),
		submit: (params) => page.serverAnswer(options.url, params),
	}),
}))

vi.mock("@/components/ShiftClosingDialog.vue", () =>
	page.component("ShiftClosingDialog"),
)
vi.mock("@/components/ShiftOpeningDialog.vue", () =>
	page.component("ShiftOpeningDialog"),
)
vi.mock("@/components/common/ClearCacheOverlay.vue", () =>
	page.component("ClearCacheOverlay"),
)
vi.mock("@/components/common/SessionLockScreen.vue", () =>
	page.component("SessionLockScreen"),
)
vi.mock("@/components/common/LoadingSpinner.vue", () =>
	page.component("LoadingSpinner"),
)
vi.mock("@/components/common/POSFooter.vue", () => page.component("POSFooter"))
vi.mock("@/components/pos/ManagementSlider.vue", () =>
	page.component("ManagementSlider"),
)
vi.mock("@/components/pos/POSHeader.vue", () => page.component("POSHeader"))
vi.mock("@/components/pos/ChangePasswordDialog.vue", () =>
	page.component("ChangePasswordDialog"),
)
vi.mock("@/components/sale/BatchSerialDialog.vue", () =>
	page.component("BatchSerialDialog"),
)
vi.mock("@/components/sale/CouponDialog.vue", () =>
	page.component("CouponDialog"),
)
vi.mock("@/components/sale/CreateCustomerDialog.vue", () =>
	page.component("CreateCustomerDialog"),
)
vi.mock("@/components/sale/CustomerDialog.vue", () =>
	page.component("CustomerDialog"),
)
vi.mock("@/components/sale/DraftInvoicesDialog.vue", () =>
	page.component("DraftInvoicesDialog"),
)
vi.mock("@/components/sale/InvoiceCart.vue", () =>
	page.component("InvoiceCart"),
)
vi.mock("@/components/sale/InvoiceHistoryDialog.vue", () =>
	page.component("InvoiceHistoryDialog"),
)
vi.mock("@/components/sale/ItemSelectionDialog.vue", () =>
	page.component("ItemSelectionDialog"),
)
vi.mock("@/components/sale/ItemsSelector.vue", () =>
	page.component("ItemsSelector"),
)
vi.mock("@/components/sale/OffersDialog.vue", () =>
	page.component("OffersDialog"),
)
vi.mock("@/components/sale/OfflineInvoicesDialog.vue", () =>
	page.component("OfflineInvoicesDialog"),
)
vi.mock("@/components/sale/PaymentDialog.vue", () =>
	page.component("PaymentDialog"),
)
vi.mock("@/components/sale/PromotionManagement.vue", () =>
	page.component("PromotionManagement"),
)
vi.mock("@/components/sale/ReturnInvoiceDialog.vue", () =>
	page.component("ReturnInvoiceDialog"),
)
vi.mock("@/components/sale/WarehouseAvailabilityDialog.vue", () =>
	page.component("WarehouseAvailabilityDialog"),
)
vi.mock("@/components/settings/POSSettings.vue", () =>
	page.component("POSSettings"),
)
vi.mock("@/components/invoices/InvoiceManagement.vue", () =>
	page.component("InvoiceManagement"),
)
vi.mock("@/components/invoices/InvoiceDetailDialog.vue", () =>
	page.component("InvoiceDetailDialog"),
)

vi.mock("@/platform/store", () => ({ localStore: {} }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: new Proxy(
		{ supersedeOfflineInvoice: vi.fn() },
		{
			get(target, key) {
				target[key] ??= vi.fn().mockResolvedValue(undefined)
				return target[key]
			},
		},
	),
}))
vi.mock("@/utils/offline/items", () => ({
	deductCachedBatchQty: vi.fn().mockResolvedValue(undefined),
	consumeCachedSerials: vi.fn().mockResolvedValue(undefined),
	returnCachedSerials: vi.fn().mockResolvedValue(undefined),
	persistItemBatchSerialData: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/utils/offline/offlineReceiptCache", () => ({
	cacheOfflineReceiptPayload: vi.fn(),
	removeOfflineReceiptPayload: vi.fn(),
}))
vi.mock("@/utils/offline", () => ({
	isOffline: () => false,
	getCachedItem: vi.fn(),
	getSetting: vi.fn(),
	setSetting: vi.fn(),
}))
vi.mock("@/utils/printInvoice", () => ({
	hydrateLocalOnlyInvoice: vi.fn(),
	printInvoice: vi.fn(),
	printInvoiceByName: vi.fn(),
	printWithSilentFallback: vi.fn(),
}))
vi.mock("@/utils/qzTray", () => ({
	qzConnected: { value: false },
	connect: vi.fn(),
	disconnect: vi.fn(),
}))
vi.mock("@/utils/escpos", () => ({
	prefetchPrintFormat: vi.fn(),
	printInvoiceToBluetooth: vi.fn(),
	printInvoiceFormatToBluetooth: vi.fn(),
	printInvoiceToAllPrinters: vi.fn(),
}))
vi.mock("@/services/printerService", () => ({
	printerService: { registerOnDisconnect: vi.fn() },
}))
vi.mock("@/platform/printing/routes", () => ({
	NONE: "none",
	SILENT: "silent",
	THERMAL: "thermal",
	canUseBrowserPrint: () => false,
	getPrintRoute: () => "none",
}))
vi.mock("@/platform/printing/transport", () => ({
	usesNativeLink: () => false,
}))
vi.mock("@/platform/runtime", () => ({
	PLATFORM: "web",
	isNative: false,
	WEB: "web",
	ELECTRON: "electron",
}))
vi.mock("@/utils/sessionCleanup", () => ({ cleanupUserSession: vi.fn() }))
vi.mock("@/composables/useRealtimeStock", () => ({
	useRealtimeStock: () => ({ onStockUpdate: () => () => {} }),
}))
vi.mock("@/composables/useSessionLock", () => ({
	useSessionLock: () => ({
		lock: vi.fn(),
		configure: vi.fn(),
		startActivityTracking: vi.fn(),
		stopActivityTracking: vi.fn(),
	}),
}))
vi.mock("@/composables/usePOSEvents", () => ({
	usePOSEvents: () => ({
		onWarehouseChanged: vi.fn(),
		onPricingChanged: vi.fn(),
		onStockPolicyChanged: vi.fn(),
		onSettingsChanged: vi.fn(),
		onSalesOperationsChanged: vi.fn(),
	}),
}))
vi.mock("@/composables/useLocale", () => ({
	useLocale: () => ({ isRTL: { value: false } }),
}))
vi.mock("@/composables/useShift", () => ({ shiftState: { value: {} } }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showSuccess: page.toast.success,
		showError: page.toast.error,
		showWarning: page.toast.warning,
	}),
}))
vi.mock("@/data/session", () => ({
	session: { user: "cashier@example.com", isLoggedIn: true },
}))
vi.mock("@/data/user", () => ({
	useUserData: () => ({
		userName: { value: "Cashier" },
		userImage: { value: null },
	}),
}))

vi.mock("@/stores/posShift", () => ({
	usePOSShiftStore: () => page.stores.shift,
}))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => page.stores.settings,
}))
vi.mock("@/stores/posOffers", () => ({
	usePOSOffersStore: () => page.stores.offers,
}))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => page.stores.sync }))
vi.mock("@/stores/posDrafts", () => ({
	usePOSDraftsStore: () => page.stores.drafts,
}))
vi.mock("@/stores/posUI", () => ({ usePOSUIStore: () => page.stores.ui }))
vi.mock("@/stores/itemSearch", () => ({
	useItemSearchStore: () => page.stores.items,
}))
vi.mock("@/stores/stock", () => ({ useStockStore: () => page.stores.stock }))
vi.mock("@/stores/customerSearch", () => ({
	useCustomerSearchStore: () => page.stores.customers,
}))
vi.mock("@/stores/bootstrap", () => ({
	useBootstrapStore: () => page.stores.bootstrap,
}))
vi.mock("@/stores/bluetoothPrinter", () => ({
	useBluetoothPrinterStore: () => page.stores.bluetooth,
}))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => page.stores.serials,
}))

import { usePOSCartStore } from "@/stores/posCart"
import { holdFromSync, releaseFromSync } from "@/utils/offline/sync"
import { offlineWorker } from "@/utils/offline/workerClient"
import POSSale from "../POSSale.vue"

/** Anything the page reads and these tests do not care about answers with a no-op */
function storeWith(state = {}) {
	return new Proxy(reactive(state), {
		get(target, key) {
			if (typeof key === "symbol" || key in target) return target[key]
			target[key] = vi.fn()
			return target[key]
		},
	})
}

const QUEUED = { id: 7, offline_id: "pos_offline_original", timestamp: 1 }

const queuedRow = (extra = {}) => ({
	...QUEUED,
	data: {
		customer: "CUST-1",
		items: [
			{
				item_code: "COFFEE",
				item_name: "Coffee",
				qty: 2,
				rate: 10,
				uom: "Nos",
				warehouse: "W1",
			},
		],
	},
	...extra,
})

const item = (code = "TEA", extra = {}) => ({
	item_code: code,
	item_name: code,
	rate: 5,
	uom: "Nos",
	...extra,
})

const payment = {
	payments: [{ mode_of_payment: "Cash", amount: 20, type: "Cash" }],
	paid_amount: 20,
}

/** Whether something holds the row, without disturbing it */
function isHeld(offlineId) {
	if (holdFromSync(offlineId)) {
		releaseFromSync(offlineId)
		return false
	}
	return true
}

describe("editing a queued sale on the sale screen", () => {
	let wrapper
	let openPage
	let cart
	let sync

	const editQueuedSale = (row = queuedRow()) =>
		wrapper.vm.handleEditOfflineInvoice(row)

	beforeEach(async () => {
		// Named, because any store action from an earlier test's timers resets the active one
		const pinia = createPinia()
		setActivePinia(pinia)
		releaseFromSync(QUEUED.offline_id)
		releaseFromSync("pos_offline_other")
		vi.clearAllMocks()

		page.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
		page.serverAnswer = async () => ({})
		sync = storeWith({
			isOffline: true,
			isSyncing: false,
			pendingInvoicesList: [],
			saveInvoiceOffline: vi.fn().mockResolvedValue({ success: true }),
			loadPendingInvoices: vi.fn().mockResolvedValue(undefined),
			updatePendingCount: vi.fn().mockResolvedValue(undefined),
		})
		sync.loadPendingInvoices.mockImplementation(async () => {
			sync.pendingInvoicesList = page.queue
		})
		page.queue = [queuedRow()]
		page.stores = {
			sync,
			shift: storeWith({
				currentProfile: null,
				hasOpenShift: false,
				profileCompany: "Company",
				profileCustomer: "Walk-In",
				profileName: "Main",
				profileWarehouse: "W1",
				isLoading: false,
				currentShift: null,
			}),
			settings: storeWith({
				invoiceType: "Sales Invoice",
				syncMode: "Realtime",
				shouldEnforceStockValidation: () => false,
				realtimeTimeoutSeconds: 5,
				disableOfflineMode: false,
				silentPrint: false,
				autoPrintEnabled: false,
				allowDeleteOfflineInvoice: true,
				settings: {},
			}),
			offers: storeWith({
				hasFetched: false,
				autoEligibleOffers: [],
				allEligibleOffers: [],
			}),
			drafts: storeWith({
				saveDraftInvoice: vi.fn().mockResolvedValue({ draft_id: "D1" }),
				loadDraft: vi
					.fn()
					.mockResolvedValue({ items: [item()], customer: "CUST-9" }),
			}),
			ui: storeWith({
				showPaymentDialog: false,
				showDraftDialog: false,
				showClearCartDialog: false,
				showOfflineInvoicesDialog: false,
				errorRetryAction: null,
				pendingAction: null,
			}),
			items: storeWith({ allItems: [] }),
			stock: storeWith({
				refresh: vi.fn().mockResolvedValue(undefined),
				queued: new Map(),
			}),
			customers: storeWith({}),
			bootstrap: storeWith({ data: null, getPreloadedRoles: () => [] }),
			bluetooth: storeWith({ isEnabled: false, isConnected: false }),
			serials: storeWith({
				returnSerials: vi.fn(),
				consumeSerials: vi.fn(),
				clearCache: vi.fn(),
			}),
		}

		openPage = () =>
			mount(POSSale, {
				global: { plugins: [pinia], mocks: { __: (message) => message } },
			})
		wrapper = openPage()
		await flushPromises()
		cart = usePOSCartStore(pinia)
	})

	afterEach(async () => {
		wrapper.unmount()
		await flushPromises()
	})

	describe("while the edit runs", () => {
		it("loads the sale from the row as it stands now, and holds it from sync", async () => {
			page.queue = [
				queuedRow({
					data: {
						customer: "CUST-2",
						items: [{ item_code: "CAKE", qty: 1, rate: 3, uom: "Nos" }],
					},
				}),
			]

			await editQueuedSale()

			expect(cart.invoiceItems.map((row) => row.item_code)).toEqual(["CAKE"])
			expect(isHeld(QUEUED.offline_id)).toBe(true)
		})

		it("takes the hold before it waits for anything", async () => {
			const editing = editQueuedSale()

			expect(isHeld(QUEUED.offline_id)).toBe(true)

			await editing
		})

		it("survives its own clear and refill of a full cart", async () => {
			cart.addItem(item())
			await nextTick()

			await editQueuedSale()
			await nextTick()
			await flushPromises()

			expect(isHeld(QUEUED.offline_id)).toBe(true)
			await wrapper.vm.handleSaveDraft()
			expect(page.stores.drafts.saveDraftInvoice).not.toHaveBeenCalled()
		})

		it("refuses to save a draft of it", async () => {
			await editQueuedSale()

			await wrapper.vm.handleSaveDraft()

			expect(page.stores.drafts.saveDraftInvoice).not.toHaveBeenCalled()
			expect(page.toast.warning).toHaveBeenCalledTimes(1)
			expect(cart.invoiceItems).toHaveLength(1)
		})

		it("refuses to load a draft over it", async () => {
			await editQueuedSale()

			await wrapper.vm.handleLoadDraft({ draft_id: "D1" })

			expect(page.stores.drafts.saveDraftInvoice).not.toHaveBeenCalled()
			expect(page.stores.drafts.loadDraft).not.toHaveBeenCalled()
			expect(cart.invoiceItems.map((row) => row.item_code)).toEqual(["COFFEE"])
		})
	})

	describe("drafts of an ordinary sale", () => {
		it("still save", async () => {
			cart.addItem(item())

			await wrapper.vm.handleSaveDraft()

			expect(page.stores.drafts.saveDraftInvoice).toHaveBeenCalledTimes(1)
		})

		it("still load", async () => {
			await wrapper.vm.handleLoadDraft({ draft_id: "D1" })

			expect(page.stores.drafts.loadDraft).toHaveBeenCalledTimes(1)
		})
	})

	describe("refusing to start", () => {
		it("when the row reached the server after the list was read", async () => {
			page.queue = [queuedRow({ server_status: "received" })]
			cart.addItem(item())

			await editQueuedSale()

			expect(page.toast.warning).toHaveBeenCalledTimes(1)
			expect(cart.invoiceItems.map((row) => row.item_code)).toEqual(["TEA"])
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("when the row has left the queue", async () => {
			page.queue = []

			await editQueuedSale()

			expect(page.toast.warning).toHaveBeenCalledTimes(1)
			expect(cart.invoiceItems).toEqual([])
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("when something depends on the row, and lets go of it", async () => {
			page.queue = [
				queuedRow(),
				{
					id: 8,
					offline_id: "pos_offline_return",
					depends_on: [QUEUED.offline_id],
					data: { items: [] },
				},
			]

			await editQueuedSale()

			expect(cart.invoiceItems).toEqual([])
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("while a sync runs, without holding anything", async () => {
			sync.isSyncing = true

			await editQueuedSale()

			expect(sync.loadPendingInvoices).not.toHaveBeenCalled()
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("when reading the rows fails, and lets go of the row", async () => {
			sync.loadPendingInvoices.mockRejectedValue(new Error("Storage failed"))

			await editQueuedSale()

			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("a second time for the row already in the cart, and keeps the first edit", async () => {
			await editQueuedSale()

			await editQueuedSale()

			expect(page.toast.warning).toHaveBeenCalledTimes(1)
			expect(isHeld(QUEUED.offline_id)).toBe(true)
		})

		it("for another row, and keeps the edit in the cart", async () => {
			await editQueuedSale()
			page.queue = [queuedRow()]

			await editQueuedSale(
				queuedRow({ id: 8, offline_id: "pos_offline_other" }),
			)

			expect(isHeld(QUEUED.offline_id)).toBe(true)
			expect(isHeld("pos_offline_other")).toBe(false)
			expect(cart.invoiceItems.map((row) => row.item_code)).toEqual(["COFFEE"])
		})
	})

	describe("moving to another queued sale", () => {
		it("ends the first edit and starts the second", async () => {
			const other = queuedRow({ id: 8, offline_id: "pos_offline_other" })
			page.queue = [queuedRow(), other]

			await editQueuedSale()
			await editQueuedSale(other)
			await nextTick()

			expect(isHeld(QUEUED.offline_id)).toBe(false)
			expect(isHeld(other.offline_id)).toBe(true)

			await wrapper.vm.handlePaymentCompleted(payment)
			expect(sync.saveInvoiceOffline.mock.calls[0][1]).toEqual({
				supersedesId: 8,
			})
		})
	})

	describe("ending when the cart empties", () => {
		async function checkOutAnUnrelatedSale() {
			cart.addItem(item())
			await wrapper.vm.handlePaymentCompleted(payment)
			return sync.saveInvoiceOffline.mock.calls.at(-1)
		}

		it("after the cart is cleared, so the next sale replaces nothing", async () => {
			await editQueuedSale()

			wrapper.vm.confirmClearCart()
			await nextTick()

			expect(isHeld(QUEUED.offline_id)).toBe(false)
			const [invoice, options] = await checkOutAnUnrelatedSale()
			expect(options.supersedesId).toBeUndefined()
			expect(invoice.edited_from).toBeNull()
		})

		it("after the last item is removed", async () => {
			await editQueuedSale()

			cart.removeItem("COFFEE")
			await nextTick()

			expect(isHeld(QUEUED.offline_id)).toBe(false)
			const [, options] = await checkOutAnUnrelatedSale()
			expect(options.supersedesId).toBeUndefined()
		})

		it("not when the page remounts with the cart still full, as a change of language does", async () => {
			await editQueuedSale()

			wrapper.unmount()
			wrapper = openPage()
			await flushPromises()

			expect(isHeld(QUEUED.offline_id)).toBe(true)
			await wrapper.vm.handlePaymentCompleted(payment)
			expect(sync.saveInvoiceOffline.mock.calls[0][1]).toEqual({
				supersedesId: QUEUED.id,
			})
		})

		it("after the cart empties with no page mounted, as on sign-out", async () => {
			await editQueuedSale()

			wrapper.unmount()
			cart.clearCart()
			wrapper = openPage()
			await flushPromises()

			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("lets drafts work again", async () => {
			await editQueuedSale()
			wrapper.vm.confirmClearCart()
			await nextTick()
			cart.addItem(item())

			await wrapper.vm.handleSaveDraft()

			expect(page.stores.drafts.saveDraftInvoice).toHaveBeenCalledTimes(1)
		})
	})

	describe("queueing the edited sale", () => {
		it("retires the original in the same save, then ends the edit", async () => {
			await editQueuedSale()

			await wrapper.vm.handlePaymentCompleted(payment)

			const [invoice, options] = sync.saveInvoiceOffline.mock.calls[0]
			expect(options).toEqual({ supersedesId: QUEUED.id })
			expect(invoice.edited_from).toBe(QUEUED.offline_id)
			expect(isHeld(QUEUED.offline_id)).toBe(false)
			expect(cart.invoiceItems).toEqual([])
		})

		it("ends the edit as soon as the original is retired, whatever fails after that", async () => {
			await editQueuedSale()
			page.stores.ui.setLastOfflinePrintDoc = () => {
				throw new Error("Receipt failed")
			}

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(cart.invoiceItems).toHaveLength(1)
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("keeps the edit through a failed save, so Try Again still retires the original", async () => {
			await editQueuedSale()
			sync.saveInvoiceOffline.mockRejectedValueOnce(new Error("Storage failed"))

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(cart.invoiceItems).toHaveLength(1)
			expect(isHeld(QUEUED.offline_id)).toBe(true)

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(sync.saveInvoiceOffline.mock.calls[1][1]).toEqual({
				supersedesId: QUEUED.id,
			})
		})
	})

	describe("submitting the edited sale online", () => {
		beforeEach(() => {
			sync.isOffline = false
			page.serverAnswer = async (url) => ({
				name: url.includes("submit") ? "SINV-1" : "DRAFT-1",
			})
		})

		it("retires the original, though the submit empties the cart before it answers", async () => {
			await editQueuedSale()
			await nextTick()

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(offlineWorker.supersedeOfflineInvoice).toHaveBeenCalledWith(
				QUEUED.id,
				"SINV-1",
			)
		})

		it("keeps sync away from the original until it is retired", async () => {
			let heldWhileRetiring
			offlineWorker.supersedeOfflineInvoice.mockImplementation(async () => {
				heldWhileRetiring = isHeld(QUEUED.offline_id)
				return { success: true }
			})
			await editQueuedSale()

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(heldWhileRetiring).toBe(true)
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("keeps the edit through a refused sale, so Try Again still retires the original", async () => {
			await editQueuedSale()
			page.serverAnswer = async () => {
				throw Object.assign(new Error("Refused"), {
					exc_type: "ValidationError",
				})
			}

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(cart.invoiceItems).toHaveLength(1)
			expect(isHeld(QUEUED.offline_id)).toBe(true)
			expect(offlineWorker.supersedeOfflineInvoice).not.toHaveBeenCalled()

			page.serverAnswer = async (url) => ({
				name: url.includes("submit") ? "SINV-1" : "DRAFT-1",
			})
			await wrapper.vm.handlePaymentCompleted(payment)

			expect(offlineWorker.supersedeOfflineInvoice).toHaveBeenCalledWith(
				QUEUED.id,
				"SINV-1",
			)
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})

		it("queues under the online attempt's id when the connection drops, and retires the original", async () => {
			await editQueuedSale()
			page.serverAnswer = async () => {
				throw new TypeError("Failed to fetch")
			}

			await wrapper.vm.handlePaymentCompleted(payment)

			const [invoice, options] = sync.saveInvoiceOffline.mock.calls[0]
			expect(invoice.offline_id).toMatch(/^pos_offline_/)
			expect(options).toEqual({ supersedesId: QUEUED.id })
			expect(isHeld(QUEUED.offline_id)).toBe(false)
		})
	})

	describe("the id of a queued checkout", () => {
		it("is set before the save, so a save sent twice carries one id", async () => {
			cart.addItem(item())

			await wrapper.vm.handlePaymentCompleted(payment)

			const [invoice] = sync.saveInvoiceOffline.mock.calls[0]
			expect(invoice.offline_id).toMatch(/^pos_offline_/)
		})

		it("stays the same when the cashier retries a failed save", async () => {
			cart.addItem(item())
			sync.saveInvoiceOffline.mockRejectedValueOnce(new Error("Storage failed"))

			await wrapper.vm.handlePaymentCompleted(payment)
			await wrapper.vm.handlePaymentCompleted(payment)

			const [[first], [second]] = sync.saveInvoiceOffline.mock.calls
			expect(second.offline_id).toBe(first.offline_id)
		})

		it("changes for the next sale", async () => {
			cart.addItem(item())
			await wrapper.vm.handlePaymentCompleted(payment)

			cart.addItem(item())
			await wrapper.vm.handlePaymentCompleted(payment)

			const [[first], [second]] = sync.saveInvoiceOffline.mock.calls
			expect(second.offline_id).not.toBe(first.offline_id)
		})

		it("names the receipt", async () => {
			cart.addItem(item())

			await wrapper.vm.handlePaymentCompleted(payment)

			const [invoice] = sync.saveInvoiceOffline.mock.calls[0]
			expect(page.stores.ui.lastInvoiceName).toBe(invoice.offline_id)
		})
	})

	describe("serials in the cart", () => {
		const serialItem = item("PHONE", { has_serial_no: 1, serial_no: "S1" })

		it("stay taken when the sale goes through the queue", async () => {
			cart.addItem(serialItem)

			await wrapper.vm.handlePaymentCompleted(payment)

			expect(page.stores.serials.returnSerials).not.toHaveBeenCalled()
			expect(cart.invoiceItems).toEqual([])
		})

		it("come back when the cart is abandoned", () => {
			cart.addItem(serialItem)

			wrapper.vm.confirmClearCart()

			expect(page.stores.serials.returnSerials).toHaveBeenCalledWith(
				"PHONE",
				"S1",
			)
		})
	})
})
