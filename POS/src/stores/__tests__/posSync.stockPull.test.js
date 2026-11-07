import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	pullChanges: vi.fn(async () => null),
	runtime: { isNative: true },
	offline: { value: false },
	session: { isLoggedIn: true },
}))

vi.mock("@/platform/runtime", async (importOriginal) => ({
	...(await importOriginal()),
	get isNative() {
		return mocks.runtime.isNative
	},
}))
vi.mock("@/data/session", () => ({ session: mocks.session }))
vi.mock("@/utils/offline", () => ({ syncOfflineInvoices: vi.fn() }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: {
		get isOffline() {
			return mocks.offline.value
		},
		getConnectionQuality: () => "good",
		subscribe: () => () => {},
	},
}))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: {
		getOfflineInvoiceCount: async () => 0,
		getOfflineInvoices: async () => [],
		requestPersistentStorage: async () => true,
	},
}))
vi.mock("@/utils/offline/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: mocks.pullChanges }))
vi.mock("@/composables/useShift", () => ({ clearShiftClosing: vi.fn(), markShiftClosing: vi.fn() }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ syncIntervalMinutes: 5 }),
}))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({ profileName: "Main" }) }))
vi.mock("@/stores/stock", () => ({
	useStockStore: () => ({ queued: new Map(), warehouse: null, setQueued: vi.fn() }),
}))

const { usePOSSyncStore } = await import("../posSync")
const { STOCK_ENTITIES } = await import("@/core/sync/pullEngine")

const MINUTE = 60 * 1000

const stockPulls = () => mocks.pullChanges.mock.calls.filter(([, only]) => only === STOCK_ENTITIES).length
const fullPulls = () => mocks.pullChanges.mock.calls.filter(([, only]) => !only).length

describe("the stock pull", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] })
		vi.stubGlobal("__", (text) => text)
		mocks.pullChanges.mockClear()
		mocks.runtime.isNative = true
		mocks.offline.value = false
		mocks.session.isLoggedIn = true
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	function openStore() {
		setActivePinia(createPinia())
		return usePOSSyncStore()
	}

	it("runs every minute on the apps with nothing turned on", async () => {
		openStore()

		await vi.advanceTimersByTimeAsync(3.5 * MINUTE)

		expect(stockPulls()).toBe(3)
	})

	it("leaves the full pull on its own interval", async () => {
		openStore()

		await vi.advanceTimersByTimeAsync(15.5 * MINUTE)

		expect(stockPulls()).toBe(15)
		expect(fullPulls()).toBe(1)
	})

	it("never falls due with the full pull, which would give up if it found one running", async () => {
		const dueAt = []
		mocks.pullChanges.mockImplementation(async (_profile, only) => {
			dueAt.push({ stock: Boolean(only), at: Date.now() })
			return null
		})
		openStore()

		await vi.advanceTimersByTimeAsync(31 * MINUTE)
		mocks.pullChanges.mockImplementation(async () => null)

		const fullAt = dueAt.filter(({ stock }) => !stock).map(({ at }) => at)
		expect(fullAt).toHaveLength(2)
		expect(dueAt.filter(({ stock, at }) => stock && fullAt.includes(at))).toEqual([])
	})

	it("does not run on the web", async () => {
		mocks.runtime.isNative = false
		openStore()

		await vi.advanceTimersByTimeAsync(3 * MINUTE)

		expect(stockPulls()).toBe(0)
	})

	it("waits while the device is offline", async () => {
		mocks.offline.value = true
		openStore()

		await vi.advanceTimersByTimeAsync(3 * MINUTE)

		expect(mocks.pullChanges).not.toHaveBeenCalled()
	})

	it("waits for a cashier to sign in", async () => {
		mocks.session.isLoggedIn = false
		openStore()

		await vi.advanceTimersByTimeAsync(3 * MINUTE)

		expect(mocks.pullChanges).not.toHaveBeenCalled()
	})

	it("survives a failed pull and tries again", async () => {
		mocks.pullChanges.mockRejectedValueOnce(new Error("server down"))
		openStore()

		await vi.advanceTimersByTimeAsync(2.5 * MINUTE)

		expect(stockPulls()).toBe(2)
	})
})
