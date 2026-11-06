import { beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({ current: "web" }))

vi.mock("@/platform/runtime", async (importOriginal) => {
	const runtime = await importOriginal()
	return { ...runtime, isDeviceKey: (key) => runtime.isDeviceKey(key, platform.current) }
})

vi.mock("@/platform/store", () => ({
	localStore: new Proxy({}, { get: () => async () => ({}) }),
}))

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))

const { clearBrowserCache } = await import("../cache")

const ENROLLMENT = {
	pos_next_server_url: "https://pos.example.com",
	pos_next_device_token: "token",
	pos_next_cashier_grant: "grant",
	pos_next_cashiers: "[]",
	pos_next_device_id: "device",
}

const CACHES = {
	pos_next_settings_abc: "{}",
	pos_next_language: "ar",
	pos_next_schema_version: "3",
	frappe_cache: "1",
}

describe("clearing the browser's cache", () => {
	beforeEach(() => {
		localStorage.clear()
		sessionStorage.clear()
		for (const [key, value] of Object.entries({ ...ENROLLMENT, ...CACHES })) {
			localStorage.setItem(key, value)
		}
		localStorage.setItem("pos_next_closing_shifts", '["SHIFT-1"]')
		localStorage.setItem("pos_qz_printer_name", "Front desk")
		sessionStorage.setItem("pos_next_offline_rcpt:a", "{}")
	})

	describe.each(["electron", "android"])("on %s", (name) => {
		beforeEach(() => {
			platform.current = name
		})

		it("keeps the device enrolled", () => {
			expect(clearBrowserCache().success).toBe(true)

			for (const [key, value] of Object.entries(ENROLLMENT)) {
				expect(localStorage.getItem(key)).toBe(value)
			}
		})

		it("keeps a shift closed offline, so it takes no more sales", () => {
			clearBrowserCache()
			expect(localStorage.getItem("pos_next_closing_shifts")).toBe('["SHIFT-1"]')
		})

		it("still clears what is only a cache", () => {
			const { cleared } = clearBrowserCache()

			for (const key of Object.keys(CACHES)) {
				expect(localStorage.getItem(key)).toBeNull()
			}
			expect(sessionStorage.getItem("pos_next_offline_rcpt:a")).toBeNull()
			expect(cleared).toEqual({ localStorage: Object.keys(CACHES).length, sessionStorage: 1 })
		})
	})

	describe("on the web", () => {
		beforeEach(() => {
			platform.current = "web"
		})

		it("clears every key of the app, as it always has", () => {
			const { cleared } = clearBrowserCache()

			for (const key of [...Object.keys(ENROLLMENT), ...Object.keys(CACHES), "pos_next_closing_shifts"]) {
				expect(localStorage.getItem(key)).toBeNull()
			}
			expect(cleared.localStorage).toBe(Object.keys(ENROLLMENT).length + Object.keys(CACHES).length + 1)
		})
	})

	it("leaves other apps' keys alone on every platform", () => {
		for (const name of ["web", "electron", "android"]) {
			platform.current = name
			clearBrowserCache()
			expect(localStorage.getItem("pos_qz_printer_name")).toBe("Front desk")
		}
	})
})
