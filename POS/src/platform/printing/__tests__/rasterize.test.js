import { describe, expect, it } from "vitest"
import { canvasToEscPos, rasterGeometry, toForeignObjectMarkup } from "../rasterize"

/** A canvas whose pixels are given, as getImageData returns them */
function fakeCanvas(width, height, isBlack) {
	const data = new Uint8ClampedArray(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const value = isBlack(x, y) ? 0 : 255
			data.set([value, value, value, 255], i)
		}
	}
	return { width, height, getContext: () => ({ getImageData: () => ({ data }) }) }
}

describe("the raster's width", () => {
	it("is 384 dots on a 58mm roll and 576 on an 80mm roll", () => {
		expect(rasterGeometry("58mm", "58")).toEqual({ cssWidth: 219, rasterWidth: 384 })
		expect(rasterGeometry("80mm", "80")).toEqual({ cssWidth: 302, rasterWidth: 576 })
	})

	it("comes from the printer's roll, the layout from the template's paper", () => {
		expect(rasterGeometry("58mm", "80")).toEqual({ cssWidth: 219, rasterWidth: 576 })
		expect(rasterGeometry("80mm", "58")).toEqual({ cssWidth: 302, rasterWidth: 384 })
	})

	it("lays a page template out at the roll's width", () => {
		expect(rasterGeometry("A4", "80")).toEqual({ cssWidth: 302, rasterWidth: 576 })
		expect(rasterGeometry("A5", "58")).toEqual({ cssWidth: 219, rasterWidth: 384 })
	})
})

describe("the ESC/POS image", () => {
	it("is one GS v 0 block as wide as the canvas", () => {
		const bytes = canvasToEscPos(fakeCanvas(576, 300, () => false), { feeds: 3 })

		expect(Array.from(bytes.slice(0, 10))).toEqual([0x1b, 0x40, 0x1d, 0x76, 0x30, 0, 72, 0, 300 % 256, 1])
		expect(bytes.length).toBe(2 + 8 + 72 * 300 + 3 + 4 + 2)
		expect(Array.from(bytes.slice(-9))).toEqual([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 66, 0, 0x1b, 0x40])
	})

	it("sets a bit for every dark dot, left to right", () => {
		// The first column and the ninth are black
		const bytes = canvasToEscPos(fakeCanvas(384, 2, (x) => x === 0 || x === 8), { feeds: 0 })
		const firstRow = bytes.slice(10, 10 + 48)

		expect(firstRow[0]).toBe(0b10000000)
		expect(firstRow[1]).toBe(0b10000000)
		expect(firstRow.slice(2).every((byte) => byte === 0)).toBe(true)
	})
})

describe("the markup drawn through foreignObject", () => {
	it("is XHTML without scripts, fixed to the layout width", () => {
		const markup = toForeignObjectMarkup(
			'<!DOCTYPE html><html dir="rtl"><head><style>p{color:red}</style></head><body><p>مرحبا&nbsp;&amp; hi<br></p><script>x()</script></body></html>',
			302,
		)

		expect(markup).toContain('xmlns="http://www.w3.org/1999/xhtml"')
		expect(markup).toContain('dir="rtl"')
		expect(markup).toContain("<br />")
		expect(markup).toContain("width:302px")
		expect(markup).not.toContain("<script")
		expect(() => new DOMParser().parseFromString(markup, "application/xml").documentElement.nodeName).not.toThrow()
		expect(new DOMParser().parseFromString(markup, "application/xml").querySelector("parsererror")).toBeNull()
	})
})
