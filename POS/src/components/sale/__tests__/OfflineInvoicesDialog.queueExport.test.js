import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: { template: "<div><slot name='body-content' /><slot name='actions' /></div>" },
}))
vi.mock("@/components/settings/QueueExport.vue", () => ({
	default: { template: "<div data-testid='queue-export' />" },
}))
vi.mock("@/components/sale/SyncStateBadge.vue", () => ({ default: { template: "<span />" } }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ allowDeleteOfflineInvoice: false }),
}))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => ({ lastSyncedAt: null }) }))
vi.mock("@/stores/posUI", () => ({ usePOSUIStore: () => ({}) }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn() }) }))

globalThis.__ = (text) => text

const { default: OfflineInvoicesDialog } = await import("../OfflineInvoicesDialog.vue")

const ROW = { id: 1, offline_id: "pos_offline_1", timestamp: 1, data: { customer: "A", items: [], payments: [] } }

function mountIt(props) {
	return mount(OfflineInvoicesDialog, {
		props: { modelValue: true, ...props },
		global: { mocks: { __: globalThis.__ } },
	})
}

const offersExport = (wrapper) => wrapper.find('[data-testid="queue-export"]').exists()

describe("exporting from the queue", () => {
	it("is there for a cashier who cannot reach the server", () => {
		expect(offersExport(mountIt({ isOffline: true, pendingInvoices: [ROW] }))).toBe(true)
	})

	it("stays out of the way while the queue can sync", () => {
		expect(offersExport(mountIt({ isOffline: false, pendingInvoices: [ROW] }))).toBe(false)
	})

	it("is not offered with nothing to export", () => {
		expect(offersExport(mountIt({ isOffline: true, pendingInvoices: [] }))).toBe(false)
	})
})
