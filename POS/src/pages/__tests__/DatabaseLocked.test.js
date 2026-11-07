import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOCKED_TEXT_KEY, lockedPageText, rememberLockedPageText } from "@/platform/lockedPageText"
import { isDeviceKey } from "@/platform/runtime"
import DatabaseLocked from "../DatabaseLocked.vue"

vi.mock("frappe-ui", () => ({ call: vi.fn(async () => null), createResource: vi.fn() }))

const ARABIC_TITLE = "البيانات على هذا الجهاز مقفلة"
const ENGLISH_TITLE = "The data on this device is locked"

describe("the page for a locked database", () => {
	const reload = vi.fn()

	beforeEach(() => {
		localStorage.clear()
		delete window.translatedMessages
		vi.stubGlobal("location", { reload })
		reload.mockClear()
	})

	afterEach(() => vi.unstubAllGlobals())

	const show = () => mount(DatabaseLocked, { props: { reason: "key-missing" } })

	it("says what happened, and that nothing is gone", () => {
		const page = show().text()

		expect(page).toContain(ENGLISH_TITLE)
		expect(page).toContain("Nothing has been deleted")
	})

	it("warns against what would really lose the data", () => {
		expect(show().text()).toContain("Do not uninstall the app or clear its data")
	})

	it("shows the code support needs", () => {
		expect(show().text()).toContain("key-missing")
	})

	it("offers no way past it, only trying again", async () => {
		const page = show()
		const buttons = page.findAll("button")

		expect(buttons).toHaveLength(1)
		await buttons[0].trigger("click")
		expect(reload).toHaveBeenCalled()
	})

	describe("with the translations in a database it cannot read", () => {
		it("speaks the language of the last normal start", () => {
			window.translatedMessages = { [ENGLISH_TITLE]: ARABIC_TITLE }
			rememberLockedPageText()
			delete window.translatedMessages

			expect(lockedPageText().title).toBe(ARABIC_TITLE)
		})

		it("turns to the right for Arabic", () => {
			window.translatedMessages = { [ENGLISH_TITLE]: ARABIC_TITLE }
			rememberLockedPageText()
			delete window.translatedMessages

			expect(show().find("[dir]").attributes("dir")).toBe("rtl")
		})

		it("prefers fresh translations when the server gave some", () => {
			localStorage.setItem(LOCKED_TEXT_KEY, JSON.stringify({ title: "old" }))
			window.translatedMessages = { [ENGLISH_TITLE]: ARABIC_TITLE }

			expect(lockedPageText().title).toBe(ARABIC_TITLE)
		})

		it("falls back to English with nothing remembered", () => {
			expect(lockedPageText().title).toBe(ENGLISH_TITLE)
		})

		it("falls back to English when the copy is damaged", () => {
			localStorage.setItem(LOCKED_TEXT_KEY, "{broken")

			expect(lockedPageText().title).toBe(ENGLISH_TITLE)
		})

		it("survives clearing the caches", () => {
			expect(isDeviceKey(LOCKED_TEXT_KEY, "electron")).toBe(true)
		})
	})
})
