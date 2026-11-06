import { describe, expect, it, vi } from "vitest"
import {
	buildSyncEnvelope,
	classifySyncError,
	formatLocalPosting,
	getQueueUpdateForResult,
	getRetryDelayMs,
	getSaleSignature,
	getShiftCloseDecision,
	isNetworkFailure,
	shouldQueueCheckout,
	sumQueuedStock,
	getCheckoutDeadline,
	supportsOfflineId,
	SYNC_AFTER_PAYMENT,
	SYNC_PERIODIC,
	SYNC_REALTIME,
	withDeadline,
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

describe("getCheckoutDeadline", () => {
	it("gives up on a sale the server can dedupe", () => {
		expect(getCheckoutDeadline("Sales Invoice", 8000, 1000)).toBe(9000)
		expect(getCheckoutDeadline("POS Invoice", 8000, 1000)).toBe(9000)
	})

	it("waits for a Sales Order, which a second request would duplicate", () => {
		expect(getCheckoutDeadline("Sales Order", 8000, 1000)).toBeNull()
	})

	it("waits when no timeout is set", () => {
		expect(getCheckoutDeadline("Sales Invoice", 0, 1000)).toBeNull()
		expect(getCheckoutDeadline("Sales Invoice", undefined, 1000)).toBeNull()
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

describe("buildSyncEnvelope", () => {
	const payload = {
		offline_id: "pos_offline_1",
		pos_profile: "Main",
		cashier: "a@example.com",
		grand_total: 115,
		payments: [{ amount: 100 }, { amount: "15" }],
	}

	it("carries what the server needs to store the sale", () => {
		const soldAt = Date.UTC(2026, 10, 1, 15, 4, 12)
		expect(buildSyncEnvelope({ id: 7, timestamp: soldAt }, payload)).toMatchObject({
			offline_id: "pos_offline_1",
			seq: 7,
			cashier: "a@example.com",
			pos_profile: "Main",
			created_at_device: "2026-11-01T15:04:12.000Z",
			client_totals: { grand_total: 115, paid: 115 },
			payload,
		})
	})
})

describe("getQueueUpdateForResult", () => {
	it("finishes the row when the invoice exists", () => {
		expect(getQueueUpdateForResult({ status: "synced", invoice: "SINV-1" })).toMatchObject({
			synced: true,
			server_invoice: "SINV-1",
		})
		expect(getQueueUpdateForResult({ status: "duplicate" }).synced).toBe(true)
	})

	it("finishes a voided sale without an invoice", () => {
		expect(getQueueUpdateForResult({ status: "voided" })).toMatchObject({ synced: true, server_status: "voided" })
	})

	it("keeps a sale the server is still working on", () => {
		const update = getQueueUpdateForResult({ status: "received" })
		expect(update.synced).toBeUndefined()
		expect(update.server_status).toBe("received")
	})

	it("flags a sale that needs a manager", () => {
		expect(getQueueUpdateForResult({ status: "needs_review", message: "Stock" })).toMatchObject({
			server_status: "needs_review",
			sync_failed: true,
			error: "Stock",
		})
		expect(getQueueUpdateForResult({ status: "conflict" }).sync_failed).toBe(true)
	})

	it("leaves the row alone for a status it does not know", () => {
		expect(getQueueUpdateForResult({ status: "rejected" })).toBeNull()
	})
})

describe("getRetryDelayMs", () => {
	const middle = () => 0.5

	it("waits longer after each failure", () => {
		expect(getRetryDelayMs(1, middle)).toBe(15000)
		expect(getRetryDelayMs(2, middle)).toBe(45000)
	})

	it("stops growing at 30 minutes", () => {
		expect(getRetryDelayMs(20, middle)).toBe(30 * 60 * 1000)
	})

	it("spreads devices apart", () => {
		expect(getRetryDelayMs(1, () => 0)).toBe(10500)
		expect(getRetryDelayMs(1, () => 1)).toBe(19500)
	})
})

describe("shouldQueueCheckout", () => {
	const sale = { doctype: "Sales Invoice", usesCustomerCredit: false }

	it("waits for the server in realtime mode", () => {
		expect(shouldQueueCheckout({ ...sale, mode: SYNC_REALTIME })).toBe(false)
	})

	it("queues in the other modes", () => {
		expect(shouldQueueCheckout({ ...sale, mode: SYNC_AFTER_PAYMENT })).toBe(true)
		expect(shouldQueueCheckout({ ...sale, mode: SYNC_PERIODIC })).toBe(true)
	})

	it("keeps Sales Orders and customer credit on the server", () => {
		expect(shouldQueueCheckout({ mode: SYNC_PERIODIC, doctype: "Sales Order", usesCustomerCredit: false })).toBe(false)
		expect(shouldQueueCheckout({ ...sale, mode: SYNC_PERIODIC, usesCustomerCredit: true })).toBe(false)
	})
})

describe("withDeadline", () => {
	it("passes the result through", async () => {
		await expect(withDeadline(Promise.resolve("ok"), Date.now() + 1000)).resolves.toBe("ok")
	})

	it("waits forever without a deadline", () => {
		const promise = Promise.resolve("ok")
		expect(withDeadline(promise, null)).toBe(promise)
	})

	it("gives up as a network failure, so the sale moves to the queue", async () => {
		vi.useFakeTimers()
		const pending = withDeadline(new Promise(() => {}), Date.now() + 3000)
		const assertion = pending.catch((error) => error)
		await vi.advanceTimersByTimeAsync(3000)
		const error = await assertion
		vi.useRealTimers()

		expect(error.name).toBe("AbortError")
		expect(isNetworkFailure(error)).toBe(true)
	})

	it("ignores a request that fails after the deadline", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)

		let fail
		const request = new Promise((_, reject) => {
			fail = reject
		})
		await withDeadline(request, Date.now()).catch(() => {})
		fail(new Error("late"))
		await new Promise((resolve) => setTimeout(resolve, 10))

		process.off("unhandledRejection", unhandled)
		expect(unhandled).not.toHaveBeenCalled()
	})
})
