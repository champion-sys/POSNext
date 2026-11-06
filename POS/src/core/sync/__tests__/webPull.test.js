import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	const manifest = {
		pos_profile: "v1",
		taxes: "v1",
		payment_methods: "v1",
		item_prices: "v1",
		items: "v1",
		customers: "v1",
		offers: "v1",
	}
	return {
		manifest,
		call: vi.fn(),
		settings: new Map(),
		offlineWorker: {
			applyPullPage: vi.fn(async () => ({ success: true })),
			getCachedOffers: vi.fn(async () => [{ name: "O1" }]),
		},
		itemStore: {
			cacheSyncing: false,
			applyPulledItems: vi.fn(),
			reloadProfileFromCache: vi.fn(async () => {}),
		},
		customerStore: { reloadFromCache: vi.fn(async () => {}) },
		cartStore: { loadTaxRules: vi.fn(async () => {}) },
		offersStore: { setAvailableOffers: vi.fn() },
		settingsStore: { settings: { tax_inclusive: 1 }, reloadSettings: vi.fn(async () => true) },
	}
})

vi.mock("@/utils/apiWrapper", () => ({ call: mocks.call }))
vi.mock("@/utils/offline/settings", () => ({
	getSetting: vi.fn(async (key) => mocks.settings.get(key) ?? null),
	setSetting: vi.fn(async (key, value) => void mocks.settings.set(key, value)),
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: mocks.offlineWorker }))
vi.mock("@/stores/itemSearch", () => ({ useItemSearchStore: () => mocks.itemStore }))
vi.mock("@/stores/customerSearch", () => ({ useCustomerSearchStore: () => mocks.customerStore }))
vi.mock("@/stores/posCart", () => ({ usePOSCartStore: () => mocks.cartStore }))
vi.mock("@/stores/posOffers", () => ({ usePOSOffersStore: () => mocks.offersStore }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => mocks.settingsStore }))

const { pullChanges } = await import("../webPull")
const { pullStateKey } = await import("../pullEngine")

const page = (rows = [], deleted = []) => ({ rows, deleted, next_cursor: "c1", has_more: false })

/** Answer the manifest, and give `pages[entity]` to any pull. */
function serve(pages = {}) {
	mocks.call.mockImplementation(async (method, args) => {
		if (method.endsWith("get_manifest")) return mocks.manifest
		return pages[args.entity] ?? page()
	})
}

const pulledEntities = () =>
	mocks.call.mock.calls.filter(([method]) => method.endsWith(".pull")).map(([, args]) => args.entity)

describe("pullChanges", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.settings.clear()
		mocks.itemStore.cacheSyncing = false
		serve()
	})

	it("does nothing without a profile", async () => {
		expect(await pullChanges(undefined)).toBeNull()
		expect(mocks.call).not.toHaveBeenCalled()
	})

	it("stores pages through the worker and keeps the cursor in settings", async () => {
		const items = page([{ item_code: "A" }], ["B"])
		serve({ items })

		await pullChanges("Main")

		expect(mocks.offlineWorker.applyPullPage).toHaveBeenCalledWith("items", items, "Main")
		expect(mocks.settings.get(pullStateKey("items"))).toMatchObject({ cursor: "c1", version: "v1" })
	})

	it("shows pulled items and prices without reloading the list", async () => {
		serve({ items: page([{ item_code: "A" }], ["B"]), item_prices: page([{ item_code: "C" }]) })

		await pullChanges("Main")

		expect(mocks.itemStore.applyPulledItems).toHaveBeenCalledWith([{ item_code: "A" }], ["B"])
		expect(mocks.itemStore.applyPulledItems).toHaveBeenCalledWith([{ item_code: "C" }], [])
	})

	it("refreshes every store once after a change", async () => {
		await pullChanges("Main")

		expect(mocks.customerStore.reloadFromCache).toHaveBeenCalledTimes(1)
		expect(mocks.offersStore.setAvailableOffers).toHaveBeenCalledWith([{ name: "O1" }])
		expect(mocks.itemStore.reloadProfileFromCache).toHaveBeenCalledWith("Main")
		expect(mocks.settingsStore.reloadSettings).toHaveBeenCalledTimes(1)
		expect(mocks.cartStore.loadTaxRules).toHaveBeenCalledWith("Main", mocks.settingsStore.settings)
	})

	it("reloads settings before taxes, because tax inclusive is a setting", async () => {
		await pullChanges("Main")

		const [reload] = mocks.settingsStore.reloadSettings.mock.invocationCallOrder
		const [taxes] = mocks.cartStore.loadTaxRules.mock.invocationCallOrder
		expect(reload).toBeLessThan(taxes)
	})

	it("touches no store when the manifest has not moved", async () => {
		await pullChanges("Main")
		vi.clearAllMocks()

		await pullChanges("Main")

		expect(pulledEntities()).toEqual([])
		expect(mocks.offlineWorker.applyPullPage).not.toHaveBeenCalled()
		expect(mocks.customerStore.reloadFromCache).not.toHaveBeenCalled()
		expect(mocks.cartStore.loadTaxRules).not.toHaveBeenCalled()
	})

	it("leaves the catalog to the background sync while it is downloading", async () => {
		mocks.itemStore.cacheSyncing = true

		await pullChanges("Main")

		expect(pulledEntities()).toEqual(["pos_profile", "taxes", "payment_methods", "customers", "offers"])
	})

	it("runs one pull at a time", async () => {
		const first = pullChanges("Main")

		expect(await pullChanges("Main")).toBeNull()
		await first
	})

	it("lets the next run start after a failed manifest", async () => {
		mocks.call.mockRejectedValueOnce(new Error("offline"))

		await expect(pullChanges("Main")).rejects.toThrow("offline")

		serve()
		expect(await pullChanges("Main")).not.toBeNull()
	})

	it("stands aside when another tab holds the lock", async () => {
		vi.stubGlobal("navigator", {
			locks: { request: vi.fn(async (_name, _options, callback) => callback(null)) },
		})

		expect(await pullChanges("Main")).toBeNull()
		expect(mocks.call).not.toHaveBeenCalled()

		vi.unstubAllGlobals()
	})
})
