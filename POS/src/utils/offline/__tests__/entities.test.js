import { describe, expect, it } from "vitest"
import {
	buildCustomerPayload,
	buildLocalCustomer,
	ENTITY_CUSTOMER,
	ENTITY_INVOICE,
	getDependentRows,
	getEntity,
	getInvoiceDependencies,
	isLocalName,
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

describe("shouldQueueCheckout with a local customer", () => {
	it("queues the sale even in realtime mode, because the server cannot take it directly", () => {
		expect(
			shouldQueueCheckout({ mode: SYNC_REALTIME, doctype: "Sales Invoice", hasLocalCustomer: true }),
		).toBe(true)
	})
})
