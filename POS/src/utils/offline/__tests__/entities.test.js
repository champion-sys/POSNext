import { describe, expect, it } from "vitest"
import {
	applyQueuedPayments,
	buildCustomerPayload,
	buildLocalCustomer,
	buildClosingDraft,
	buildPaymentPayload,
	buildReturnDocFromQueue,
	buildShiftClosePayload,
	checkReturnValidity,
	countQueuedCouponUses,
	ENTITY_CUSTOMER,
	ENTITY_INVOICE,
	ENTITY_PAYMENT,
	ENTITY_SHIFT_CLOSE,
	exceedsOutstanding,
	getCachedCouponProblem,
	getDependentRows,
	getEntity,
	getInvoiceDependencies,
	getShiftManifest,
	hasOnlineOnlyPayment,
	isLocalName,
	isReturnableQueueRow,
	subtractQueuedReturns,
	sumQueuedPayments,
} from "../entities"
import {
	buildSyncEnvelope,
	getShiftCloseDecision,
	shouldQueueCheckout,
	SYNC_REALTIME,
	sumQueuedStock,
} from "../invoicePayload"

const LOCAL_CUSTOMER = "pos_offline_customer-1"
const LOCAL_INVOICE = "pos_offline_invoice-1"

describe("isLocalName", () => {
	it("recognises only names given by a device", () => {
		expect(isLocalName(LOCAL_CUSTOMER)).toBe(true)
		expect(isLocalName("CUST-0001")).toBe(false)
		expect(isLocalName(null)).toBe(false)
		expect(isLocalName({ name: LOCAL_CUSTOMER })).toBe(false)
	})
})

describe("getEntity", () => {
	it("treats rows from before the outbox as sales", () => {
		expect(getEntity({})).toBe(ENTITY_INVOICE)
		expect(getEntity({ entity: ENTITY_CUSTOMER })).toBe(ENTITY_CUSTOMER)
	})
})

describe("getInvoiceDependencies", () => {
	it("lists a customer still in the queue", () => {
		expect(getInvoiceDependencies({ customer: LOCAL_CUSTOMER })).toEqual([LOCAL_CUSTOMER])
	})

	it("needs nothing for a customer the server knows", () => {
		expect(getInvoiceDependencies({ customer: "CUST-0001" })).toEqual([])
	})

	it("makes a return wait for its invoice and that invoice's customer", () => {
		expect(getInvoiceDependencies({ customer: LOCAL_CUSTOMER, return_against: LOCAL_INVOICE })).toEqual([
			LOCAL_CUSTOMER,
			LOCAL_INVOICE,
		])
	})
})

describe("getDependentRows", () => {
	it("finds the rows that would wait forever without this one", () => {
		const invoice = { offline_id: "a", depends_on: [LOCAL_CUSTOMER] }
		const other = { offline_id: "b", depends_on: [] }
		const legacy = { offline_id: "c" }
		expect(getDependentRows([invoice, other, legacy], LOCAL_CUSTOMER)).toEqual([invoice])
	})
})

describe("customers", () => {
	const form = { customer_name: "Sara", mobile_no: "+966-5", customer_group: "Individual", territory: "All" }
	const payload = buildCustomerPayload(form, {
		offlineId: LOCAL_CUSTOMER,
		posProfile: "Main",
		company: "ACME",
		cashier: "cashier@example.com",
	})

	it("carries what the server needs to create and attribute it", () => {
		expect(payload).toMatchObject({
			doctype: "Customer",
			offline_id: LOCAL_CUSTOMER,
			customer_name: "Sara",
			pos_profile: "Main",
			company: "ACME",
			cashier: "cashier@example.com",
		})
	})

	it("uses the queue id as the name the sale carries", () => {
		expect(buildLocalCustomer(payload)).toMatchObject({ name: LOCAL_CUSTOMER, customer_name: "Sara", is_local: 1 })
	})

	it("wraps in an envelope with its entity", () => {
		const envelope = buildSyncEnvelope({ id: 3, entity: ENTITY_CUSTOMER }, payload)
		expect(envelope).toMatchObject({ entity: ENTITY_CUSTOMER, offline_id: LOCAL_CUSTOMER, pos_profile: "Main" })
		expect(envelope.depends_on).toEqual([])
	})

	it("holds no stock", () => {
		expect(sumQueuedStock([{ entity: ENTITY_CUSTOMER, data: payload }]).size).toBe(0)
	})
})

