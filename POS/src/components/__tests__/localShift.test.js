/**
 * The screens that send a shift's work to the server, with a connection but with a shift
 * the server does not know yet. frappe-ui is faked because it does not load under vitest.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hasLocalShift, shiftState } from "@/composables/useShift"
import InvoiceManagement from "../invoices/InvoiceManagement.vue"
import PartialPayments from "../partials/PartialPayments.vue"
import OfflineInvoicesDialog from "../sale/OfflineInvoicesDialog.vue"
import ReturnInvoiceDialog from "../sale/ReturnInvoiceDialog.vue"
import ShiftClosingDialog from "../ShiftClosingDialog.vue"

const { workerProxy } = vi.hoisted(() => {
	globalThis.__ = (text) => text

	return {
		workerProxy: new Proxy(
			{},
			{
				get: (_target, name) => {
					if (name === "then") return undefined
					if (["getOfflineInvoices", "getQueueRows", "getCachedPaymentMethods"].includes(name)) return async () => []
					if (name === "getOfflineInvoiceCount") return async () => 0
					return async () => ({ success: true })
				},
			},
		),
	}
})

vi.mock("frappe-ui", async () => {
	const { reactive } = await import("vue")
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

vi.mock("@/utils/offline/offlineState", () => {
	const offlineState = {
		isOffline: false,
		getConnectionQuality: () => "good",
		setManualOffline: () => {},
		subscribe: () => () => {},
	}
	return { offlineState, isOffline: () => false, getConnectionQuality: () => "good" }
})
vi.mock("@/data/session", () => ({ session: { user: "a@example.com", isLoggedIn: true } }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn(async () => []) }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: workerProxy }))
vi.mock("@/platform/store", () => ({ localStore: workerProxy }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: vi.fn() }))

const LOCAL_SHIFT = "pos_offline_shift-1"

const openShift = (name) => {
	shiftState.value = {
		pos_opening_shift: { name, pos_profile: "Main", user: "a@example.com" },
		pos_profile: { name: "Main" },
		company: { name: "Acme" },
		isOpen: true,
	}
}

const SCREENS = [
	["ShiftClosingDialog", ShiftClosingDialog, { modelValue: false, openingShift: LOCAL_SHIFT }],
	["PartialPayments", PartialPayments, { modelValue: false, posProfile: "Main", currency: "SAR" }],
	["ReturnInvoiceDialog", ReturnInvoiceDialog, { modelValue: false, posProfile: "Main", currency: "SAR" }],
	["InvoiceManagement", InvoiceManagement, { modelValue: false, posProfile: "Main", currency: "SAR" }],
]

describe("the record of a shift opened offline, in the queue list", () => {
	const row = { id: 1, offline_id: LOCAL_SHIFT, entity: "shift_open", data: { pos_profile: "Main" } }
	let wrapper

	beforeEach(() => {
		const pinia = createPinia()
		setActivePinia(pinia)
		wrapper = shallowMount(OfflineInvoicesDialog, {
			props: { modelValue: false, isOffline: true, currency: "SAR" },
			global: { plugins: [pinia], mocks: { __: (text) => text }, stubs: { teleport: true } },
		})
	})

	afterEach(() => {
		wrapper.unmount()
	})

	it("says what it is", () => {
		expect(wrapper.vm.getRowKind(row)).toBe("Shift Opening")
		expect(wrapper.vm.getRowTitle(row)).toBe("Main")
	})

	it("cannot be removed, because a shift's sales rest on it", () => {
		expect(wrapper.vm.isShiftRecord(row)).toBe(true)
		expect(wrapper.vm.isShiftRecord({ entity: "shift_close" })).toBe(true)
		expect(wrapper.vm.isShiftRecord({ entity: "invoice" })).toBe(false)
	})
})

describe.each(SCREENS)("%s", (_name, screen, props) => {
	let wrapper

	beforeEach(async () => {
		const pinia = createPinia()
		setActivePinia(pinia)
		openShift(LOCAL_SHIFT)
		wrapper = shallowMount(screen, {
			props,
			global: { plugins: [pinia], mocks: { __: (text) => text }, stubs: { teleport: true } },
		})
		await flushPromises()
	})

	afterEach(() => {
		wrapper.unmount()
		shiftState.value = { pos_opening_shift: null, pos_profile: null, company: null, isOpen: false }
	})

	it("goes through the queue while the server does not know the shift", () => {
		expect(hasLocalShift.value).toBe(true)
		expect(wrapper.vm.isOffline).toBe(true)
	})

	it("goes to the server once the shift has its real name", async () => {
		openShift("POSA-OS-1")
		await flushPromises()

		expect(wrapper.vm.isOffline).toBe(false)
	})
})
