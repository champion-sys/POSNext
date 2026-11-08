import { describe, expect, it } from "vitest"
import { roundToSmallestFraction } from "@/utils/currency"
import { getChangeBreakdown } from "@/utils/paymentChange"

const METHODS = [
	{ mode_of_payment: "Cash", type: "Cash" },
	{ mode_of_payment: "Credit Card", type: "Bank" },
]

function pay(entries, total = 115) {
	return getChangeBreakdown({
		entries: entries.map(([mode_of_payment, amount]) => ({ mode_of_payment, amount })),
		methods: METHODS,
		total,
	})
}

describe("money: change comes only out of cash, as ERPNext books it", () => {
	it("a card overpayment is not change", () => {
		expect(pay([["Credit Card", 120]])).toMatchObject({ overpaid: 5, nonCashOverpayment: 5, change: 0 })
	})

	it("cash above the total is change", () => {
		expect(pay([["Cash", 120]])).toMatchObject({ overpaid: 5, nonCashOverpayment: 0, change: 5 })
	})

	it("exact cash gives no change", () => {
		expect(pay([["Cash", 115]])).toMatchObject({ overpaid: 0, nonCashOverpayment: 0, change: 0 })
	})

	it("card and cash: change up to the cash paid", () => {
		expect(pay([["Credit Card", 100], ["Cash", 20]])).toMatchObject({ change: 5, nonCashOverpayment: 0 })
		expect(pay([["Credit Card", 113], ["Cash", 7]])).toMatchObject({ change: 5, nonCashOverpayment: 0 })
	})

	it("card and cash: an overpayment larger than the cash is refused", () => {
		expect(pay([["Credit Card", 118], ["Cash", 2]])).toMatchObject({
			overpaid: 5,
			cashPaid: 2,
			nonCashOverpayment: 3,
			change: 0,
		})
	})

	it("customer credit is never change", () => {
		const breakdown = getChangeBreakdown({
			entries: [{ mode_of_payment: "Cash", amount: 120, is_customer_credit: true }],
			methods: METHODS,
			total: 115,
		})
		expect(breakdown).toMatchObject({ nonCashOverpayment: 5, change: 0 })
	})
})

describe("money: rounding to the currency's smallest fraction, as frappe does", () => {
	it("rounds to a whole number when no fraction is set", () => {
		expect(roundToSmallestFraction(11.5, 0)).toBe(12)
		expect(roundToSmallestFraction(34.5, 0)).toBe(34)
		expect(roundToSmallestFraction(11.4, 0)).toBe(11)
	})

	it("rounds to the fraction, a remainder of exactly half going down", () => {
		expect(roundToSmallestFraction(11.63, 0.05)).toBe(11.65)
		expect(roundToSmallestFraction(11.62, 0.05)).toBe(11.6)
		expect(roundToSmallestFraction(11.625, 0.05, 3)).toBe(11.6)
		expect(roundToSmallestFraction(194.52, 0.01)).toBe(194.52)
	})

	it("rounds a negative total the way Python's remainder does", () => {
		expect(roundToSmallestFraction(-11.63, 0.05)).toBe(-11.65)
	})
})