describe("payments", () => {
	const invoice = { name: "SINV-1", customer: "CUST-0001", outstanding_amount: 100, paid_amount: 50 }
	const queued = (amount) => ({
		entity: ENTITY_PAYMENT,
		data: { invoice_name: "SINV-1", payments: [{ mode_of_payment: "Cash", amount }] },
	})

	it("records when and in which shift the money was taken", () => {
		const payload = buildPaymentPayload({
			invoice,
			payments: [{ mode_of_payment: "Cash", amount: 30, type: "Cash" }],
			posProfile: "Main",
			shift: "POSA-OS-1",
			cashier: "cashier@example.com",
			timestamp: new Date(2026, 10, 5, 9, 30, 0).getTime(),
		})
		expect(payload).toMatchObject({
			doctype: "Payment Entry",
			invoice_name: "SINV-1",
			pos_profile: "Main",
			posa_pos_opening_shift: "POSA-OS-1",
			posting_date: "2026-11-05",
		})
		expect(payload.payments).toEqual([{ mode_of_payment: "Cash", amount: 30 }])
	})

	it("drops empty rows so they do not become Payment Entries", () => {
		const { payments } = buildPaymentPayload({
			invoice,
			payments: [
				{ mode_of_payment: "Cash", amount: 30 },
				{ mode_of_payment: "Card", amount: 0 },
			],
		})
		expect(payments).toHaveLength(1)
	})

	it("adds up what is waiting per invoice", () => {
		expect(sumQueuedPayments([queued(30), queued(20), { entity: ENTITY_CUSTOMER, data: {} }])).toEqual(
			new Map([["SINV-1", 50]]),
		)
	})

	it("shows the invoice as it will be after the queue", () => {
		const [shown] = applyQueuedPayments([invoice], [queued(30)])
		expect(shown).toMatchObject({ outstanding_amount: 70, paid_amount: 80, queued_payment: 30 })
	})

	it("leaves invoices with nothing waiting alone", () => {
		expect(applyQueuedPayments([invoice], [])[0]).toBe(invoice)
	})

	it("never shows a negative outstanding amount", () => {
		expect(applyQueuedPayments([invoice], [queued(150)])[0].outstanding_amount).toBe(0)
	})

	it("refuses a second payment over what is left", () => {
		const [shown] = applyQueuedPayments([invoice], [queued(80)])
		expect(exceedsOutstanding(shown, [{ amount: 30 }])).toBe(true)
		expect(exceedsOutstanding(shown, [{ amount: 20 }])).toBe(false)
	})

	it("tolerates a rounding difference like the server does", () => {
		expect(exceedsOutstanding(invoice, [{ amount: 100.01 }])).toBe(false)
		expect(exceedsOutstanding(invoice, [{ amount: 100.02 }])).toBe(true)
	})
})

