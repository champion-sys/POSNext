/**
 * Returns get a local number of their own, and the return search finds an invoice by its
 * local number as well as by its server name.
 */
import { flushPromises, shallowMount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import { buildReturnDocFromQueue } from "@/utils/offline/entities"
import { formatLocalPosting } from "@/utils/offline/invoicePayload"

const { store, settings, allocate } = vi.hoisted(() => {
	globalThis.__ = (text) => text
	let counter = 0
	return {
		store: {
			getOfflineReturnDocuments: vi.fn(async () => []),
			saveReturnOffline: vi.fn(async (data) => ({ offline_id: data.offline_id || "pos_offline_ret" })),
		},
		settings: { allowReturn: true, allowOfflineReturns: true, settings: {} },
		allocate: vi.fn(async (invoice) => {
			counter += 1
			return invoice.is_return ? `LACC-SINV-RET-2026-3-${String(counter).padStart(5, "0")}` : null
		}),
	}
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: { template: "<div><slot /></div>" },
	FeatherIcon: { template: "<i />" },
	createResource: () => ({ reload: vi.fn(), submit: vi.fn(), reset: vi.fn(), fetch: vi.fn() }),
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
vi.mock("@/utils/offline/localNumbering", () => ({ allocateLocalNumber: allocate }))

import ReturnInvoiceDialog from "../ReturnInvoiceDialog.vue"

const mountDialog = () =>
	shallowMount(ReturnInvoiceDialog, {
		props: { modelValue: false, posProfile: "Main", posOpeningShift: "POSA-OS-26-0000003" },
		global: { mocks: { __: (text) => text } },
	})

describe("a return's local number", () => {
	let wrapper

	beforeEach(async () => {
		vi.clearAllMocks()
		wrapper = mountDialog()
		const { vm } = wrapper
		vm.originalInvoice = { name: "SINV-1", customer: "CUST-1" }
		vm.preparedReturnDoc = { doctype: "Sales Invoice", return_against: "SINV-1", customer: "CUST-1" }
		vm.returnItems = [{ item_code: "A", quantity: 1, return_qty: 1, selected: true, rate: 10, warehouse: "W1" }]
		vm.isOriginalCreditSale = true
		vm.returnModal.visible = true
		await flushPromises()
	})

	it("is asked for as a return of this shift and goes with the queued return", async () => {
		await wrapper.vm.handleCreateReturn()

		expect(allocate).toHaveBeenCalledWith(
			expect.objectContaining({ is_return: 1, posa_pos_opening_shift: "POSA-OS-26-0000003", pos_profile: "Main" }),
		)
		const saved = store.saveReturnOffline.mock.calls[0][0]
		expect(saved.posa_local_number).toMatch(/^LACC-SINV-RET-2026-3-\d{5}$/)
	})

	it("stays the same when a refused return is tried again", async () => {
		store.saveReturnOffline.mockRejectedValueOnce(new Error("not saved"))
		await wrapper.vm.handleCreateReturn()
		await flushPromises()
		await wrapper.vm.handleCreateReturn()

		expect(allocate).toHaveBeenCalledTimes(1)
		const [first, second] = store.saveReturnOffline.mock.calls.map(([data]) => data.posa_local_number)
		expect(second).toBe(first)
	})
})

describe("the return search", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("finds an invoice by its local number and by its server name", async () => {
		const wrapper = mountDialog()
		wrapper.vm.invoiceList = [
			{ name: "ACC-SINV-2026-00042", posa_local_number: "LACC-SINV-2026-3-00001", customer_name: "A" },
			{ name: "ACC-SINV-2026-00043", posa_local_number: "LACC-SINV-2026-3-00002", customer_name: "B" },
		]

		wrapper.vm.invoiceListFilter = "LACC-SINV-2026-3-00002"
		await flushPromises()
		expect(wrapper.vm.filteredInvoiceList.map((invoice) => invoice.name)).toEqual(["ACC-SINV-2026-00043"])

		wrapper.vm.invoiceListFilter = "SINV-2026-00042"
		await flushPromises()
		expect(wrapper.vm.filteredInvoiceList.map((invoice) => invoice.name)).toEqual(["ACC-SINV-2026-00042"])
	})

	it("opens a queued sale typed by its local number, offline", async () => {
		const today = formatLocalPosting().posting_date
		const row = {
			offline_id: "pos_offline_sale-1",
			entity: "invoice",
			data: {
				customer: "CUST-1",
				posting_date: today,
				grand_total: 10,
				posa_local_number: "LACC-SINV-2026-3-00007",
				items: [{ item_code: "A", qty: 1, rate: 10 }],
				payments: [{ mode_of_payment: "Cash", amount: 10 }],
			},
		}
		store.getOfflineReturnDocuments.mockResolvedValue([
			buildReturnDocFromQueue(row, { allow_return: 1, return_validity_days: 0 }),
		])
		const wrapper = mountDialog()
		await wrapper.vm.loadInvoices()

		expect(wrapper.vm.invoiceList[0]).toMatchObject({
			name: "pos_offline_sale-1",
			posa_local_number: "LACC-SINV-2026-3-00007",
		})

		wrapper.vm.invoiceListFilter = "LACC-SINV-2026-3-00007"
		await flushPromises()
		await wrapper.vm.searchInvoiceDirectly()
		await flushPromises()

		expect(wrapper.vm.originalInvoice).toMatchObject({
			name: "pos_offline_sale-1",
			posa_local_number: "LACC-SINV-2026-3-00007",
		})
	})
})
