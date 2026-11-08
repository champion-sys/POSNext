import { describe, expect, it } from "vitest"
import { computeReturnTotal, returnRowWarehouse } from "../returnInvoice"

describe("computeReturnTotal", () => {
	it("rounds an added tax once over the rows, as ERPNext does", () => {
		const rows = [
			{ return_qty: 1, rate: 10.03, rate_with_tax: 11.53, tax_fraction: 0.15 },
			{ return_qty: 1, rate: 10.03, rate_with_tax: 11.53, tax_fraction: 0.15 },
		]
		// Per row 11.53 + 11.53 = 23.06. ERPNext: net 20.06, VAT 3.009 rounded once to 3.01
		expect(computeReturnTotal(rows)).toBe(23.07)
	})

	it("counts an inclusive row at its rate", () => {
		expect(computeReturnTotal([{ return_qty: 2, rate: 90, tax_fraction: 0, tax_included_in_rate: true }])).toBe(180)
	})

	it("counts a row with no tax_fraction at its rate with tax", () => {
		expect(computeReturnTotal([{ return_qty: 3, rate: 10, rate_with_tax: 11.5 }])).toBe(34.5)
	})
})

describe("returnRowWarehouse", () => {
	const row = { warehouse: "Stores" }

	it("sends the goods to the branch taking the return", () => {
		expect(
			returnRowWarehouse(row, { originalProfile: "A", currentProfile: "B", currentWarehouse: "Branch" }),
		).toBe("Branch")
	})

	it("keeps the sale's warehouse at the same branch, or when the branch has none", () => {
		expect(returnRowWarehouse(row, { originalProfile: "A", currentProfile: "A", currentWarehouse: "X" })).toBe("Stores")
		expect(returnRowWarehouse(row, { originalProfile: "A", currentProfile: "B" })).toBe("Stores")
	})
})
