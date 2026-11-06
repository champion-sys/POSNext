import { describe, expect, it } from "vitest"
import { chunk, normalizeSearchText } from "../searchText"

describe("normalizeSearchText", () => {
	it.each([
		["alef with hamza above", "أحمد", "احمد"],
		["alef with hamza below", "إبريق", "ابريق"],
		["alef with madda", "آلة", "اله"],
		["wasla", "ٱلله", "الله"],
		["taa marbuta", "قهوة", "قهوه"],
		["alef maksura", "مصطفى", "مصطفي"],
		["tashkeel", "قَهْوَةٌ", "قهوه"],
		["shadda", "سكّر", "سكر"],
		["tatweel", "قهــــوة", "قهوه"],
		["superscript alef", "رحمٰن", "رحمن"],
		["presentation forms", "ﻗﻬﻮﺓ", "قهوه"],
		["alef with a separate madda", "آ", "ا"],
	])("handles %s", (_name, text, expected) => {
		expect(normalizeSearchText(text)).toBe(expected)
	})

	it("treats each spelling of a word the same", () => {
		const spellings = ["أَرُزّ", "ارز", "أرز", "إرز", "آرز"]
		expect(new Set(spellings.map(normalizeSearchText)).size).toBe(1)
	})

	it("leaves latin text and numbers searchable", () => {
		expect(normalizeSearchText("  Coffee   BEANS 500g ")).toBe("coffee beans 500g")
	})

	it("keeps hamza on waw and yeh, which are different letters to a cashier", () => {
		expect(normalizeSearchText("مؤسسة")).toBe("مؤسسه")
		expect(normalizeSearchText("شيء")).toBe("شيء")
	})

	it("takes anything", () => {
		expect(normalizeSearchText(null)).toBe("")
		expect(normalizeSearchText(undefined)).toBe("")
		expect(normalizeSearchText(12345)).toBe("12345")
	})
})

describe("chunk", () => {
	it("splits a list into pages", () => {
		expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
		expect(chunk([], 2)).toEqual([])
	})
})
