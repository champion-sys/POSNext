import { describe, expect, it } from "vitest"
import { computeReturnTotal, refundForUnits, returnRowRefund, returnRowWarehouse } from "../returnInvoice"

describe("refundForUnits", () => {
	it("rounds down until the last unit, which takes the coins left over", () => {
		// 223.00 for 3 units: 74.33, 74.33, then 74.34
		expect(refundForUnits(22300, 3, 1)).toBe(7433)
		expect(refundForUnits(22300, 3, 2)).toBe(14866)
		expect(refundForUnits(22300, 3, 3)).toBe(22300)
	})

	it("gives nothing for no units, and the whole row for more than were sold", () => {
		expect(refundForUnits(22300, 3, 0)).toBe(0)
		expect(refundForUnits(22300, 3, 4)).toBe(22300)
	})

	it("keeps a unit that divides evenly whole despite float noise", () => {
		// 0.3 * 3 / 0.9 is 0.9999999999999999 in floats
		expect(refundForUnits(30, 0.9, 0.3)).toBe(10)
		expect(refundForUnits(21000, 3, 1)).toBe(7000)
	})
})

describe("computeReturnTotal with refund_value", () => {
	const row = { refund_value: 223, original_qty: 3, already_returned: 0, rate: 80 }

	it("gives back the whole of what the sale took for a row returned at once", () => {
		expect(computeReturnTotal([{ ...row, return_qty: 3 }])).toBe(223)
	})

	it("adds up one unit at a time to exactly what the sale took", () => {
		const parts = [0, 1, 2].map((before) => computeReturnTotal([{ ...row, already_returned: before, return_qty: 1 }]))
		expect(parts).toEqual([74.33, 74.33, 74.34])
		expect(parts.reduce((sum, part) => sum + part * 100, 0)).toBe(22300)
	})

	it("adds the rows' shares, then the balance earlier returns left", () => {
		const rows = [
			{ ...row, return_qty: 1 },
			{ refund_value: 88.99, original_qty: 2, already_returned: 1, return_qty: 1, rate: 45.5 },
		]
		expect(computeReturnTotal(rows)).toBe(74.33 + 44.5)
		expect(computeReturnTotal(rows, { balance: 0.02 })).toBe(118.85)
	})

	it("never gives back less than nothing", () => {
		expect(computeReturnTotal([{ ...row, return_qty: 1 }], { balance: -100 })).toBe(0)
	})

	it("counts in the coins of the currency's precision", () => {
		expect(computeReturnTotal([{ ...row, refund_value: 22.301, return_qty: 1 }], { precision: 3 })).toBe(7.433)
	})

	it("shows a row at its share", () => {
		expect(returnRowRefund({ ...row, already_returned: 2, return_qty: 1 })).toBe(74.34)
		expect(returnRowRefund({ return_qty: 2, rate: 10, rate_with_tax: 11.5 })).toBe(23)
	})
})

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
