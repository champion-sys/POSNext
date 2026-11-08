import { describe, expect, it, vi } from "vitest"
import frappeCall from "../../../../node_modules/frappe-ui/src/utils/call.js"
import {
	buildSyncEnvelope,
	classifySyncError,
	formatLocalPosting,
	getQueueUpdateForResult,
	getRetryDelayMs,
	getQueuedEditBlocker,
	getSaleSignature,
	getShiftCloseDecision,
	isVoidPending,
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

	describe("when the server took the request for a Guest", () => {
		// Frappe's message after msgprint has cleaned it, which drops its <details> markup
		const refusal = (message) => ({ status: 403, exc_type: "PermissionError", messages: [message] })
		const ENGLISH =
			"You are not permitted to access this resource. Login to accessFunction <strong>pos_next.api.sync.push</strong> is not whitelisted."
		const ARABIC =
			"لا يُسمح لك بالوصول إلى هذا المورد. سجّل الدخول للوصول إليه.الدالة <strong>pos_next.api.sync.push</strong> غير مدرجة في القائمة البيضاء."

		it("pauses the queue, in whatever language the refusal came", () => {
			expect(classifySyncError(refusal(ENGLISH))).toBe("auth")
			expect(classifySyncError(refusal(ARABIC))).toBe("auth")
		})

		it("recognizes the error frappe-ui builds from the response", async () => {
			const body = {
				exc_type: "PermissionError",
				_server_messages: JSON.stringify([
					JSON.stringify({ message: ARABIC, title: "Method Not Allowed", indicator: "red", raise_exception: 1 }),
				]),
			}
			vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 403 })))

			const error = await frappeCall("pos_next.api.sync.push", {}).catch((failure) => failure)
			vi.unstubAllGlobals()

			expect(classifySyncError(error)).toBe("auth")
		})

		it("still charges a cashier's own refusal to the invoice", () => {
			expect(classifySyncError(refusal("You are not assigned to a POS Profile"))).toBe("invoice")
			expect(classifySyncError(refusal("No permission for <strong>Sales Invoice</strong>"))).toBe("invoice")
			expect(classifySyncError(refusal("Cannot read <strong>ACC-SINV.2026.00001</strong>"))).toBe("invoice")
		})

		it("needs the permission error, not just the wording", () => {
			expect(
				classifySyncError({ status: 417, exc_type: "ValidationError", messages: [ENGLISH] }),
			).toBe("invoice")
		})
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

describe("a void request", () => {
	const items = [{ item_code: "A", qty: 2 }]

	it("holds no stock while it waits", () => {
		expect(sumQueuedStock([{ void_reason: "Wrong sale", data: { items } }]).size).toBe(0)
	})

	it("holds no stock once the server has refused it either", () => {
		const stands = { void_reason: "Wrong sale", server_status: "sale_stands", data: { items } }
		expect(sumQueuedStock([stands]).size).toBe(0)
	})

	it("is pending until the server answers", () => {
		expect(isVoidPending({ void_reason: "Wrong sale" })).toBe(true)
		expect(isVoidPending({ void_reason: "Wrong sale", server_status: "received" })).toBe(true)
	})

	it("is over when the server answers", () => {
		expect(isVoidPending({ void_reason: "Wrong sale", server_status: "sale_stands" })).toBe(false)
		expect(isVoidPending({ void_reason: "Wrong sale", synced: true })).toBe(false)
	})

	it("is nothing on a record no one asked to void", () => {
		expect(isVoidPending({})).toBe(false)
		expect(isVoidPending(undefined)).toBe(false)
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

	it("waits for a void the server has not answered, which may still turn out to be a sale", () => {
		expect(getShiftCloseDecision([{ void_reason: "Wrong sale" }], false)).toBe("block")
	})

	it("waits for a cashier to see that a void came too late, because the money may have moved", () => {
		const stands = { void_reason: "Wrong sale", server_status: "sale_stands" }
		expect(getShiftCloseDecision([stands], false)).toBe("block")
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

	it("carries a void request's reason with the record it is about", () => {
		const envelope = buildSyncEnvelope({ id: 7, void_reason: "Wrong sale" }, payload)

		expect(envelope.void_reason).toBe("Wrong sale")
		expect(envelope.payload).toBe(payload)
	})

	it("leaves the field out of any other record, because the server reads it as a request", () => {
		expect(buildSyncEnvelope({ id: 7, void_reason: null }, payload)).not.toHaveProperty("void_reason")
	})

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

	it("carries the rounded total the cashier collected, for the server's total check", () => {
		const rounded = { ...payload, grand_total: 11.5, rounded_total: 12, payments: [{ amount: 12 }] }
		expect(buildSyncEnvelope({ id: 8 }, rounded).client_totals).toEqual({
			grand_total: 11.5,
			rounded_total: 12,
			paid: 12,
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

	it("keeps a sale whose void came too late in sight, with its number", () => {
		expect(getQueueUpdateForResult({ status: "sale_stands", invoice: "SINV-1" })).toEqual({
			server_status: "sale_stands",
			server_invoice: "SINV-1",
			sync_failed: false,
			error: null,
		})
	})

	it("leaves the row alone for a void the server has not settled", () => {
		expect(getQueueUpdateForResult({ status: "void_pending" })).toBeNull()
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

	// Its original may have reached the server unanswered, and only the queue carries edited_from
	it("queues an edit of a queued sale in realtime mode too", () => {
		expect(shouldQueueCheckout({ ...sale, mode: SYNC_REALTIME, editsQueuedSale: true })).toBe(true)
	})
})

describe("getQueuedEditBlocker", () => {
	const sale = { doctype: "Sales Invoice", usesCustomerCredit: false, usesGiftCard: false }

	it("lets an ordinary payment through", () => {
		expect(getQueuedEditBlocker(sale)).toBeNull()
	})

	it("refuses what the queue cannot carry", () => {
		expect(getQueuedEditBlocker({ ...sale, usesCustomerCredit: true })).toBe("customer_credit")
		expect(getQueuedEditBlocker({ ...sale, usesGiftCard: true })).toBe("gift_card")
		expect(getQueuedEditBlocker({ ...sale, doctype: "Sales Order" })).toBe("doctype")
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
