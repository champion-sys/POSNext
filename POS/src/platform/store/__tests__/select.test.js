import { beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({ current: "web", loads: [], openNative: null }))

vi.mock("../../runtime", () => ({
	get PLATFORM() {
		return platform.current
	},
	WEB: "web",
	ELECTRON: "electron",
	ANDROID: "android",
}))

vi.mock("../web", () => ({
	openStore() {
		platform.loads.push("web")
		return { getSetting: async () => "from web" }
	},
}))

vi.mock("../native", () => ({
	openStore() {
		platform.loads.push("native")
		return platform.openNative?.() ?? { getSetting: async () => "from native" }
	},
}))

describe("choosing the implementation", () => {
	beforeEach(() => {
		vi.resetModules()
		platform.loads.length = 0
		platform.openNative = null
	})

	it.each([
		["web", "from web", "web"],
		["electron", "from native", "native"],
		["android", "from native", "native"],
	])("%s opens only its own implementation", async (name, answer, implementation) => {
		platform.current = name

		const { localStore } = await import("../index")

		expect(await localStore.getSetting("key")).toBe(answer)
		expect(new Set(platform.loads)).toEqual(new Set([implementation]))
	})

	it("opens it once, however many calls arrive", async () => {
		platform.current = "electron"

		const { localStore } = await import("../index")
		await Promise.all([localStore.getSetting("a"), localStore.getSetting("b"), localStore.getSetting("c")])

		expect(platform.loads).toEqual(["native"])
	})

	it("opens again after a failure instead of remembering it", async () => {
		platform.current = "electron"
		platform.openNative = () => {
			if (platform.loads.length === 1) throw new Error("no database yet")
			return { getSetting: async () => "recovered" }
		}

		const { localStore } = await import("../index")
		await vi.waitFor(() => expect(platform.loads).toHaveLength(1))

		expect(await localStore.getSetting("key")).toBe("recovered")
	})
})