describe("cached coupons", () => {
	const coupon = {
		coupon_code: "SAVE10",
		coupon_type: "Promotional",
		company: "ACME",
		maximum_use: 5,
		used: 2,
	}
	const context = { customer: "CUST-0001", company: "ACME", today: "2026-11-06" }

	it("accepts a coupon within its limits", () => {
		expect(getCachedCouponProblem(coupon, context)).toBeNull()
	})

	it("refuses what the cache does not hold, like a gift card", () => {
		expect(getCachedCouponProblem(undefined, context)).toBe("not_found")
	})

	it("refuses a coupon of another company", () => {
		expect(getCachedCouponProblem({ ...coupon, company: "Other" }, context)).toBe("not_found")
	})

	it("counts this device's queue against the limit", () => {
		expect(getCachedCouponProblem(coupon, { ...context, total: 2 })).toBeNull()
		expect(getCachedCouponProblem(coupon, { ...context, total: 3 })).toBe("limit")
	})

	it("treats no limit as no limit", () => {
		expect(getCachedCouponProblem({ ...coupon, maximum_use: 0, used: 900 }, context)).toBeNull()
	})

	it("checks the dates", () => {
		expect(getCachedCouponProblem({ ...coupon, valid_from: "2026-11-07" }, context)).toBe("not_started")
		expect(getCachedCouponProblem({ ...coupon, valid_upto: "2026-11-05" }, context)).toBe("expired")
		expect(getCachedCouponProblem({ ...coupon, valid_upto: "2026-11-06" }, context)).toBeNull()
	})

	it("checks who the coupon is for", () => {
		expect(getCachedCouponProblem({ ...coupon, customer: "CUST-0002" }, context)).toBe("customer")
	})

	it("stops a customer using a one-use coupon twice on this device", () => {
		expect(getCachedCouponProblem({ ...coupon, one_use: 1 }, { ...context, forCustomer: 1 })).toBe("one_use")
	})

	it("counts only sales with that code, in any case", () => {
		const rows = [
			{ entity: ENTITY_INVOICE, data: { coupon_code: "save10", customer: "CUST-0001" } },
			{ data: { coupon_code: "SAVE10", customer: "CUST-0002" } },
			{ data: { coupon_code: "OTHER", customer: "CUST-0001" } },
			{ entity: ENTITY_PAYMENT, data: { coupon_code: "SAVE10" } },
		]
		expect(countQueuedCouponUses(rows, "SAVE10", "CUST-0001")).toEqual({ total: 2, forCustomer: 1 })
	})
})

describe("checkReturnValidity", () => {
	const doc = (rules, postingDate = "2026-11-01") => ({
		return_against: "SINV-1",
		_return_rules: rules,
		_original_invoice: { posting_date: postingDate },
	})

	it("allows a return within the period", () => {
		expect(checkReturnValidity(doc({ allow_return: 1, return_validity_days: 7 }), "2026-11-08")).toEqual({
			valid: true,
		})
	})

	it("refuses a return past the period, with what the dialog shows", () => {
		expect(checkReturnValidity(doc({ allow_return: 1, return_validity_days: 7 }), "2026-11-09")).toEqual({
			valid: false,
			error_type: "return_period_expired",
			invoice_name: "SINV-1",
			invoice_date: "2026-11-01",
			days_since: 8,
			allowed_days: 7,
		})
	})

	it("treats zero days as no limit", () => {
		expect(checkReturnValidity(doc({ allow_return: 1, return_validity_days: 0 }), "2030-01-01").valid).toBe(true)
	})

	it("refuses when the invoice's profile does not allow returns", () => {
		expect(checkReturnValidity(doc({ allow_return: 0 }), "2026-11-02")).toEqual({
			valid: false,
			error_type: "return_not_allowed",
		})
	})
})

