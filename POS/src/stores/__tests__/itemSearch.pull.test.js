import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

const mocks = vi.hoisted(() => ({
	call: vi.fn(async () => []),
	settings: new Map(),
	offlineWorker: {
		getCacheStats: vi.fn(async () => ({ items: 40, cacheReady: true, lastSync: 1 })),
		cacheItems: vi.fn(async () => ({ success: true })),
		searchCachedItems: vi.fn(async () => []),
		setShowVariantsAsItems: vi.fn(),
	},
}))

vi.mock("@/utils/apiWrapper", () => ({ call: mocks.call }))
vi.mock("@/utils/offline", () => ({
	getSetting: vi.fn(async (key, fallback) => mocks.settings.get(key) ?? fallback),
	setSetting: vi.fn(),
	isOffline: () => false,
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: mocks.offlineWorker }))
vi.mock("@/utils/offline/items", () => ({ updateItemBatchSerialData: vi.fn() }))
vi.mock("@/composables/useRealtimePosProfile", () => ({
	useRealtimePosProfile: () => ({ onPosProfileUpdate: vi.fn() }),
}))
vi.mock("frappe-ui", () => ({ createResource: () => ({ fetch: vi.fn(), submit: vi.fn() }) }))
vi.mock("../stock", () => ({
	useStockStore: () => ({ init: vi.fn(), getDisplayStock: () => 0, server: new Map() }),
}))
vi.mock("../posSettings", () => ({ usePOSSettingsStore: () => ({ showVariantsAsItems: false }) }))
vi.mock("../posShift", () => ({ usePOSShiftStore: () => ({ profileWarehouse: null }) }))

const { useItemSearchStore } = await import("../itemSearch")
const { pullStateKey } = await import("@/core/sync/pullEngine")

const items = (...codes) => codes.map((item_code) => ({ item_code, item_name: item_code, rate: 1 }))
const flush = () => new Promise((resolve) => setTimeout(resolve))

/** Fill the list the way a server load does. */
async function storeWith(...codes) {
	const store = useItemSearchStore()
	mocks.call.mockImplementation(async (method) =>
		method.endsWith("get_items_count") ? codes.length : items(...codes),
	)
	await store.loadAllItems("Main")
	await flush()
	return store
}

describe("item store and the pull engine", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
		mocks.settings.clear()
	})

	describe("applyPulledItems", () => {
		it("updates an item on screen", async () => {
			const store = await storeWith("A", "B")

			store.applyPulledItems([{ item_code: "A", rate: 9 }], [])
			await nextTick()

			expect(store.filteredItems.find((item) => item.item_code === "A").rate).toBe(9)
		})

		it("removes a deleted item from the screen", async () => {
			const store = await storeWith("A", "B")

			store.applyPulledItems([], ["A"])
			await nextTick()

			expect(store.filteredItems.map((item) => item.item_code)).toEqual(["B"])
		})

		it("ignores rows that are not on screen", async () => {
			const store = await storeWith("A")
			const before = store.allItems

			store.applyPulledItems([{ item_code: "Z", rate: 9 }], ["Y"])

			expect(store.allItems).toBe(before)
			expect(store.filteredItems.map((item) => item.item_code)).toEqual(["A"])
		})
	})

	describe("reloadProfileFromCache", () => {
		const cached = { profileItemGroups: [{ item_group: "Food" }], itemGroups: [{ item_group: "Food" }] }

		it("shows the stored groups of the active profile", async () => {
			const store = await storeWith("A")
			mocks.settings.set("pos_profile_data:Main", cached)

			await store.reloadProfileFromCache("Main")

			expect(store.profileItemGroups).toEqual(cached.profileItemGroups)
			expect(store.itemGroups).toEqual(cached.itemGroups)
		})

		it("ignores another profile", async () => {
			const store = await storeWith("A")
			mocks.settings.set("pos_profile_data:Second", cached)

			await store.reloadProfileFromCache("Second")

			expect(store.profileItemGroups).toEqual([])
		})
	})

	describe("background catalog sync", () => {
		const bulkCalls = () => mocks.call.mock.calls.filter(([method]) => method.endsWith("get_items_bulk"))

		const walked = (posProfile = "Main") =>
			mocks.settings.set(pullStateKey("items"), { version: "v1", posProfile, cursor: "c1" })

		beforeEach(() => {
			mocks.call.mockImplementation(async () => [])
		})

		it("downloads the catalog on a device the pull engine has not walked", async () => {
			const store = useItemSearchStore()

			await store.startBackgroundCacheSync("Main")
			await flush()

			expect(bulkCalls().length).toBeGreaterThan(0)
			expect(store.cacheSyncing).toBe(false)
		})

		it("downloads nothing once the pull engine keeps the catalog current", async () => {
			walked()
			const store = useItemSearchStore()

			await store.startBackgroundCacheSync("Main")
			await flush()

			expect(bulkCalls()).toEqual([])
			expect(store.cacheReady).toBe(true)
			expect(store.cacheSyncing).toBe(false)
		})

		it("still downloads when the walk was of another profile", async () => {
			walked("Second")
			const store = useItemSearchStore()

			await store.startBackgroundCacheSync("Main")
			await flush()

			expect(bulkCalls().length).toBeGreaterThan(0)
		})

		it("still downloads on a manual refresh", async () => {
			walked()
			const store = useItemSearchStore()

			await store.startBackgroundCacheSync("Main", [], 0, { force: true })
			await flush()

			expect(bulkCalls().length).toBeGreaterThan(0)
		})
	})
})
