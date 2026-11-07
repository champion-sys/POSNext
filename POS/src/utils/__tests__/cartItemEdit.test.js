import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildRateUpdate,
	canEditItemRate,
	capDiscountAmount,
	capDiscountPercent,
	getLineEditRules,
	getLineTotal,
	getRateError,
	getRateLockReason,
	getUnitOptions,
	normalizeQuantity,
	parseCartNumber,
	showsItemCode,
} from "../cartItemEdit"

const settings = (extra) => ({
	allowUserToEditRate: true,
	allowItemDiscount: true,
	...extra,
})

beforeEach(() => {
	vi.stubGlobal("__", (text, values = []) =>
		text.replace(/\{(\d)\}/g, (_match, index) => values[index]),
	)
})

describe("rate rules", () => {
	it("follows the setting and any offer on the line", () => {
		expect(canEditItemRate({}, settings())).toBe(true)
		expect(canEditItemRate({}, settings({ allowUserToEditRate: false }))).toBe(
			false,
		)
		expect(canEditItemRate({ pricing_rules: ["PR-1"] }, settings())).toBe(false)
	})

	it("says why a rate is locked", () => {
		expect(
			getRateLockReason({}, settings({ allowUserToEditRate: false })),
		).toBe("Rate editing is disabled")
		expect(getRateLockReason({ pricing_rules: ["PR-1"] }, settings())).toBe(
			"Locked (offer applied)",
		)
		expect(getRateLockReason({}, settings())).toBe("")
	})

	it("refuses a rate of zero or below", () => {
		expect(getRateError(0, 10, 0)).toBe("Rate must be greater than zero")
		expect(getRateError(-1, 10, 0)).toBe("Rate must be greater than zero")
	})

	it("treats a lower rate as a discount under the same limit", () => {
		expect(getRateError(9, 10, 10)).toBeNull()
		expect(getRateError(8, 10, 10)).toBe(
			"Rate reduction of 20.00% exceeds maximum allowed discount of 10%",
		)
		expect(getRateError(8, 10, 0)).toBeNull()
		expect(getRateError(12, 10, 10)).toBeNull()
	})

	it("records whether the rate was edited, as the store expects", () => {
		expect(buildRateUpdate(8, 10)).toEqual({
			rate: 8,
			price_list_rate: 10,
			is_rate_manually_edited: 1,
			original_rate: 10,
		})
		expect(buildRateUpdate(10, 10)).toEqual({
			rate: 10,
			price_list_rate: 10,
			is_rate_manually_edited: 0,
			original_rate: null,
		})
	})
})

describe("discount limit", () => {
	it("stops a percentage at the limit", () => {
		expect(capDiscountPercent(25, 10)).toBe(10)
		expect(capDiscountPercent(5, 10)).toBe(5)
	})

	it("treats a limit of zero as none, up to the whole line", () => {
		expect(capDiscountPercent(150, 0)).toBe(100)
		expect(capDiscountPercent(40, 0)).toBe(40)
	})

	it("stops an amount at the same share of the line", () => {
		expect(capDiscountAmount(50, 200, 10)).toBe(20)
		expect(capDiscountAmount(15, 200, 10)).toBe(15)
		expect(capDiscountAmount(500, 200, 0)).toBe(200)
	})
})

