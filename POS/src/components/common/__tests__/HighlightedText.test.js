import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { splitMatches } from "@/utils/highlight"
import AutocompleteSelect from "../AutocompleteSelect.vue"
import HighlightedText from "../HighlightedText.vue"

vi.hoisted(() => {
	globalThis.__ = (text) => text
})

const HOSTILE = `<img src=x onerror="alert(1)">Sara`

describe("splitMatches", () => {
	it("cuts the text around every match, whatever its case", () => {
		expect(splitMatches("Sara and SARA", "sara")).toEqual([
			{ text: "Sara", match: true },
			{ text: " and ", match: false },
			{ text: "SARA", match: true },
		])
	})

	it("takes what was typed literally", () => {
		expect(splitMatches("a.b axb", "a.b")).toEqual([
			{ text: "a.b", match: true },
			{ text: " axb", match: false },
		])
		expect(splitMatches("cost (net)", "(")).toEqual([
			{ text: "cost ", match: false },
			{ text: "(", match: true },
			{ text: "net)", match: false },
		])
	})

	it("ignores spaces around the search", () => {
		expect(splitMatches("Sara", "  sar ")[0]).toEqual({
			text: "Sar",
			match: true,
		})
	})

	it("leaves the text alone with nothing to find", () => {
		expect(splitMatches("Sara", "")).toEqual([{ text: "Sara", match: false }])
		expect(splitMatches("Sara", "   ")).toEqual([
			{ text: "Sara", match: false },
		])
		expect(splitMatches(null, "sara")).toEqual([])
		expect(splitMatches(undefined, undefined)).toEqual([])
	})
})

describe("HighlightedText", () => {
	it("shows markup in a name as text", () => {
		const wrapper = mount(HighlightedText, {
			props: { text: HOSTILE, query: "sara" },
		})

		expect(wrapper.find("img").exists()).toBe(false)
		expect(wrapper.text()).toBe(HOSTILE)
		expect(wrapper.find("mark").text()).toBe("Sara")
	})

	it("does not parse a name when nothing was searched for", () => {
		const wrapper = mount(HighlightedText, { props: { text: HOSTILE } })

		expect(wrapper.find("img").exists()).toBe(false)
		expect(wrapper.text()).toBe(HOSTILE)
	})

	it("cannot be made to match inside what it escapes", () => {
		const wrapper = mount(HighlightedText, {
			props: { text: "Tom & Sons", query: "amp" },
		})

		expect(wrapper.find("mark").exists()).toBe(false)
		expect(wrapper.text()).toBe("Tom & Sons")
	})

	it("styles the matches it is told to", () => {
		const wrapper = mount(HighlightedText, {
			props: { text: "Sara", query: "sara", markClass: "search-highlight" },
		})

		expect(wrapper.find("mark.search-highlight").exists()).toBe(true)
	})
})

describe("AutocompleteSelect", () => {
	async function openWith(label, search) {
		const wrapper = mount(AutocompleteSelect, {
			props: { options: [{ value: "CUST-1", label }], placeholder: "" },
		})
		await wrapper.find("input").setValue(search)
		return wrapper
	}

	it("lists a hostile customer name as text", async () => {
		const wrapper = await openWith(HOSTILE, "sara")

		expect(wrapper.find(".item-label img").exists()).toBe(false)
		expect(wrapper.find(".item-label").text()).toBe(HOSTILE)
		expect(wrapper.find(".item-label mark").text()).toBe("Sara")
	})

	it("survives a search that is not a valid pattern", async () => {
		const wrapper = await openWith("Sara (VIP)", "(vip")

		expect(wrapper.find(".item-label mark").text()).toBe("(VIP")
	})
})

describe("the components", () => {
	it("never parse data as HTML", () => {
		const root = path.resolve(__dirname, "../../..")
		const offenders = readdirSync(root, { recursive: true })
			.filter((file) => file.endsWith(".vue"))
			.filter((file) =>
				readFileSync(path.join(root, file), "utf8").includes("v-html"),
			)

		expect(offenders).toEqual([])
	})
})