describe("subtractQueuedReturns", () => {
	const doc = {
		return_against: "SINV-1",
		_cached_at: 1000,
		items: [
			{ item_code: "A", sales_invoice_item: "row-a", remaining_qty: 3, already_returned: 1 },
			{ item_code: "B", sales_invoice_item: "row-b", remaining_qty: 2 },
		],
	}
	const returnRow = (values) => ({
		timestamp: 2000,
		data: {
			is_return: 1,
			return_against: "SINV-1",
			items: [{ item_code: "A", sales_invoice_item: "row-a", qty: -2 }],
		},
		...values,
	})

	it("takes a queued return off what can still be returned", () => {
		const [itemA, itemB] = subtractQueuedReturns(doc, [returnRow()]).items
		expect(itemA).toMatchObject({ remaining_qty: 1, already_returned: 3 })
		expect(itemB.remaining_qty).toBe(2)
	})

	it("adds up several returns and stops at zero", () => {
		const [itemA] = subtractQueuedReturns(doc, [returnRow(), returnRow()]).items
		expect(itemA.remaining_qty).toBe(0)
	})

	it("ignores returns of other invoices and sales", () => {
		const other = returnRow()
		other.data.return_against = "SINV-2"
		const sale = { data: { return_against: "SINV-1", items: [{ sales_invoice_item: "row-a", qty: 5 }] } }
		expect(subtractQueuedReturns(doc, [other, sale]).items[0].remaining_qty).toBe(3)
	})

	it("does not count a synced return twice when the kept document already has it", () => {
		const before = returnRow({ synced: true, timestamp: 500 })
		const after = returnRow({ synced: true, timestamp: 1500 })
		expect(subtractQueuedReturns(doc, [before]).items[0].remaining_qty).toBe(3)
		expect(subtractQueuedReturns(doc, [after]).items[0].remaining_qty).toBe(1)
	})

	it("counts a return made before its sale got a server name", () => {
		const sale = { return_against: "SINV-9", _offline_id: LOCAL_INVOICE, items: [{ item_code: "A", original_idx: 1, remaining_qty: 3 }] }
		const row = {
			data: { is_return: 1, return_against: LOCAL_INVOICE, items: [{ item_code: "A", original_idx: 1, qty: -1 }] },
		}
		expect(subtractQueuedReturns(sale, [row]).items[0].remaining_qty).toBe(2)
	})

	it("matches rows of a sale still in the queue by position", () => {
		const queued = {
			return_against: LOCAL_INVOICE,
			items: [
				{ item_code: "A", original_idx: 1, remaining_qty: 2 },
				{ item_code: "A", original_idx: 2, remaining_qty: 2 },
			],
		}
		const row = {
			data: {
				is_return: 1,
				return_against: LOCAL_INVOICE,
				items: [{ item_code: "A", original_idx: 2, qty: -2 }],
			},
		}
		const [first, second] = subtractQueuedReturns(queued, [row]).items
		expect(first.remaining_qty).toBe(2)
		expect(second.remaining_qty).toBe(0)
	})
})

describe("isReturnableQueueRow", () => {
	const sale = { offline_id: LOCAL_INVOICE, data: { doctype: "Sales Invoice" } }

	it("accepts a sale in the queue", () => {
		expect(isReturnableQueueRow(sale)).toBe(true)
	})

	it("refuses anything that may never post, or is not a sale", () => {
		expect(isReturnableQueueRow({ ...sale, sync_failed: true })).toBe(false)
		expect(isReturnableQueueRow({ ...sale, superseded: true })).toBe(false)
		expect(isReturnableQueueRow({ ...sale, server_status: "voided" })).toBe(false)
		expect(isReturnableQueueRow({ data: { is_return: 1 } })).toBe(false)
		expect(isReturnableQueueRow({ data: { doctype: "Sales Order" } })).toBe(false)
		expect(isReturnableQueueRow({ entity: ENTITY_CUSTOMER, data: {} })).toBe(false)
	})
})

