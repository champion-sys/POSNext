import { beforeEach, describe, expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({ answer: null, calls: 0 }))
const kept = vi.hoisted(() => new Map())

vi.mock("frappe-ui", () => ({ createResource: vi.fn() }))
vi.mock("../apiWrapper", () => ({
	call: vi.fn(async () => {
		server.calls++
		return server.answer
	}),
}))
vi.mock("@/platform/store", () => ({
	localStore: {
		putTranslations: async (entry) => kept.set(entry.locale, entry),
		getTranslations: async (locale) => kept.get(locale) ?? null,
	},
}))

let translation

beforeEach(async () => {
	vi.resetModules()
	kept.clear()
	server.calls = 0
	localStorage.setItem("pos_next_language", "ar")
	translation = await import("../translation")
})

describe("a dictionary kept on the device", () => {
	it("counts only when the server said it is in that language", () => {
		expect(translation.isInLocale({ __lang__: "ar", Pay: "دفع" }, "ar")).toBe(true)
		expect(translation.isInLocale({ __lang__: "ar-SA" }, "ar")).toBe(true)
		expect(translation.isInLocale({ __lang__: "en" }, "ar")).toBe(false)
		// Kept before the server named its language, so it may be the English one
		expect(translation.isInLocale({}, "ar")).toBe(false)
	})

	it("is fetched again at start when it came back in another language, though it is fresh", async () => {
		kept.set("ar", { locale: "ar", messages: { __lang__: "en" }, timestamp: Date.now() })
		server.answer = { __lang__: "ar", Pay: "دفع" }

		translation.default({ config: { globalProperties: {} }, provide() {} })
		await new Promise((resolve) => setTimeout(resolve, 150))

		expect(server.calls).toBe(1)
		expect(window.translatedMessages.Pay).toBe("دفع")
		expect(kept.get("ar").messages.__lang__).toBe("ar")
	})

	it("is not fetched again while fresh and in the right language", async () => {
		kept.set("ar", { locale: "ar", messages: { __lang__: "ar", Pay: "دفع" }, timestamp: Date.now() })

		translation.default({ config: { globalProperties: {} }, provide() {} })
		await new Promise((resolve) => setTimeout(resolve, 150))

		expect(window.translatedMessages.Pay).toBe("دفع")

		expect(server.calls).toBe(0)
	})
})
