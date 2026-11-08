import { describe, expect, it } from "vitest"
import { addressLines, buildPrintContext } from "../context"

describe("a customer's address on a receipt", () => {
	it("is plain lines, as Frappe's address_display HTML would print as text", () => {
		expect(addressLines("test<br>\ntest<br>test<br>\nYemen<br>\n<br>\n")).toBe("test\ntest\ntest\nYemen")
		expect(addressLines("Al &amp; Sons<br/>Sana&#39;a")).toBe("Al & Sons\nSana'a")
		expect(addressLines("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;")
		expect(addressLines(null)).toBe("")
	})

	it("is what the server sends, so an offline print matches the online one", () => {
		const doc = { name: "S1", customer: "Clint", address_display: "test<br>\nYemen<br>" }
		expect(buildPrintContext({ doc }).customer.address).toBe("test\nYemen")
	})
})
