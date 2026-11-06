import { describe, expect, it } from "vitest"
import {
	applyQueuedPayments,
	buildCustomerPayload,
	buildLocalCustomer,
	buildPaymentPayload,
	countQueuedCouponUses,
	ENTITY_CUSTOMER,
	ENTITY_INVOICE,
	ENTITY_PAYMENT,
	exceedsOutstanding,
	getCachedCouponProblem,
	getDependentRows,
	getEntity,
	getInvoiceDependencies,
	isLocalName,
	sumQueuedPayments,
} from "../entities"
import { buildSyncEnvelope, shouldQueueCheckout, SYNC_REALTIME, sumQueuedStock } from "../invoicePayload"

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
