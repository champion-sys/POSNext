import { describe, expect, it } from "vitest"
import { imageUrl } from "../runtime"

describe("imageUrl", () => {
	it("points a stored file at the server", () => {
		expect(imageUrl("/files/a.png")).toBe(`${window.location.origin}/files/a.png`)
	})

	it.each([
		["https://cdn.example.com/a.png"],
		["data:image/png;base64,AAAA"],
		["blob:https://x/1"],
	])("leaves %s as it is", (url) => {
		expect(imageUrl(url)).toBe(url)
	})

	it("leaves an item with no image empty, so its placeholder shows", () => {
		expect(imageUrl(undefined)).toBeUndefined()
		expect(imageUrl(null)).toBeNull()
	})
})