describe("buildReturnDocFromQueue", () => {
	const rules = { allow_return: 1, return_validity_days: 7 }
	const row = {
		offline_id: LOCAL_INVOICE,
		data: {
			doctype: "Sales Invoice",
			customer: LOCAL_CUSTOMER,
			customer_name: "Sara",
			company: "ACME",
			posting_date: "2026-11-05",
			grand_total: 115,
			change_amount: 5,
			payments: [{ mode_of_payment: "Cash", amount: 120 }],
			items: [
				{ item_code: "A", qty: 2, rate: 25, uom: "Nos", warehouse: "Stores", conversion_factor: 1 },
				{ item_code: "B", qty: 1, rate: 50, uom: "Nos", warehouse: "Stores" },
			],
		},
	}

	it("returns against the queue record until the sale has a server name", () => {
		expect(buildReturnDocFromQueue(row, rules).return_against).toBe(LOCAL_INVOICE)
		expect(buildReturnDocFromQueue({ ...row, server_invoice: "SINV-9" }, rules).return_against).toBe("SINV-9")
	})

	it("works out what was paid, leaving out the change", () => {
		expect(buildReturnDocFromQueue(row, rules)._original_invoice).toMatchObject({
			paid_amount: 115,
			outstanding_amount: 0,
		})
	})

	it("spreads tax and invoice discounts over the unit price", () => {
		const [first] = buildReturnDocFromQueue(row, rules).items
		expect(first.rate).toBe(25)
		expect(first.rate_with_tax).toBe(28.75)
	})

	it("remembers each row's position, for the server to find it", () => {
		expect(buildReturnDocFromQueue(row, rules).items.map((item) => item.original_idx)).toEqual([1, 2])
	})

	it("depends on the sale and on its customer", () => {
		const doc = buildReturnDocFromQueue(row, rules)
		expect(getInvoiceDependencies({ customer: doc.customer, return_against: doc.return_against })).toEqual([
			LOCAL_CUSTOMER,
			LOCAL_INVOICE,
		])
	})

	it("works out an unpaid sale as outstanding", () => {
		const unpaid = { ...row, data: { ...row.data, payments: [], change_amount: 0 } }
		expect(buildReturnDocFromQueue(unpaid, rules)._original_invoice.outstanding_amount).toBe(115)
	})
})

describe("sumQueuedStock with a return", () => {
	it("gives the returned units back", () => {
		const sale = { data: { items: [{ item_code: "A", qty: 3 }] } }
		const refund = { data: { is_return: 1, items: [{ item_code: "A", qty: -1 }] } }
		expect(sumQueuedStock([sale, refund]).get("A")).toBe(2)
	})
})

describe("hasOnlineOnlyPayment", () => {
	const wallets = new Set(["Wallet"])

	it("finds customer credit and wallets", () => {
		expect(hasOnlineOnlyPayment([{ mode_of_payment: "Customer Credit", is_customer_credit: true }], wallets)).toBe(true)
		expect(hasOnlineOnlyPayment([{ mode_of_payment: "Cash" }, { mode_of_payment: "Wallet" }], wallets)).toBe(true)
	})

	it("lets ordinary payments through", () => {
		expect(hasOnlineOnlyPayment([{ mode_of_payment: "Cash" }], wallets)).toBe(false)
		expect(hasOnlineOnlyPayment([], wallets)).toBe(false)
	})
})

