import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const syncOfflineInvoices = vi.hoisted(() => vi.fn())

vi.mock("@/utils/offline", () => ({ syncOfflineInvoices }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: {
		isOffline: false,
		getConnectionQuality: () => "good",
		subscribe: () => () => {},
	},
}))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: {
		getOfflineInvoiceCount: async () => 1,
		getOfflineInvoices: async () => [],
		requestPersistentStorage: async () => true,
	},
}))
vi.mock("@/utils/offline/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ clearShiftClosing: vi.fn(), markShiftClosing: vi.fn() }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ syncIntervalMinutes: 5 }),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({}) }))
vi.mock("@/stores/stock", () => ({
	useStockStore: () => ({ queued: new Map(), warehouse: null, setQueued: vi.fn() }),
}))

const { usePOSSyncStore } = await import("../posSync")

const LAST_SYNC_KEY = "pos_next_last_invoice_sync"

const outcome = (counts) => ({ success: 0, failed: 0, skipped: 0, waiting: 0, delivered: 0, errors: [], ...counts })

describe("the time of the last sync", () => {
	let store

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })
		vi.stubGlobal("__", (text) => text)
		localStorage.clear()
		setActivePinia(createPinia())
		store = usePOSSyncStore()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it.each([
		["the server took a sale and is still working on it", { delivered: 1, waiting: 1 }],
		["the first response finished a sale", { delivered: 1, success: 1 }],
		["a sale sent earlier finished", { success: 1 }],
		["the server took a sale that needs review", { delivered: 1, failed: 1 }],
	])("moves when %s", async (_name, counts) => {
		syncOfflineInvoices.mockResolvedValue(outcome(counts))

		await store.syncAllPending()

		expect(store.lastSyncedAt).toEqual(expect.any(Number))
		expect(localStorage.getItem(LAST_SYNC_KEY)).toBe(String(store.lastSyncedAt))
	})

	it.each([
		["the server refused the sale", { failed: 1 }],
		["a sale is still waiting from before", { waiting: 1 }],
		["nothing happened", {}],
	])("stays when %s", async (_name, counts) => {
		syncOfflineInvoices.mockResolvedValue(outcome(counts))

		await store.syncAllPending()

		expect(store.lastSyncedAt).toBeNull()
		expect(localStorage.getItem(LAST_SYNC_KEY)).toBeNull()
	})
})
