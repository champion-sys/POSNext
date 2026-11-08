/**
 * What the return dialog does with the offline limit. The rule itself is tested on the store.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"

const { store, settings } = vi.hoisted(() => {
	// Some of what this dialog imports translates as it loads
	globalThis.__ = (text) => text

	return {
		store: {
			getOfflineReturnDocuments: vi.fn(async () => []),
			saveInvoiceOffline: vi.fn(),
			saveReturnOffline: vi.fn(),
		},
		settings: { allowReturn: true, allowOfflineReturns: true },
	}
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: { template: "<div><slot /></div>" },
	FeatherIcon: { template: "<i />" },
	createResource: () => ({ reload: vi.fn(), submit: vi.fn(), reset: vi.fn() }),
}))
vi.mock("@/composables/useOfflineStatus", () => ({
	useOfflineStatus: () => ({ isOffline: ref(true), mustQueue: computed(() => true) }),
}))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/data/session", () => ({ session: { user: "a@example.com" } }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => settings }))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => store }))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ profileWarehouse: "Main" }) }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: { getCachedPaymentMethods: async () => [] },
}))

import ReturnInvoiceDialog from "../ReturnInvoiceDialog.vue"

describe("the return dialog past the offline limit", () => {
	let wrapper

	beforeEach(async () => {
		vi.clearAllMocks()
		store.saveReturnOffline.mockRejectedValue(
			Object.assign(new Error("this return was not saved"), { title: "Offline limit reached" }),
		)

		wrapper = shallowMount(ReturnInvoiceDialog, {
			props: { modelValue: false, posProfile: "Main", posOpeningShift: "POS-OPE-1" },
			global: { mocks: { __: (text) => text } },
		})
		const { vm } = wrapper
		vm.originalInvoice = { name: "SINV-1", customer: "CUST-1" }
		vm.preparedReturnDoc = { doctype: "Sales Invoice", return_against: "SINV-1", customer: "CUST-1" }
		vm.returnItems = [
			{ item_code: "A", quantity: 1, return_qty: 1, selected: true, rate: 10, warehouse: "W1" },
		]
		vm.isOriginalCreditSale = true
		vm.returnModal.visible = true
		await flushPromises()
	})

	it("asks the store for a return, not for any invoice", async () => {
		await wrapper.vm.handleCreateReturn()

		expect(store.saveReturnOffline).toHaveBeenCalledTimes(1)
		expect(store.saveInvoiceOffline).not.toHaveBeenCalled()
	})

	it("shows the refusal under its own title", async () => {
		await wrapper.vm.handleCreateReturn()
		await flushPromises()

		expect(wrapper.vm.errorDialog).toMatchObject({
			visible: true,
			title: "Offline limit reached",
			message: "this return was not saved",
		})
	})

	it("keeps the return open, so nothing has to be entered again", async () => {
		await wrapper.vm.handleCreateReturn()
		await flushPromises()

		expect(wrapper.vm.returnModal.visible).toBe(true)
		expect(wrapper.vm.returnItems).toHaveLength(1)
	})
})
