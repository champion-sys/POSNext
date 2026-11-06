import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePOSSettingsStore } from "../posSettings"

vi.mock("frappe-ui", () => ({ createResource: () => ({ submit: vi.fn() }) }))
vi.mock("../bootstrap", () => ({ useBootstrapStore: () => ({ getPreloadedPOSSettings: () => null }) }))

const save = (profile, settings) => {
	localStorage.setItem(`pos_next_settings_${profile}`, JSON.stringify(settings))
}

describe("what a device knows about opening a shift offline", () => {
	let store

	beforeEach(() => {
		localStorage.clear()
		setActivePinia(createPinia())
		store = usePOSSettingsStore()
	})

	it("reads the copy the server last sent for that POS Profile", () => {
		save("Main", { allow_offline_shift_open: 1 })
		expect(store.allowsOfflineShiftOpen("Main")).toBe(true)
	})

	it("is no when the setting is off", () => {
		save("Main", { allow_offline_shift_open: 0 })
		expect(store.allowsOfflineShiftOpen("Main")).toBe(false)
	})

	it("is no for a copy saved before the setting existed", () => {
		save("Main", { allow_offline_shift_close: 1 })
		expect(store.allowsOfflineShiftOpen("Main")).toBe(false)
	})

	it("is no for a POS Profile this device never loaded", () => {
		expect(store.allowsOfflineShiftOpen("Main")).toBe(false)
	})

	it("does not take one POS Profile's answer for another's", () => {
		save("Main", { allow_offline_shift_open: 1 })
		expect(store.allowsOfflineShiftOpen("Other")).toBe(false)
	})

	it("is not fooled by the settings loaded for another POS Profile", () => {
		store.settings.allow_offline_shift_open = 1
		save("Main", { allow_offline_shift_open: 0 })
		expect(store.allowsOfflineShiftOpen("Main")).toBe(false)
	})

	it("is no where offline mode is turned off", () => {
		save("Main", { allow_offline_shift_open: 1, custom_disable_offline_mode: 1 })
		expect(store.allowsOfflineShiftOpen("Main")).toBe(false)
	})
})
