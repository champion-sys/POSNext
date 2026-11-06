import { describe, expect, it } from "vitest"
import {
	classifySyncError,
	formatLocalPosting,
	getSaleSignature,
	getShiftCloseDecision,
	isNetworkFailure,
	sumQueuedStock,
	supportsOfflineId,
	withOfflinePosting,
} from "../invoicePayload"

describe("formatLocalPosting", () => {
	it("uses the device's local date rather than the UTC date", () => {
		const justAfterMidnight = new Date(2026, 10, 7, 0, 30, 5).getTime()
		expect(formatLocalPosting(justAfterMidnight)).toEqual({
			posting_date: "2026-11-07",
			posting_time: "00:30:05",
		})
	})
})

describe("withOfflinePosting", () => {
	const soldAt = new Date(2026, 10, 1, 18, 4, 12).getTime()

	it("pins the sale time so a later sync keeps the original date", () => {
		const result = withOfflinePosting({ doctype: "Sales Invoice" }, soldAt)
		expect(result).toMatchObject({
			posting_date: "2026-11-01",
			posting_time: "18:04:12",
			set_posting_time: 1,
		})
	})

	it("treats a queue row without a doctype as a Sales Invoice", () => {
		expect(withOfflinePosting({}, soldAt).set_posting_time).toBe(1)
	})

	it("does not restamp an invoice when it is synced", () => {
		const stamped = withOfflinePosting({ doctype: "Sales Invoice" }, soldAt)
		const later = withOfflinePosting(stamped, soldAt + 86_400_000)
		expect(later.posting_date).toBe("2026-11-01")
	})

	it("leaves Sales Orders alone", () => {
		const order = { doctype: "Sales Order" }
		expect(withOfflinePosting(order, soldAt)).toBe(order)
	})
})

describe("getSaleSignature", () => {
	const sale = {
		customer: "Walk-in",
		discount_amount: 5,
		items: [{ item_code: "A", qty: 1, rate: 10, uom: "Nos" }],
		payments: [{ mode_of_payment: "Cash", amount: 5 }],
	}

	it("matches for a retry of the same cart", () => {
		expect(getSaleSignature({ ...sale })).toBe(getSaleSignature(sale))
	})

	it("changes when the quantity, discount, or payment changes", () => {
		const base = getSaleSignature(sale)
		expect(getSaleSignature({ ...sale, items: [{ ...sale.items[0], qty: 2 }] })).not.toBe(base)
		expect(getSaleSignature({ ...sale, discount_amount: 0 })).not.toBe(base)
		expect(getSaleSignature({ ...sale, payments: [] })).not.toBe(base)
	})
})

describe("supportsOfflineId", () => {
	it("covers invoices but not Sales Orders", () => {
		expect(supportsOfflineId("Sales Invoice")).toBe(true)
		expect(supportsOfflineId("POS Invoice")).toBe(true)
		expect(supportsOfflineId("Sales Order")).toBe(false)
	})
})

describe("isNetworkFailure", () => {
	it("detects a dropped connection", () => {
		expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true)
	})

	it("detects gateway errors, where the outcome is unknown", () => {
		expect(isNetworkFailure({ httpStatus: 504 })).toBe(true)
	})

	it("does not treat application errors as network failures", () => {
		expect(isNetworkFailure({ httpStatus: 417, exc_type: "ValidationError" })).toBe(false)
		expect(isNetworkFailure({ exc_type: "NegativeStockError", message: "x" })).toBe(false)
		expect(isNetworkFailure({ httpStatus: 500 })).toBe(false)
		expect(isNetworkFailure(new Error("Invalid server response"))).toBe(false)
	})
})

describe("classifySyncError", () => {
	it("pauses the queue for connection and session problems", () => {
		expect(classifySyncError(new TypeError("Failed to fetch"))).toBe("network")
		expect(classifySyncError({ httpStatus: 401 })).toBe("auth")
		expect(classifySyncError({ exc_type: "SessionExpired" })).toBe("auth")
	})

	it("charges business errors to the invoice", () => {
		expect(classifySyncError({ httpStatus: 417, exc_type: "ValidationError" })).toBe("invoice")
		expect(classifySyncError({ httpStatus: 403, exc_type: "PermissionError" })).toBe("invoice")
	})
})

describe("sumQueuedStock", () => {
	const row = (items, doctype = "Sales Invoice") => ({ data: { doctype, items } })

	it("converts to stock units and adds up across invoices", () => {
		const totals = sumQueuedStock([
			row([{ item_code: "A", qty: 2, conversion_factor: 12, warehouse: "W1" }]),
			row([{ item_code: "A", qty: 1, warehouse: "W1" }]),
		])
		expect(totals.get("A")).toBe(25)
	})

	it("only counts the given warehouse", () => {
		const totals = sumQueuedStock(
			[row([{ item_code: "A", qty: 2, warehouse: "W2" }])],
			"W1",
		)
		expect(totals.has("A")).toBe(false)
	})

	it("ignores Sales Orders, which do not move stock", () => {
		const totals = sumQueuedStock([row([{ item_code: "A", qty: 2 }], "Sales Order")])
		expect(totals.size).toBe(0)
	})
})

describe("getShiftCloseDecision", () => {
	it("allows closing with an empty queue", () => {
		expect(getShiftCloseDecision([], true)).toBe("allow")
	})

	it("blocks while sales can still sync", () => {
		expect(getShiftCloseDecision([{ retry_count: 0 }], false)).toBe("block")
		expect(getShiftCloseDecision([{ sync_failed: true }, {}], false)).toBe("block")
	})

	it("blocks while offline, even for failed invoices", () => {
		expect(getShiftCloseDecision([{ sync_failed: true }], true)).toBe("block")
	})

	it("asks for a decision when only failed invoices remain", () => {
		expect(getShiftCloseDecision([{ sync_failed: true }], false)).toBe("confirm")
	})
})