describe("what a line lets you change", () => {
	const plain = {
		item_code: "A",
		uom: "Nos",
		stock_uom: "Nos",
		item_uoms: [{ uom: "Box", conversion_factor: 12 }],
	}

	it("opens everything on a plain line", () => {
		expect(getLineEditRules(plain, settings())).toEqual({
			quantity: true,
			quantityInDialog: false,
			unit: true,
			rate: true,
			discount: true,
			remove: true,
		})
	})

	it("closes everything on a free item", () => {
		expect(getLineEditRules({ ...plain, is_free_item: 1 }, settings())).toEqual(
			{
				quantity: false,
				quantityInDialog: false,
				unit: false,
				rate: false,
				discount: false,
				remove: false,
			},
		)
	})

	it("sends a serial or batch quantity to the dialog and keeps its unit", () => {
		for (const tracked of [{ has_serial_no: 1 }, { has_batch_no: 1 }]) {
			const rules = getLineEditRules({ ...plain, ...tracked }, settings())
			expect(rules.quantity).toBe(false)
			expect(rules.quantityInDialog).toBe(true)
			expect(rules.unit).toBe(false)
			expect(rules.rate).toBe(true)
		}
	})

	it("keeps the quantity, unit and price of a resolved barcode", () => {
		const rules = getLineEditRules(
			{ ...plain, is_resolved_barcode: true },
			settings(),
		)
		expect(rules).toMatchObject({
			quantity: false,
			quantityInDialog: false,
			unit: false,
			rate: false,
		})
	})

	it("follows the discount setting", () => {
		expect(
			getLineEditRules(plain, settings({ allowItemDiscount: false })).discount,
		).toBe(false)
	})

	it("offers a unit choice only when there is one", () => {
		const single = { ...plain, item_uoms: [] }
		expect(getUnitOptions(single)).toEqual(["Nos"])
		expect(getLineEditRules(single, settings()).unit).toBe(false)
		expect(getUnitOptions({ ...single, item_uoms: [{ uom: "Nos" }] })).toEqual([
			"Nos",
		])
	})
})

describe("numbers as typed", () => {
	it("reads Western and Arabic digits and either decimal mark", () => {
		expect(parseCartNumber("12.5")).toBe(12.5)
		expect(parseCartNumber("١٢٫٥")).toBe(12.5)
		expect(parseCartNumber("۳")).toBe(3)
		expect(parseCartNumber("2,5")).toBe(2.5)
		expect(parseCartNumber(".5")).toBe(0.5)
		expect(parseCartNumber("-2")).toBe(-2)
	})

	it("reads a figure the way the app prints it", () => {
		expect(parseCartNumber("1,000")).toBe(1000)
		expect(parseCartNumber("1,000,000")).toBe(1000000)
		expect(parseCartNumber("12,500.50")).toBe(12500.5)
		expect(parseCartNumber("١٬٠٠٠")).toBe(1000)
	})

	it("keeps a comma before fewer than three digits as the decimal point", () => {
		expect(parseCartNumber("1,5")).toBe(1.5)
		expect(parseCartNumber("1,50")).toBe(1.5)
	})

	it("treats anything else as no number", () => {
		for (const text of ["", "  ", "abc", "1.2.3", "12a", null, undefined]) {
			expect(parseCartNumber(text)).toBeNull()
		}
	})

	it("refuses a quantity of zero, below zero or nothing", () => {
		expect(normalizeQuantity(0)).toBeNull()
		expect(normalizeQuantity(-3)).toBeNull()
		expect(normalizeQuantity(null)).toBeNull()
	})

	it("rounds a quantity to four places", () => {
		expect(normalizeQuantity(1.234567)).toBe(1.2346)
	})
})

describe("line display", () => {
	it("hides a code that repeats the name", () => {
		expect(showsItemCode({ item_code: "wd", item_name: "WD " })).toBe(false)
		expect(showsItemCode({ item_code: "ITEM-1", item_name: "قهوة" })).toBe(true)
		expect(showsItemCode({ item_code: "", item_name: "قهوة" })).toBe(false)
	})

	it("counts a free item as nothing, whatever its rate", () => {
		expect(
			getLineTotal({ is_free_item: 1, rate: 10, quantity: 2, amount: 0 }),
		).toBe(0)
		expect(getLineTotal({ rate: 10, quantity: 2, amount: 18 })).toBe(18)
		expect(getLineTotal({ rate: 10, quantity: 2 })).toBe(20)
	})

	it("is nothing on a line discounted in full", () => {
		expect(getLineTotal({ rate: 10, quantity: 2, amount: 0, discount_percentage: 100 })).toBe(0)
	})

	it("includes the tax when the rate does, so it agrees with the rate", () => {
		const line = { rate: 115, quantity: 2, amount: 200, tax_amount: 30 }

		expect(getLineTotal(line, true)).toBe(230)
		expect(getLineTotal(line, false)).toBe(200)
	})

	it("is nothing on a free line, with or without tax in the rate", () => {
		expect(getLineTotal({ is_free_item: 1, rate: 10, quantity: 2, amount: 10, tax_amount: 1 }, true)).toBe(0)
	})
})
