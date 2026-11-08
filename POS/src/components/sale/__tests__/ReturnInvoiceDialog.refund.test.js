/**
 * What the return dialog sends: a refund the server's total agrees with, and the
 * warehouse the goods go back into.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"

const { store, settings } = vi.hoisted(() => {
	globalThis.__ = (text) => text

	return {
		store: {
			getOfflineReturnDocuments: vi.fn(async () => []),
			saveInvoiceOffline: vi.fn(),
			saveReturnOffline: vi.fn(async () => ({ offline_id: "pos_offline_r1" })),
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
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ profileWarehouse: "Branch - RT" }) }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: { getCachedPaymentMethods: async () => [] },
}))

import ReturnInvoiceDialog from "../ReturnInvoiceDialog.vue"

async function openReturn({ soldAt = "Branch", row = {}, original } = {}) {
	const wrapper = shallowMount(ReturnInvoiceDialog, {
		props: { modelValue: false, posProfile: "Branch", posOpeningShift: "POS-OPE-1" },
		global: { mocks: { __: (text) => text } },
	})
	const { vm } = wrapper
	vm.originalInvoice = { name: "SINV-1", customer: "CUST-1" }
	vm.preparedReturnDoc = {
		doctype: "Sales Invoice",
		return_against: "SINV-1",
		customer: "CUST-1",
		pos_profile: soldAt,
		...(original ? { _original_invoice: original } : {}),
	}
	// 2 x 100 with 20 off the invoice and 15% VAT on top: the sale came to 210
	vm.returnItems = [
		{
			item_code: "A",
			quantity: 2,
			return_qty: 2,
			selected: true,
			rate: 91.3,
			rate_with_tax: 105,
			tax_fraction: 0.15,
			tax_included_in_rate: false,
			warehouse: "Stores - RT",
			...row,
		},
	]
	vm.isOriginalCreditSale = true
	vm.returnModal.visible = true
	await flushPromises()
	return wrapper
}

describe("what the return dialog sends", () => {
	beforeEach(() => vi.clearAllMocks())

	it("totals a taxed return the way the server does, so a queued return is not held for review", async () => {
		const wrapper = await openReturn()
		await wrapper.vm.handleCreateReturn()

		// ERPNext: 2 x 91.30 = 182.60, VAT rounded once = 27.39, total 209.99.
		// Adding 105.00 a unit came to 210.00, a cent over what ERPNext allows back.
		const [payload] = store.saveReturnOffline.mock.calls[0]
		expect(payload.grand_total).toBe(-209.99)
	})

	it("gives back exactly what the sale took when the row carries its refund_value", async () => {
		const wrapper = await openReturn({
			row: { refund_value: 210, original_qty: 2, already_returned: 0 },
			original: { return_balance: 0, refund_precision: 2 },
		})
		await wrapper.vm.handleCreateReturn()

		// The server prices the rows at 100 and takes 20 off the return: 210 back, not 209.99
		const [payload] = store.saveReturnOffline.mock.calls[0]
		expect(payload.grand_total).toBe(-210)
	})

	it("settles what an earlier return of the invoice left over", async () => {
		const wrapper = await openReturn({
			row: { refund_value: 223, original_qty: 3, already_returned: 1, quantity: 2, return_qty: 2 },
			original: { return_balance: 0.01, refund_precision: 2 },
		})
		await wrapper.vm.handleCreateReturn()

		// 148.67 for the last two of 223 over 3, and the cent an older return kept back
		const [payload] = store.saveReturnOffline.mock.calls[0]
		expect(payload.grand_total).toBe(-148.68)
	})

	it("puts the goods of a return taken at another branch into that branch's warehouse", async () => {
		const wrapper = await openReturn({ soldAt: "Head Office" })
		await wrapper.vm.handleCreateReturn()

		const [payload] = store.saveReturnOffline.mock.calls[0]
		expect(payload.items[0].warehouse).toBe("Branch - RT")
	})

	it("keeps the sale's warehouse for a return at the branch that sold it", async () => {
		const wrapper = await openReturn({ soldAt: "Branch" })
		await wrapper.vm.handleCreateReturn()

		const [payload] = store.saveReturnOffline.mock.calls[0]
		expect(payload.items[0].warehouse).toBe("Stores - RT")
	})
})
