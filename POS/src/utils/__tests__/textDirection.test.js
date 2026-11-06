import { describe, expect, it } from "vitest"
import { getTextDirection } from "../textDirection"

describe("getTextDirection", () => {
	it("keeps an Arabic sentence right-to-left when it opens with a Latin name", () => {
		expect(getTextDirection("INV-0001 تم حفظها بنجاح.")).toBe("rtl")
		expect(getTextDirection("QZ Tray غير متصل.")).toBe("rtl")
	})

	it("keeps an English error left-to-right when it quotes Arabic names", () => {
		expect(
			getTextDirection(
				"Mode of payment مدى has no account for company شركة الاختبار.",
			),
		).toBe("ltr")
	})

	it("reads plain English as left-to-right", () => {
		expect(getTextDirection("Could not reach the server.")).toBe("ltr")
	})

	it("handles empty text", () => {
		expect(getTextDirection("")).toBe("ltr")
		expect(getTextDirection(null)).toBe("ltr")
	})
})