describe("shift close", () => {
	const SHIFT = "POSA-OS-1"
	const opening = {
		name: SHIFT,
		pos_profile: "Main",
		company: "ACME",
		user: "cashier@example.com",
		period_start_date: "2026-11-05 08:00:00",
		balance_details: [{ mode_of_payment: "Cash", amount: 100 }],
	}
	const methods = [
		{ mode_of_payment: "Cash" },
		{ mode_of_payment: "Card" },
		{ mode_of_payment: "Wallet", is_wallet_payment: 1 },
	]

	it("asks for a count of every mode, but not of a wallet", () => {
		const draft = buildClosingDraft(opening, methods)
		expect(draft.payment_reconciliation.map((row) => row.mode_of_payment)).toEqual(["Cash", "Card"])
		expect(draft.pos_opening_shift).toBe(SHIFT)
	})

	it("lists everything of the shift that went through the queue", () => {
		const rows = [
			{ offline_id: "sale", data: { posa_pos_opening_shift: SHIFT } },
			{ offline_id: "sold-and-synced", synced: true, data: { posa_pos_opening_shift: SHIFT } },
			{ offline_id: "payment", entity: ENTITY_PAYMENT, data: { posa_pos_opening_shift: SHIFT } },
			{ offline_id: "edited-away", superseded: true, data: { posa_pos_opening_shift: SHIFT } },
			{ offline_id: "other-shift", data: { posa_pos_opening_shift: "POSA-OS-0" } },
			{ offline_id: "customer", entity: ENTITY_CUSTOMER, data: {} },
		]
		expect(getShiftManifest(rows, SHIFT)).toEqual(["sale", "sold-and-synced", "payment"])
	})

	it("does not list itself", () => {
		const row = { offline_id: "close", entity: ENTITY_SHIFT_CLOSE, data: { posa_pos_opening_shift: SHIFT } }
		expect(getShiftManifest([row], SHIFT)).toEqual([])
	})

	it("sends only what was counted, and when", () => {
		const closing = buildClosingDraft(opening, methods)
		closing.payment_reconciliation[0].closing_amount = "480.50"
		closing.payment_reconciliation[0].expected_amount = 999

		const payload = buildShiftClosePayload({
			closing,
			manifest: ["sale"],
			cashier: "cashier@example.com",
			timestamp: new Date(2026, 10, 5, 22, 10, 0).getTime(),
		})

		expect(payload).toMatchObject({
			doctype: "POS Closing Shift",
			pos_opening_shift: SHIFT,
			pos_profile: "Main",
			posting_date: "2026-11-05",
			period_end_date: "2026-11-05 22:10:00",
			manifest: ["sale"],
		})
		expect(payload.closing_amounts).toEqual([
			{ mode_of_payment: "Cash", closing_amount: 480.5 },
			{ mode_of_payment: "Card", closing_amount: 0 },
		])
	})

	it("waits behind the sales in its envelope", () => {
		const envelope = buildSyncEnvelope(
			{ id: 9, entity: ENTITY_SHIFT_CLOSE, depends_on: ["sale"] },
			{ offline_id: "close", pos_profile: "Main" },
		)
		expect(envelope).toMatchObject({ entity: ENTITY_SHIFT_CLOSE, depends_on: ["sale"] })
	})

	it("queues the close offline when the setting allows it", () => {
		expect(getShiftCloseDecision([{ sync_failed: false }], true, true)).toBe("queue")
		expect(getShiftCloseDecision([], true, true)).toBe("queue")
	})

	it("keeps blocking an offline close when it does not", () => {
		expect(getShiftCloseDecision([{ sync_failed: false }], true)).toBe("block")
	})

	it("does not change an online close", () => {
		expect(getShiftCloseDecision([], false, true)).toBe("allow")
		expect(getShiftCloseDecision([{ sync_failed: false }], false, true)).toBe("block")
	})
})

describe("buildSyncEnvelope", () => {
	it("sends what a sale depends on", () => {
		const row = { id: 4, entity: ENTITY_INVOICE, depends_on: [LOCAL_CUSTOMER] }
		expect(buildSyncEnvelope(row, { offline_id: "x", payments: [] }).depends_on).toEqual([LOCAL_CUSTOMER])
	})

	it("treats an older row as a sale with no dependencies", () => {
		expect(buildSyncEnvelope({ id: 5 }, { offline_id: "x", payments: [] })).toMatchObject({
			entity: ENTITY_INVOICE,
			depends_on: [],
		})
	})
})

describe("shouldQueueCheckout with a gift card", () => {
	it("goes straight to the server, because it can only be spent once", () => {
		expect(shouldQueueCheckout({ mode: "After Payment", doctype: "Sales Invoice", usesGiftCard: true })).toBe(false)
	})
})

describe("shouldQueueCheckout with a local customer", () => {
	it("queues the sale even in realtime mode, because the server cannot take it directly", () => {
		expect(
			shouldQueueCheckout({ mode: SYNC_REALTIME, doctype: "Sales Invoice", hasLocalCustomer: true }),
		).toBe(true)
	})
})
