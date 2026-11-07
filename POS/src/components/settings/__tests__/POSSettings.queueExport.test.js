import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

vi.mock("frappe-ui", () => ({
	Button: { template: "<button @click=\"$emit('click')\"><slot /></button>", emits: ["click"] },
	call: vi.fn().mockRejectedValue(new Error("Failed to fetch")),
	createResource: (options) => ({ reload: () => options.onError?.(new Error("Failed to fetch")) }),
}))
vi.mock("@/components/settings/QueueExport.vue", () => ({
	default: { template: "<div data-testid='queue-export' />" },
}))
vi.mock("@/components/settings/PrinterManagement.vue", () => ({ default: { template: "<div />" } }))
vi.mock("@/components/settings/SystemPrinterSettings.vue", () => ({ default: { template: "<div />" } }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn() }) }))
vi.mock("@/composables/usePOSEvents", () => ({
	usePOSEvents: () => ({
		detectSettingsChanges: vi.fn(),
		updateSettingsSnapshot: vi.fn(),
		emitStockSyncConfigured: vi.fn(),
	}),
}))
vi.mock("@/composables/useQzTray", async () => {
	const { ref } = await import("vue")
	return {
		useQzTray: () => ({
			qzConnected: ref(false),
			qzConnecting: ref(false),
			qzCertStatus: ref(null),
			printers: ref([]),
			selectedPrinter: ref(""),
			loadingPrinters: ref(false),
			printerOptions: ref([]),
			certLoading: ref(false),
			certReady: ref(false),
			handleConnect: vi.fn(),
			refreshPrinters: vi.fn(),
			generateCertificate: vi.fn(),
			downloadCertificate: vi.fn(),
		}),
	}
})
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: {
		configureStockSync: vi.fn(),
		getStockSyncStatus: vi.fn().mockResolvedValue({}),
	},
}))

globalThis.__ = (text) => text

const { default: POSSettings } = await import("../POSSettings.vue")

function mountIt() {
	return mount(POSSettings, {
		props: { modelValue: false, posProfile: "Main" },
		global: {
			mocks: { __: globalThis.__ },
			stubs: {
				Transition: false,
				CheckboxField: true,
				NumberField: true,
				SelectField: true,
				LoadingSpinner: true,
				TranslatedHTML: true,
			},
		},
	})
}

describe("the settings", () => {
	it("hold the export under their own tab, even with the server out of reach", async () => {
		const wrapper = mountIt()
		await wrapper.setProps({ modelValue: true })
		await flushPromises()
		expect(wrapper.find('[data-testid="queue-export"]').exists()).toBe(false)

		await wrapper.findAll("button").find((button) => button.text() === "Offline Queue").trigger("click")

		expect(wrapper.find('[data-testid="queue-export"]').exists()).toBe(true)
	})
})
