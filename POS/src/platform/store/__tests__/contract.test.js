/**
 * One set of behavior tests, run against every implementation of the local store.
 *
 * The web side runs the real worker and the real worker client, in this process. Only the
 * layer under them is fake: an in-memory Dexie and raw IndexedDB, because fake-indexeddb
 * is not installed. So these tests cannot show that Dexie itself behaves like the fake.
 */
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { createNativeStore } from "@/platform/store/native"
import { createSqlStore } from "@/platform/store/sqlStore"
import { PULL_ENTITIES, pullStateKey, runPull } from "@/core/sync/pullEngine"
import {
	ENTITY_CUSTOMER,
	ENTITY_PAYMENT,
	ENTITY_SHIFT_CLOSE,
	countQueuedCouponUses,
	getDependentRows,
	getShiftManifest,
	isReturnableQueueRow,
	sumQueuedPayments,
} from "@/utils/offline/entities"
import { getQueueUpdateForResult, sumQueuedStock } from "@/utils/offline/invoicePayload"
import { createFakeIndexedDB } from "./fakeIndexedDB"
import { createCapacitorHarness, createElectronHarness, createNodeExecutor } from "./sqliteHarness"

const { FakeDexie, resetFakeDexie } = await vi.hoisted(() => import("./fakeDexie"))

vi.mock("dexie", () => ({ default: FakeDexie }))

const callServer = vi.hoisted(() => vi.fn())
vi.mock("@/utils/apiWrapper", () => ({ call: callServer }))

// frappe-ui does not load under vitest. This keeps what its createResource does: the
// caller gets what transform returned, and onSuccess gets the server's own answer.
vi.mock("frappe-ui", () => ({
	createResource: (options) => ({
		async fetch() {
			try {
				const response = await fetch(`/api/method/${options.url}`)
				const { message } = await response.json()
				const data = options.transform?.(message) ?? message
				options.onSuccess?.(message)
				return data
			} catch (error) {
				options.onError?.(error)
				throw error
			}
		},
	}),
}))

/** Runs offline.worker.js in this process, wired to the real client as a Worker would be */
class InProcessWorker {
	constructor() {
		this.loaded = (async () => {
			self.postMessage = (message) => this.onmessage?.({ data: structuredClone(message) })
			await import("@/workers/offline.worker.js")
		})()
	}

	async postMessage(message) {
		await this.loaded
		await self.onmessage({ data: structuredClone(message) })
	}

	terminate() {}
}

async function openWebStore() {
	resetFakeDexie()
	vi.doUnmock("@/platform/store")
	vi.stubGlobal("Worker", InProcessWorker)
	vi.stubGlobal("indexedDB", createFakeIndexedDB())
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:worker" }))

	const { localStore } = await import("@/platform/store")
	return localStore
}

function sqlImplementation(createExecutor) {
	return async () => {
		const sql = createExecutor()
		await migrate(sql)
		const database = createSqlStore(sql)
		const store = createNativeStore(async () => database)
		vi.doMock("@/platform/store", () => ({ localStore: store }))
		return store
	}
}

const IMPLEMENTATIONS = [
	["web: worker and Dexie", openWebStore],
	["SQLite", sqlImplementation(createNodeExecutor)],
	["SQLite through the Electron executor and host", sqlImplementation(createElectronHarness)],
	["SQLite through the Capacitor executor", sqlImplementation(createCapacitorHarness)],
]

const fetchResponses = new Map()

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url) => {
			const answer = [...fetchResponses].find(([path]) => String(url).includes(path))?.[1]
			const body = answer ?? { message: "pong" }
			return { ok: true, json: async () => body, text: async () => JSON.stringify(body) }
		}),
	)
}

const invoice = (extra = {}) => ({
	doctype: "Sales Invoice",
	customer: "CUST-1",
	posa_pos_opening_shift: "SHIFT-1",
	grand_total: 24,
	items: [{ item_code: "A", qty: 2, conversion_factor: 12, warehouse: "W1" }],
	payments: [{ mode_of_payment: "Cash", amount: 24 }],
	...extra,
})

const item = (code, extra = {}) => ({
	item_code: code,
	item_name: `Item ${code}`,
	item_group: "Group 1",
	...extra,
})

describe.each(IMPLEMENTATIONS)("%s", (_name, openStore) => {
	let store

	beforeEach(async () => {
		vi.resetModules()
		localStorage.clear()
		sessionStorage.clear()
		fetchResponses.clear()
		callServer.mockReset()
		stubFetch()
		store = await openStore()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.doUnmock("@/platform/store")
	})

	describe("the sales queue", () => {
		it("gives back a sale in the shape the app reads", async () => {
			const before = Date.now()
			const { success, id, offline_id } = await store.saveOfflineInvoice(invoice())

			expect(success).toBe(true)
			expect(offline_id).toMatch(/^pos_offline_/)

			const [row] = await store.getOfflineInvoices()
			expect(row.id).toBe(id)
			expect(row.offline_id).toBe(offline_id)
			expect(row.data.customer).toBe("CUST-1")
			expect(row.data.offline_id).toBe(offline_id)
			expect(row.timestamp).toBeGreaterThanOrEqual(before)
			expect(row.synced).toBe(false)
			expect(row.retry_count).toBe(0)
			expect(row.server_status).toBeUndefined()
			expect(row.superseded).toBeFalsy()
		})

		it("keeps the id of a failed online attempt, so the server can dedupe it", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice({ offline_id: "pos_offline_kept" }))
			expect(offline_id).toBe("pos_offline_kept")
		})

		it("refuses an empty invoice and stores nothing", async () => {
			await expect(store.saveOfflineInvoice(invoice({ items: [] }))).rejects.toThrow("Cannot save empty invoice")
			expect(await store.getOfflineInvoiceCount()).toBe(0)
		})

		it("answers a repeated save with the first, because a save that timed out may have landed", async () => {
			const first = await store.saveOfflineInvoice(invoice({ offline_id: "same", customer: "FIRST" }))

			const repeat = await store.saveOfflineInvoice(invoice({ offline_id: "same", customer: "SECOND" }))

			expect(repeat).toEqual(first)
			const rows = await store.getOfflineInvoices()
			expect(rows).toHaveLength(1)
			expect(rows[0].data.customer).toBe("FIRST")
			expect(sumQueuedStock(rows).get("A")).toBe(24)
		})

		it("retires the original once when the save of an edit is repeated", async () => {
			const original = await store.saveOfflineInvoice(invoice())
			const options = { supersedesId: original.id }
			const edit = invoice({ offline_id: "edit" })

			await store.saveOfflineInvoice(edit, options)
			expect(await store.saveOfflineInvoice(edit, options)).toMatchObject({ success: true, offline_id: "edit" })

			expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual(["edit"])
			expect((await store.getQueuedInvoice(original.offline_id)).replaced_by).toBe("edit")
		})

		it("lists sales oldest first", async () => {
			const first = await store.saveOfflineInvoice(invoice())
			const second = await store.saveOfflineInvoice(invoice())

			expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual([
				first.offline_id,
				second.offline_id,
			])
			expect((await store.listUnsyncedInvoices()).map((row) => row.id)).toEqual([first.id, second.id])
		})

		it("retires the original of an edit in one step", async () => {
			const original = await store.saveOfflineInvoice(invoice())

			const edit = await store.saveOfflineInvoice(invoice({ customer: "EDITED" }), { supersedesId: original.id })

			const rows = await store.getOfflineInvoices()
			expect(rows.map((row) => row.offline_id)).toEqual([edit.offline_id])
			expect(await store.getOfflineInvoiceCount()).toBe(1)

			const retired = await store.getQueuedInvoice(original.offline_id)
			expect(retired.superseded).toBe(true)
			expect(retired.replaced_by).toBe(edit.offline_id)
		})

		it("keeps the sale when the original of an edit is already gone", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice(), { supersedesId: 9999 })
			expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual([offline_id])
		})

		describe("a sale the server already holds", () => {
			async function sendToServer() {
				const original = await store.saveOfflineInvoice(invoice())
				await store.updateQueuedInvoice(original.id, getQueueUpdateForResult({ status: "received" }))
				return original
			}

			it("is not retired by an edit, and keeps holding its stock", async () => {
				const original = await sendToServer()

				const edit = await store.saveOfflineInvoice(invoice({ customer: "EDITED" }), { supersedesId: original.id })

				const rows = await store.getOfflineInvoices()
				expect(rows.map((row) => row.offline_id)).toEqual([original.offline_id, edit.offline_id])
				expect(sumQueuedStock(rows).get("A")).toBe(48)

				const kept = await store.getQueuedInvoice(original.offline_id)
				expect(kept.superseded).toBeFalsy()
				expect(kept.replaced_by ?? null).toBeNull()
				expect(kept.server_status).toBe("received")
			})

			it("is not retired by an online checkout", async () => {
				const { id, offline_id } = await sendToServer()

				expect(await store.supersedeOfflineInvoice(id, "SINV-9")).toEqual({ success: true })

				expect(await store.getOfflineInvoiceCount()).toBe(1)
				expect((await store.getQueuedInvoice(offline_id)).superseded).toBeFalsy()
			})

			it("is not retired once it has finished", async () => {
				const { id, offline_id } = await store.saveOfflineInvoice(invoice())
				await store.updateQueuedInvoice(id, getQueueUpdateForResult({ status: "synced", invoice: "SINV-1" }))

				await store.supersedeOfflineInvoice(id, "SINV-9")

				const row = await store.getQueuedInvoice(offline_id)
				expect(row.superseded).toBeFalsy()
				expect(row.server_invoice).toBe("SINV-1")
			})
		})

		it("keeps who replaced a sale when it is named as replaced again", async () => {
			const original = await store.saveOfflineInvoice(invoice())
			const edit = await store.saveOfflineInvoice(invoice(), { supersedesId: original.id })

			await store.supersedeOfflineInvoice(original.id, "SINV-9")

			expect((await store.getQueuedInvoice(original.offline_id)).replaced_by).toBe(edit.offline_id)
		})

		it("hides a sale replaced by an online checkout", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			expect(await store.supersedeOfflineInvoice(id, "SINV-9")).toEqual({ success: true })

			expect(await store.getOfflineInvoiceCount()).toBe(0)
			expect((await store.getQueuedInvoice(offline_id)).replaced_by).toBe("SINV-9")
		})

		it("treats a queue row that is gone as nothing to do", async () => {
			expect(await store.supersedeOfflineInvoice(9999, "X")).toEqual({ success: true })
			expect(await store.deleteOfflineInvoice(9999)).toEqual({ success: true })
			await expect(store.updateQueuedInvoice(9999, { retry_count: 1, error: "x" })).resolves.not.toThrow()
		})

		it("deletes a sale", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.deleteOfflineInvoice(id)

			expect(await store.getOfflineInvoices()).toEqual([])
			expect(await store.getQueuedInvoice(offline_id)).toBeUndefined()
		})

		it("marks a sale printed", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			expect(await store.markOfflineInvoicePrinted(offline_id)).toEqual({ success: true })

			const { data } = await store.getQueuedInvoice(offline_id)
			expect(data.was_printed).toBe(true)
			expect(data.last_printed_at).toBeGreaterThan(0)
			expect(data.customer).toBe("CUST-1")
		})

		it("says when there is nothing to mark printed", async () => {
			expect(await store.markOfflineInvoicePrinted("unknown")).toEqual({ success: false, reason: "not found" })
			expect(await store.markOfflineInvoicePrinted(null)).toEqual({ success: false })
		})

		it("holds stock for queued sales from the rows it lists", async () => {
			await store.saveOfflineInvoice(invoice())
			await store.saveOfflineInvoice(invoice({ doctype: "Sales Order" }))

			expect(sumQueuedStock(await store.getOfflineInvoices(), "W1").get("A")).toBe(24)
		})

		it("records a failed attempt and its backoff", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, { retry_count: 1, error: "Timeout", next_attempt_at: 5000 })

			const row = await store.getQueuedInvoice(offline_id)
			expect(row.retry_count).toBe(1)
			expect(row.error).toBe("Timeout")
			expect(row.next_attempt_at).toBe(5000)
			expect(row.sync_failed).toBeFalsy()
			expect(row.server_status).toBeUndefined()
		})

		it("flags a sale that ran out of retries", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, { retry_count: 1, error: "x", next_attempt_at: 1, sync_failed: true })

			expect((await store.getQueuedInvoice(offline_id)).sync_failed).toBe(true)
			expect(await store.getOfflineInvoiceCount()).toBe(1)
		})

		it.each([
			["received", { status: "received" }, { server_status: "received", synced: false, listed: true }],
			["processing", { status: "processing" }, { server_status: "processing", synced: false, listed: true }],
			["needs_review", { status: "needs_review", message: "Stock" }, { server_status: "needs_review", synced: false, listed: true }],
			["conflict", { status: "conflict", message: "Stock" }, { server_status: "needs_review", synced: false, listed: true }],
			["synced", { status: "synced", invoice: "SINV-1" }, { server_status: "synced", synced: true, listed: false }],
			["duplicate", { status: "duplicate", invoice: "SINV-1" }, { server_status: "synced", synced: true, listed: false }],
			["voided", { status: "voided" }, { server_status: "voided", synced: true, listed: false }],
		])("follows the server's answer: %s", async (_status, result, expected) => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.updateQueuedInvoice(id, getQueueUpdateForResult(result))

			const row = await store.getQueuedInvoice(offline_id)
			expect(row.server_status).toBe(expected.server_status)
			expect(row.synced).toBe(expected.synced)
			expect(row.error ?? null).toBe(result.message ?? null)
			expect(Boolean(row.sync_failed)).toBe(expected.server_status === "needs_review")
			expect(row.server_invoice ?? null).toBe(result.invoice ?? null)
			expect((await store.getOfflineInvoices()).length).toBe(expected.listed ? 1 : 0)
		})

		it("deletes finished sales only past the cutoff", async () => {
			const kept = await store.saveOfflineInvoice(invoice())
			const finished = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(finished.id, getQueueUpdateForResult({ status: "synced", invoice: "S" }))

			await store.deleteSyncedInvoices(0)
			expect(await store.getQueuedInvoice(finished.offline_id)).toBeDefined()

			await store.deleteSyncedInvoices(Date.now() + 1000)
			expect(await store.getQueuedInvoice(finished.offline_id)).toBeUndefined()
			expect(await store.getQueuedInvoice(kept.offline_id)).toBeDefined()
		})
	})

	describe("every field of a queue row, through its whole life", () => {
		/** What the app reads. Undefined and null, or missing and false, mean the same to it. */
		const shape = (row) => ({
			entity: row.entity ?? "invoice",
			depends_on: row.depends_on ?? [],
			synced: row.synced,
			retry_count: row.retry_count,
			next_attempt_at: row.next_attempt_at ?? 0,
			error: row.error ?? null,
			server_status: row.server_status ?? null,
			server_invoice: row.server_invoice ?? null,
			sync_failed: Boolean(row.sync_failed),
			superseded: Boolean(row.superseded),
			replaced_by: row.replaced_by ?? null,
		})

		const fresh = {
			entity: "invoice",
			depends_on: [],
			synced: false,
			retry_count: 0,
			next_attempt_at: 0,
			error: null,
			server_status: null,
			server_invoice: null,
			sync_failed: false,
			superseded: false,
			replaced_by: null,
		}

		const failed = { retry_count: 1, error: "Timeout", next_attempt_at: 5000 }
		const gaveUp = { ...failed, sync_failed: true }
		const result = (answer) => getQueueUpdateForResult(answer)

		it.each([
			["a new sale", [], {}],
			["one failed send", [failed], failed],
			["running out of retries", [gaveUp], gaveUp],
			["staying failed on the next failure", [gaveUp, { ...failed, retry_count: 2 }], { ...gaveUp, retry_count: 2 }],
			["a retry count written outright, not counted up", [{ ...failed, retry_count: 5 }], { ...failed, retry_count: 5 }],
			["the server taking it after failures", [gaveUp, result({ status: "received" })], {
				retry_count: 1,
				next_attempt_at: 5000,
				server_status: "received",
			}],
			["being processed", [result({ status: "processing" })], { server_status: "processing" }],
			["needing review", [result({ status: "needs_review", message: "No stock" })], {
				server_status: "needs_review",
				sync_failed: true,
				error: "No stock",
			}],
			["a review with no message", [result({ status: "needs_review" })], {
				server_status: "needs_review",
				sync_failed: true,
			}],
			["a conflict, which is a review", [result({ status: "conflict", message: "Dup" })], {
				server_status: "needs_review",
				sync_failed: true,
				error: "Dup",
			}],
			["a review that gets fixed", [
				result({ status: "needs_review", message: "No stock" }),
				result({ status: "synced", invoice: "SINV-1" }),
			], { synced: true, server_status: "synced", server_invoice: "SINV-1" }],
			["a review a manager voids", [
				result({ status: "needs_review", message: "No stock" }),
				result({ status: "voided" }),
			], { synced: true, server_status: "voided" }],
			["a duplicate the server already had", [result({ status: "duplicate", invoice: "SINV-2" })], {
				synced: true,
				server_status: "synced",
				server_invoice: "SINV-2",
			}],
		])("after %s", async (_name, updates, expected) => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			for (const update of updates) await store.updateQueuedInvoice(id, update)

			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual({ ...fresh, ...expected })
		})

		it("after being retired by an edit", async () => {
			const original = await store.saveOfflineInvoice(invoice())
			const edit = await store.saveOfflineInvoice(invoice(), { supersedesId: original.id })

			expect(shape(await store.getQueuedInvoice(original.offline_id))).toEqual({
				...fresh,
				superseded: true,
				replaced_by: edit.offline_id,
			})
		})

		it("after being retired with nothing to point at", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())

			await store.supersedeOfflineInvoice(id)

			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual({ ...fresh, superseded: true })
		})

		it("the same for a record that is not a sale", async () => {
			const { id, offline_id } = await store.saveQueueEntity(ENTITY_PAYMENT, { invoice_name: "SINV-1" }, ["dep"])
			const queued = { ...fresh, entity: ENTITY_PAYMENT, depends_on: ["dep"] }
			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual(queued)

			await store.updateQueuedInvoice(id, gaveUp)
			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual({ ...queued, ...gaveUp })

			await store.updateQueuedInvoice(id, result({ status: "needs_review", message: "Over paid" }))
			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual({
				...queued,
				...gaveUp,
				error: "Over paid",
				server_status: "needs_review",
			})

			await store.updateQueuedInvoice(id, result({ status: "synced", invoice: "ACC-PAY-1" }))
			expect(shape(await store.getQueuedInvoice(offline_id))).toEqual({
				...queued,
				...failed,
				error: null,
				synced: true,
				server_status: "synced",
				server_invoice: "ACC-PAY-1",
			})
		})
	})

	describe("records that are not sales", () => {
		it("keeps one row when a record is saved again under its id", async () => {
			const record = { invoice_name: "SINV-1", amount: 5, offline_id: "pos_offline_payment" }

			const first = await store.saveQueueEntity(ENTITY_PAYMENT, record)
			const second = await store.saveQueueEntity(ENTITY_PAYMENT, record)

			expect(second).toMatchObject({ success: true, id: first.id, offline_id: first.offline_id })
			expect(await store.getOfflineInvoiceCount()).toBe(1)
		})

		const customer = () => ({ doctype: "Customer", customer_name: "Sara", offline_id: "pos_offline_customer" })

		it("queues one in the order it was made, with its own id", async () => {
			const sale = await store.saveOfflineInvoice(invoice())
			const result = await store.saveQueueEntity(ENTITY_PAYMENT, { invoice_name: "SINV-1", amount: 5 })

			expect(result.success).toBe(true)
			expect(result.offline_id).toMatch(/^pos_offline_/)
			expect(result.id).toBeGreaterThan(sale.id)

			const rows = await store.getOfflineInvoices()
			expect(rows.map((row) => row.offline_id)).toEqual([sale.offline_id, result.offline_id])
			expect(rows[1].entity).toBe(ENTITY_PAYMENT)
			expect(rows[1].data).toEqual({ invoice_name: "SINV-1", amount: 5, offline_id: result.offline_id })
			expect(rows[1].depends_on).toEqual([])
		})

		it("keeps the id it was given, because a customer's name is that id", async () => {
			const { offline_id } = await store.saveQueueEntity(ENTITY_CUSTOMER, customer())
			expect(offline_id).toBe("pos_offline_customer")
		})

		it("counts it as queued", async () => {
			await store.saveQueueEntity(ENTITY_CUSTOMER, customer())
			expect(await store.getOfflineInvoiceCount()).toBe(1)
			expect((await store.getCacheStats()).queuedInvoices).toBe(1)
		})

		it("makes a sale to a local customer wait for that customer", async () => {
			const { offline_id } = await store.saveQueueEntity(ENTITY_CUSTOMER, customer())

			const sale = await store.saveOfflineInvoice(invoice({ customer: offline_id }))

			const row = await store.getQueuedInvoice(sale.offline_id)
			expect(row.entity).toBe("invoice")
			expect(row.depends_on).toEqual([offline_id])
		})

		it("makes a return wait for a sale still in the queue, and a customer too", async () => {
			const sale = await store.saveOfflineInvoice(invoice({ customer: "pos_offline_customer" }))

			const refund = await store.saveOfflineInvoice(
				invoice({ customer: "pos_offline_customer", is_return: 1, return_against: sale.offline_id }),
			)

			expect((await store.getQueuedInvoice(refund.offline_id)).depends_on).toEqual([
				"pos_offline_customer",
				sale.offline_id,
			])
		})

		it("depends on nothing for a customer the server knows", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			expect((await store.getQueuedInvoice(offline_id)).depends_on).toEqual([])
		})

		it("shows what still depends on a row", async () => {
			const { offline_id } = await store.saveQueueEntity(ENTITY_CUSTOMER, customer())
			const sale = await store.saveOfflineInvoice(invoice({ customer: offline_id }))

			const dependents = getDependentRows(await store.getOfflineInvoices(), offline_id)

			expect(dependents.map((row) => row.offline_id)).toEqual([sale.offline_id])
		})

		it("reads sales and payments apart from the rows it lists", async () => {
			await store.saveOfflineInvoice(invoice({ coupon_code: "SAVE5" }))
			await store.saveQueueEntity(ENTITY_PAYMENT, {
				invoice_name: "SINV-1",
				payments: [{ mode_of_payment: "Cash", amount: 7 }],
			})

			const rows = await store.getOfflineInvoices()

			expect(sumQueuedPayments(rows).get("SINV-1")).toBe(7)
			expect(countQueuedCouponUses(rows, "save5").total).toBe(1)
		})

		it("holds no stock for a record that is not a sale", async () => {
			await store.saveQueueEntity(ENTITY_SHIFT_CLOSE, { pos_opening_shift: "SHIFT-1", items: [] })
			expect(sumQueuedStock(await store.getOfflineInvoices()).size).toBe(0)
		})

		it("keeps synced rows and leaves retired ones out of every row it holds", async () => {
			const synced = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(synced.id, getQueueUpdateForResult({ status: "synced", invoice: "S" }))
			const retired = await store.saveOfflineInvoice(invoice())
			await store.supersedeOfflineInvoice(retired.id, "X")
			const pending = await store.saveQueueEntity(ENTITY_PAYMENT, { invoice_name: "S" })

			const rows = await store.getQueueRows()

			expect(rows.map((row) => row.offline_id)).toEqual([synced.offline_id, pending.offline_id])
			expect(rows[0].synced).toBe(true)
			expect(rows[0].server_invoice).toBe("S")
		})

		it("lists a shift's records for its close, leaving the close itself out", async () => {
			const sale = await store.saveOfflineInvoice(invoice())
			const payment = await store.saveQueueEntity(ENTITY_PAYMENT, { posa_pos_opening_shift: "SHIFT-1" })
			await store.saveOfflineInvoice(invoice({ posa_pos_opening_shift: "OTHER" }))

			const manifest = getShiftManifest(await store.getQueueRows(), "SHIFT-1")
			expect(manifest).toEqual([sale.offline_id, payment.offline_id])

			await store.saveQueueEntity(ENTITY_SHIFT_CLOSE, { pos_opening_shift: "SHIFT-1" }, manifest)
			const rows = await store.getQueueRows()
			expect(rows.at(-1).depends_on).toEqual(manifest)
			expect(getShiftManifest(rows, "SHIFT-1")).toEqual(manifest)
		})

		it("offers a queued sale for return until something rules it out", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			expect(isReturnableQueueRow(await store.getQueuedInvoice(offline_id))).toBe(true)

			await store.updateQueuedInvoice(id, getQueueUpdateForResult({ status: "needs_review" }))

			expect(isReturnableQueueRow(await store.getQueuedInvoice(offline_id))).toBe(false)
		})

		it("cleans up a finished record like a finished sale", async () => {
			const { id, offline_id } = await store.saveQueueEntity(ENTITY_CUSTOMER, customer())
			await store.updateQueuedInvoice(id, getQueueUpdateForResult({ status: "synced", invoice: "CUST-9" }))

			await store.deleteSyncedInvoices(Date.now() + 1000)

			expect(await store.getQueuedInvoice(offline_id)).toBeUndefined()
		})

		it("can be deleted", async () => {
			const { id, offline_id } = await store.saveQueueEntity(ENTITY_CUSTOMER, customer())

			await store.deleteOfflineInvoice(id)

			expect(await store.getQueuedInvoice(offline_id)).toBeUndefined()
		})

		describe("through utils/offline/sync", () => {
			it("sends it as what it is, untouched, with what it depends on", async () => {
				const { syncOfflineInvoices } = await import("@/utils/offline/sync")
				const { offline_id } = await store.saveQueueEntity(ENTITY_SHIFT_CLOSE, { pos_opening_shift: "S" }, ["dep"])
				callServer.mockImplementation(async (method) =>
					method.endsWith("push")
						? { results: [{ offline_id, status: "received" }] }
						: [{ offline_id, status: "synced" }],
				)

				await syncOfflineInvoices()

				const [envelope] = callServer.mock.calls[0][1].items
				expect(envelope.entity).toBe(ENTITY_SHIFT_CLOSE)
				expect(envelope.depends_on).toEqual(["dep"])
				expect(envelope.payload).toEqual({ pos_opening_shift: "S", offline_id })
			})

			it("announces when it reaches the server, so a close can finish", async () => {
				const { syncOfflineInvoices } = await import("@/utils/offline/sync")
				const { offline_id } = await store.saveQueueEntity(ENTITY_SHIFT_CLOSE, { pos_opening_shift: "S" })
				callServer.mockImplementation(async (method) =>
					method.endsWith("push")
						? { results: [{ offline_id, status: "received" }] }
						: [{ offline_id, status: "synced", invoice: "CLOSE-1" }],
				)
				const announced = new Promise((resolve) => {
					window.addEventListener("offlineEntitySynced", (event) => resolve(event.detail), { once: true })
				})

				await syncOfflineInvoices()

				const { row, status, name } = await announced
				expect(row.entity).toBe(ENTITY_SHIFT_CLOSE)
				expect(row.data.pos_opening_shift).toBe("S")
				expect(status).toBe("synced")
				expect(name).toBe("CLOSE-1")
			})
		})
	})

	describe("items that hide without stock", () => {
		const hidden = { hide_when_unavailable: 1, is_stock_item: 1 }

		const codes = (items) => items.map((row) => row.item_code)

		beforeEach(async () => {
			await store.cacheItems([
				item("ALWAYS", { item_name: "A always" }),
				item("EMPTY", { item_name: "B empty", ...hidden, actual_qty: 0, brand: "Acme" }),
				item("NO-QTY", { item_name: "C unknown", ...hidden }),
				item("STOCKED", { item_name: "D stocked", ...hidden, actual_qty: 4, brand: "Acme" }),
				item("BUNDLE", { item_name: "E bundle", hide_when_unavailable: 1, is_bundle: 1 }),
				item("SERVICE", { item_name: "F service", hide_when_unavailable: 1 }),
				item("TEMPLATE", { item_name: "G template", ...hidden, has_variants: 1 }),
			])
		})

		it("leaves them out of browsing, groups, brands and counts", async () => {
			const shown = ["ALWAYS", "STOCKED", "SERVICE", "TEMPLATE"]

			expect(codes(await store.searchCachedItems(""))).toEqual(shown)
			expect(codes(await store.searchCachedItemsByGroup(["Group 1"]))).toEqual(shown)
			expect(codes(await store.searchCachedItemsByBrand("Acme"))).toEqual(["STOCKED"])
			expect(await store.countCachedItemsByGroup(["Group 1"])).toBe(4)
			expect(await store.countCachedItemsByGroup([])).toBe(4)
		})

		it("still finds them by search, because a cashier asked for that item", async () => {
			expect(codes(await store.searchCachedItems("EMPTY"))).toEqual(["EMPTY"])
		})

		it("shows one again as soon as stock arrives", async () => {
			await store.updateStockQuantities([{ item_code: "EMPTY", actual_qty: 3 }])

			expect(codes(await store.searchCachedItemsByGroup(["Group 1"], 50, 0))).toContain("EMPTY")
		})

		it("hides one again when its stock runs out", async () => {
			await store.updateStockQuantities([{ item_code: "STOCKED", actual_qty: 0 }])

			expect(codes(await store.searchCachedItemsByBrand("Acme"))).toEqual([])
		})
	})

	describe("pull pages", () => {
		const page = (rows = [], deleted = [], extra = {}) => ({
			rows,
			deleted,
			next_cursor: "c1",
			has_more: false,
			...extra,
		})

		it("stores items and takes out what the server deleted, with their prices", async () => {
			await store.cacheItems([item("OLD", { rate: 5, barcodes: ["111"] })])

			expect(
				await store.applyPullPage("items", page([item("NEW", { rate: 9, barcodes: ["222"] })], ["OLD"]), "P1"),
			).toEqual({ success: true })

			expect((await store.getCachedItem("NEW")).item_name).toBe("Item NEW")
			expect(await store.getCachedItemPrice("Standard", "NEW")).toBe(9)
			expect(await store.getCachedItem("OLD")).toBeUndefined()
			expect(await store.getCachedItemPrice("Standard", "OLD")).toBeUndefined()
			expect(await store.getCachedItemByBarcode("111")).toBeUndefined()
		})

		it("stores a page of prices the same way", async () => {
			await store.applyPullPage("item_prices", page([item("A", { rate: 3 })]), "P1")
			expect(await store.getCachedItemPrice("Standard", "A")).toBe(3)
		})

		it("keeps batch data through a pulled item", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await store.cacheItems([item("A")])
			await persistItemBatchSerialData("A", { batch_no_data: [{ batch_no: "B1" }] })

			await store.applyPullPage("items", page([item("A", { item_name: "Renamed" })]), "P1")

			const cached = await store.getCachedItem("A")
			expect(cached.item_name).toBe("Renamed")
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1" }])
		})

		it("takes a page with nothing in it", async () => {
			await expect(store.applyPullPage("items", page(), "P1")).resolves.toEqual({ success: true })
			await expect(store.applyPullPage("customers", page(), "P1")).resolves.toEqual({ success: true })
		})

		it("stores customers and removes deleted ones", async () => {
			await store.cacheCustomers([{ name: "OLD", customer_name: "Old" }])

			await store.applyPullPage("customers", page([{ name: "NEW", customer_name: "New" }], ["OLD"]), "P1")

			expect((await store.searchCachedCustomers("")).map((row) => row.name)).toEqual(["NEW"])
		})

		it("keeps taxes per profile, where the cart reads them", async () => {
			await store.applyPullPage("taxes", page([{ rate: 15 }]), "P1")
			expect(await store.getSetting("tax_rules_P1")).toEqual([{ rate: 15 }])
		})

		it("replaces a profile's payment methods and no other profile's", async () => {
			await store.cachePaymentMethods([
				{ mode_of_payment: "Old", pos_profile: "P1" },
				{ mode_of_payment: "Other", pos_profile: "P2" },
			])

			await store.applyPullPage("payment_methods", page([{ mode_of_payment: "Card" }]), "P1")

			expect(await store.getCachedPaymentMethods("P1")).toEqual([{ mode_of_payment: "Card", pos_profile: "P1" }])
			expect(await store.getCachedPaymentMethods("P2")).toHaveLength(1)
		})

		it("keeps the profile's item groups where the item store reads them", async () => {
			const rows = [{ pos_profile: { item_groups: ["G1"] }, item_groups_hierarchy: [{ name: "G1" }] }]

			await store.applyPullPage("pos_profile", page(rows), "P1")

			expect(await store.getSetting("pos_profile_data:P1")).toEqual({
				profileItemGroups: ["G1"],
				itemGroups: [{ name: "G1" }],
			})
		})

		it("replaces a profile's offers", async () => {
			await store.cacheOffers([{ name: "OLD" }], "P1")

			await store.applyPullPage("offers", page([{ name: "NEW" }]), "P1")

			expect((await store.getCachedOffers("P1")).map((offer) => offer.name)).toEqual(["NEW"])
		})

		it("refuses what it cannot store, so the cursor is not saved", { timeout: 20000 }, async () => {
			await expect(store.applyPullPage("offers", page([{ name: "X" }]), "")).rejects.toThrow()
			await expect(store.applyPullPage("nonsense", page(), "P1")).rejects.toThrow("Unknown pull entity")
		})

		describe("through the pull engine", () => {
			const engineStore = () => ({
				getState: (entity) => store.getSetting(pullStateKey(entity), null),
				saveState: (entity, state) => store.setSetting(pullStateKey(entity), state),
				applyPage: (entity, data) => store.applyPullPage(entity, data, "P1"),
			})

			const serverWith = (pages) => ({
				getManifest: async () => ({ items: "v1", scopes: { items: "s1" } }),
				pull: vi.fn(async ({ cursor }) => pages[cursor ?? "start"]),
			})

			const twoPages = {
				start: page([item("A")], [], { next_cursor: "c1", has_more: true }),
				c1: page([item("B")], [], { next_cursor: "c2", has_more: false }),
			}

			it("walks every page and records where it got to", async () => {
				const results = await runPull({
					server: serverWith(twoPages),
					store: engineStore(),
					posProfile: "P1",
					entities: ["items"],
				})

				expect(results.items).toMatchObject({ status: "updated", pages: 2, rows: 2 })
				expect(await store.getCachedItem("B")).toBeDefined()
				expect(await store.getSetting(pullStateKey("items"))).toEqual({
					posProfile: "P1",
					scope: "s1",
					cursor: "c2",
					version: "v1",
				})
			})

			it("asks for nothing when the version has not moved", async () => {
				const server = serverWith(twoPages)
				const options = { server, store: engineStore(), posProfile: "P1", entities: ["items"] }
				await runPull(options)
				server.pull.mockClear()

				expect((await runPull(options)).items.status).toBe("unchanged")
				expect(server.pull).not.toHaveBeenCalled()
			})

			it("resumes a walk that was cut short", async () => {
				const server = serverWith(twoPages)
				server.pull.mockImplementationOnce(async () => twoPages.start)
				server.pull.mockImplementationOnce(async () => {
					throw new Error("Connection lost")
				})
				const options = { server, store: engineStore(), posProfile: "P1", entities: ["items"] }

				expect((await runPull(options)).items.status).toBe("failed")
				expect((await store.getSetting(pullStateKey("items"))).version).toBeNull()

				await runPull(options)

				expect(server.pull).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }))
				expect(await store.getCachedItem("B")).toBeDefined()
			})

			it("starts over after the cache was cleared", async () => {
				const server = serverWith(twoPages)
				const options = { server, store: engineStore(), posProfile: "P1", entities: ["items"] }
				await runPull(options)
				await store.clearItemsCache()
				server.pull.mockClear()

				await runPull(options)

				expect(server.pull.mock.calls[0][0].cursor).toBeNull()
				expect(await store.getCachedItem("A")).toBeDefined()
			})
		})
	})

	describe("forgetting how far a pull got", () => {
		const cursors = (entities) =>
			Promise.all(
				entities.map((entity) => store.setSetting(pullStateKey(entity), { cursor: "c", version: "v" })),
			)

		const remaining = async () => {
			const kept = []
			for (const entity of PULL_ENTITIES) {
				if (await store.getSetting(pullStateKey(entity))) kept.push(entity)
			}
			return kept
		}

		beforeEach(() => cursors(PULL_ENTITIES))

		it("resets items and prices when the items are cleared", async () => {
			await store.clearItemsCache()
			expect(await remaining()).toEqual(PULL_ENTITIES.filter((entity) => !["items", "item_prices"].includes(entity)))
		})

		it("resets customers when the customers are cleared", async () => {
			await store.clearCustomersCache()
			expect(await remaining()).toEqual(PULL_ENTITIES.filter((entity) => entity !== "customers"))
		})

		it("resets everything when all cached data is cleared", async () => {
			await store.clearCachedData()
			expect(await remaining()).toEqual([])
		})

		it("resets everything even when settings are kept", async () => {
			await store.setSetting("keep", 1)

			await store.clearCachedData({ preserveSettings: true })

			expect(await remaining()).toEqual([])
			expect(await store.getSetting("keep")).toBe(1)
		})

		it("resets through the cache helpers the app calls too", async () => {
			const items = await import("@/utils/offline/items")

			expect(await items.clearItemsCache()).toBe(true)
			expect(await items.clearCustomersCache()).toBe(true)

			expect(await remaining()).toEqual(
				PULL_ENTITIES.filter((entity) => !["items", "item_prices", "customers"].includes(entity)),
			)
		})
	})

	describe("syncing through utils/offline/sync", () => {
		let syncOfflineInvoices

		beforeEach(async () => {
			;({ syncOfflineInvoices } = await import("@/utils/offline/sync"))
		})

		const answers = (results, statuses = []) =>
			callServer.mockImplementation(async (method) => (method.endsWith("push") ? { results } : statuses))

		it("hands a sale to the server and follows it until it is synced", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers(
				[{ offline_id, status: "received" }],
				[{ offline_id, status: "synced", invoice: "SINV-1" }],
			)

			const result = await syncOfflineInvoices()

			expect(result.success).toBe(1)
			expect(await store.getOfflineInvoiceCount()).toBe(0)

			const [method, params] = callServer.mock.calls[0]
			expect(method).toBe("pos_next.api.sync.push")
			expect(params.items[0].offline_id).toBe(offline_id)
			expect(params.items[0].payload.customer).toBe("CUST-1")
			expect(params.items[0].seq).toBeGreaterThan(0)
		})

		it("backs off from a sale the server rejects", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers([{ offline_id, status: "rejected", message: "Bad" }])

			const result = await syncOfflineInvoices()

			expect(result.failed).toBe(1)
			const row = await store.getQueuedInvoice(offline_id)
			expect(row.retry_count).toBe(1)
			expect(row.error).toBe("Bad")
			expect(row.next_attempt_at).toBeGreaterThan(Date.now())
		})

		it("survives a rejection without a message", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers([{ offline_id, status: "rejected" }])

			expect((await syncOfflineInvoices()).failed).toBe(1)
			expect((await store.getQueuedInvoice(offline_id)).retry_count).toBe(1)
		})

		it("waits out the backoff unless the sync is forced", async () => {
			const { id, offline_id } = await store.saveOfflineInvoice(invoice())
			await store.updateQueuedInvoice(id, { retry_count: 1, error: "x", next_attempt_at: Date.now() + 60000 })
			answers([{ offline_id, status: "synced", invoice: "S" }], [{ offline_id, status: "synced", invoice: "S" }])

			await syncOfflineInvoices()
			expect(callServer).not.toHaveBeenCalledWith("pos_next.api.sync.push", expect.anything())

			await syncOfflineInvoices({ force: true })
			expect(callServer).toHaveBeenCalledWith("pos_next.api.sync.push", expect.anything())
		})

		it("reports a sale that needs review and keeps it listed", async () => {
			const { offline_id } = await store.saveOfflineInvoice(invoice())
			answers(
				[{ offline_id, status: "received" }],
				[{ offline_id, status: "needs_review", message: "No stock" }],
			)

			const result = await syncOfflineInvoices()

			expect(result.failed).toBe(1)
			const [row] = await store.getOfflineInvoices()
			expect(row.server_status).toBe("needs_review")
			expect(row.sync_failed).toBe(true)
			expect(row.error).toBe("No stock")
		})

		describe("counting how each sale ended", () => {
			const statusChecks = () =>
				callServer.mock.calls.filter(([method]) => method.endsWith("get_status")).length

			const saleThatSynced = () =>
				new Promise((resolve) => {
					window.addEventListener("offlineInvoicesSynced", (event) => resolve(event.detail), { once: true })
				})

			it("counts a sale the first response finished, with no status check", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				answers([{ offline_id, status: "synced", invoice: "SINV-1" }])

				const result = await syncOfflineInvoices()

				expect(result.success).toBe(1)
				expect(result.failed).toBe(0)
				expect(statusChecks()).toBe(0)
				expect(await store.getOfflineInvoiceCount()).toBe(0)
			})

			it("counts a duplicate as a sale that is on the server", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				answers([{ offline_id, status: "duplicate", invoice: "SINV-1" }])

				const result = await syncOfflineInvoices()

				expect(result.success).toBe(1)
				expect(result.failed).toBe(0)
				expect((await store.getQueuedInvoice(offline_id)).server_invoice).toBe("SINV-1")
			})

			it("tells the POS when the first response finished a sale", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				answers([{ offline_id, status: "synced", invoice: "SINV-1" }])
				const announced = saleThatSynced()

				await syncOfflineInvoices()

				expect((await announced).success).toBe(1)
			})

			it("counts each sale of a batch once, whichever answer finished it", async () => {
				const first = await store.saveOfflineInvoice(invoice())
				const second = await store.saveOfflineInvoice(invoice())
				const third = await store.saveOfflineInvoice(invoice())
				answers(
					[
						{ offline_id: first.offline_id, status: "synced", invoice: "SINV-1" },
						{ offline_id: second.offline_id, status: "duplicate", invoice: "SINV-2" },
						{ offline_id: third.offline_id, status: "received" },
					],
					[{ offline_id: third.offline_id, status: "synced", invoice: "SINV-3" }],
				)

				const result = await syncOfflineInvoices()

				expect(result.success).toBe(3)
				expect(result.failed).toBe(0)
			})

			it.each([
				["needs_review", "No stock"],
				["conflict", "A different invoice was already stored under this offline_id"],
			])("reports %s from the first response once, as a failure", async (status, message) => {
				const { id, offline_id } = await store.saveOfflineInvoice(invoice())
				answers([{ offline_id, status, message }], [{ offline_id, status: "needs_review", message }])

				const result = await syncOfflineInvoices()

				expect(result.success).toBe(0)
				expect(result.failed).toBe(1)
				expect(result.errors).toHaveLength(1)
				expect(result.errors[0]).toMatchObject({ invoiceId: id, offlineId: offline_id, customer: "CUST-1" })
				expect(result.errors[0].error.message).toBe(message)
			})

			it("does not count a sale again on the next sync", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				answers(
					[{ offline_id, status: "needs_review", message: "No stock" }],
					[{ offline_id, status: "needs_review", message: "No stock" }],
				)

				await syncOfflineInvoices()
				const result = await syncOfflineInvoices()

				expect(result.failed).toBe(0)
				expect(result.errors).toEqual([])
			})

			it("counts a sale once when a later one cannot be recorded", async () => {
				const { localStore } = await import("@/platform/store")
				const first = await store.saveOfflineInvoice(invoice())
				const second = await store.saveOfflineInvoice(invoice())
				answers([
					{ offline_id: first.offline_id, status: "synced", invoice: "SINV-1" },
					{ offline_id: second.offline_id, status: "synced", invoice: "SINV-2" },
				])
				const realUpdate = localStore.updateQueuedInvoice
				let updates = 0
				const spy = vi.spyOn(localStore, "updateQueuedInvoice").mockImplementation(async (...args) => {
					updates++
					if (updates === 2) throw new Error("Storage is full")
					return realUpdate(...args)
				})

				const result = await syncOfflineInvoices()
				spy.mockRestore()

				expect(result.success).toBe(1)
				expect(result.failed).toBe(1)
				expect(result.errors.map((entry) => entry.offlineId)).toEqual([second.offline_id])
			})

			it("reports a sale the server took but has not finished as delivered", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				callServer.mockImplementation(async (method) => {
					if (method.endsWith("push")) return { results: [{ offline_id, status: "received" }] }
					throw new Error("Status is not available")
				})

				const result = await syncOfflineInvoices()

				expect(result.delivered).toBe(1)
				expect(result.success).toBe(0)
			})

			it("does not report a rejected sale as delivered", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice())
				answers([{ offline_id, status: "rejected", message: "Bad" }])

				expect((await syncOfflineInvoices()).delivered).toBe(0)
			})
		})

		it("leaves a sale being edited in the queue until it is released", async () => {
			const { holdFromSync, releaseFromSync } = await import("@/utils/offline/sync")
			const held = await store.saveOfflineInvoice(invoice())
			const other = await store.saveOfflineInvoice(invoice())
			answers([])

			expect(holdFromSync(held.offline_id)).toBe(true)
			await syncOfflineInvoices({ force: true })

			const [, { items }] = callServer.mock.calls.find(([method]) => method.endsWith("push"))
			expect(items.map((item) => item.offline_id)).toEqual([other.offline_id])

			callServer.mockClear()
			releaseFromSync(held.offline_id)
			await syncOfflineInvoices({ force: true })

			const [, again] = callServer.mock.calls.find(([method]) => method.endsWith("push"))
			expect(again.items.map((item) => item.offline_id)).toContain(held.offline_id)
		})

		it("will not hold a sale twice, so one edit cannot release another's hold", async () => {
			const { holdFromSync, releaseFromSync } = await import("@/utils/offline/sync")

			expect(holdFromSync("a")).toBe(true)
			expect(holdFromSync("a")).toBe(false)

			releaseFromSync("a")
			expect(holdFromSync("a")).toBe(true)
		})

		describe("a sale the server has no record of", () => {
			const statusAnswer = (answer) =>
				callServer.mockImplementation(async (method, params) =>
					method.endsWith("push") ? { results: [] } : answer(params),
				)

			/** The status polls wait between tries, and these tests should not */
			async function syncWithoutWaiting() {
				vi.useFakeTimers({ toFake: ["setTimeout"] })
				try {
					let finished = false
					const syncing = syncOfflineInvoices().finally(() => {
						finished = true
					})
					while (!finished) await vi.advanceTimersByTimeAsync(2000)
					return await syncing
				} finally {
					vi.useRealTimers()
				}
			}

			async function heldByServer(update = { status: "received" }, extra = {}) {
				const { id, offline_id } = await store.saveOfflineInvoice(invoice(extra))
				await store.updateQueuedInvoice(id, getQueueUpdateForResult(update))
				return { id, offline_id }
			}

			it("goes back to waiting, and the next sync sends it", async () => {
				const { offline_id } = await heldByServer()
				statusAnswer(() => [])

				const result = await syncOfflineInvoices()

				expect(result.waiting).toBe(0)
				const row = await store.getQueuedInvoice(offline_id)
				expect(row.server_status ?? null).toBeNull()
				expect(row.synced).toBe(false)
				expect(callServer).not.toHaveBeenCalledWith("pos_next.api.sync.push", expect.anything())

				await syncOfflineInvoices()

				const [, { items }] = callServer.mock.calls.find(([method]) => method.endsWith("push"))
				expect(items.map((item) => item.offline_id)).toEqual([offline_id])
			})

			it("starts over, keeping its stock and leaving review behind", async () => {
				const { id, offline_id } = await heldByServer({ status: "needs_review", message: "No stock" })
				await store.updateQueuedInvoice(id, {
					...getQueueUpdateForResult({ status: "needs_review", message: "No stock" }),
					retry_count: 2,
				})
				statusAnswer(() => [])

				await syncOfflineInvoices()

				const row = await store.getQueuedInvoice(offline_id)
				expect(row.sync_failed).toBe(false)
				expect(row.error ?? null).toBeNull()
				expect(row.server_invoice ?? null).toBeNull()
				expect(row.next_attempt_at ?? 0).toBe(0)
				expect(sumQueuedStock(await store.getOfflineInvoices()).get("A")).toBe(24)
			})

			it("is told apart from the others in the same answer", async () => {
				const kept = await heldByServer()
				const forgotten = await heldByServer()
				statusAnswer(() => [{ offline_id: kept.offline_id, status: "synced", invoice: "SINV-1" }])

				await syncOfflineInvoices()

				expect((await store.getQueuedInvoice(kept.offline_id)).server_status).toBe("synced")
				expect((await store.getQueuedInvoice(forgotten.offline_id)).server_status ?? null).toBeNull()
			})

			it("keeps its status when the status call fails", async () => {
				const { offline_id } = await heldByServer()
				statusAnswer(() => {
					throw new Error("Bad gateway")
				})

				await syncOfflineInvoices()

				expect((await store.getQueuedInvoice(offline_id)).server_status).toBe("received")
			})

			it.each([
				["nothing", undefined],
				["something that is not a list", { message: "Try later" }],
				["a list with a broken entry", [{ status: "processing" }]],
			])("keeps its status when the answer is %s", async (_name, answer) => {
				const { offline_id } = await heldByServer()
				statusAnswer(() => answer)

				await syncWithoutWaiting()

				expect((await store.getQueuedInvoice(offline_id)).server_status).toBe("received")
			})

			it("keeps its status when it is past what the server reads in one call", async () => {
				const rows = []
				for (let i = 0; i < 201; i++) rows.push(await heldByServer())
				const last = rows.at(-1)
				const reads = []
				statusAnswer(({ offline_ids }) => {
					reads.push(offline_ids.length)
					return offline_ids.slice(0, 200).map((offline_id) => ({ offline_id, status: "processing" }))
				})

				await syncWithoutWaiting()

				expect(Math.max(...reads)).toBe(200)
				expect((await store.getQueuedInvoice(last.offline_id)).server_status).toBe("received")
			})

			it("cannot reopen a sale that has finished", async () => {
				const { id, offline_id } = await store.saveOfflineInvoice(invoice())
				await store.updateQueuedInvoice(id, getQueueUpdateForResult({ status: "synced", invoice: "SINV-1" }))

				await store.resendQueuedInvoice(id)

				expect((await store.getQueuedInvoice(offline_id)).server_status).toBe("synced")
			})

			it("cannot bring back a sale that was retired", async () => {
				const original = await store.saveOfflineInvoice(invoice())
				await store.saveOfflineInvoice(invoice(), { supersedesId: original.id })

				await store.resendQueuedInvoice(original.id)

				expect((await store.getQueuedInvoice(original.offline_id)).superseded).toBe(true)
			})

			it("treats a row that is gone as nothing to do", async () => {
				await expect(store.resendQueuedInvoice(9999)).resolves.not.toThrow()
			})
		})

		it("finds a queued invoice by its offline id", async () => {
			const { getOfflineInvoiceByOfflineId } = await import("@/utils/offline/sync")
			const { offline_id } = await store.saveOfflineInvoice(invoice())

			expect((await getOfflineInvoiceByOfflineId(offline_id)).customer).toBe("CUST-1")
			expect(await getOfflineInvoiceByOfflineId("unknown")).toBeNull()
		})
	})

	describe("the catalog", () => {
		const catalog = [
			item("B-2", { item_name: "Banana" }),
			item("A-1", { item_name: "Apple", barcodes: ["1234567890"], description: "red fruit" }),
			item("TPL", { item_name: "Template", has_variants: 1 }),
			item("TPL-S", { item_name: "Template Small", variant_of: "TPL" }),
			item("OFF", { item_name: "Disabled", disabled: 1 }),
			item("C-3", { item_name: "Cherry", item_group: "Group 2", brand: "Acme" }),
		]

		beforeEach(async () => {
			await store.cacheItems(catalog)
		})

		const codes = (items) => items.map((row) => row.item_code)

		it("reports what it cached", async () => {
			expect(await store.cacheItems([item("Z-1")])).toMatchObject({ success: true, count: 1 })
			expect(await store.cacheItems([])).toEqual({ success: true, count: 0, duration: 0 })
			expect(await store.isCacheReady()).toBe(true)
		})

		it("browses by name, without templates' variants or disabled items", async () => {
			expect(codes(await store.searchCachedItems(""))).toEqual(["A-1", "B-2", "C-3", "TPL"])
		})

		it("shows variants instead of templates when the setting asks for it", async () => {
			await store.setShowVariantsAsItems(true)
			expect(codes(await store.searchCachedItems(""))).toEqual(["A-1", "B-2", "C-3", "TPL-S"])
		})

		it("pages through a browse", async () => {
			expect(codes(await store.searchCachedItems("", 2, 1))).toEqual(["B-2", "C-3"])
		})

		it("finds an item by barcode first", async () => {
			expect(codes(await store.searchCachedItems("1234567890"))).toEqual(["A-1"])
		})

		it("finds an item by the start of its code, in any case", async () => {
			expect(codes(await store.searchCachedItems("b-2"))).toEqual(["B-2"])
		})

		it("finds an item by the start of its name, in any case", async () => {
			expect(codes(await store.searchCachedItems("CHER"))).toEqual(["C-3"])
		})

		it("matches every word of a longer search, in any order", async () => {
			expect(codes(await store.searchCachedItems("fruit red"))).toEqual(["A-1"])
			expect(await store.searchCachedItems("fruit blue")).toEqual([])
		})

		it("never finds a disabled item", async () => {
			expect(await store.searchCachedItems("disabled")).toEqual([])
		})

		it("finds a variant by search though it is hidden from browsing", async () => {
			expect(codes(await store.searchCachedItems("TPL-S"))).toEqual(["TPL-S"])
		})

		it("filters by group, sorted and paged", async () => {
			expect(codes(await store.searchCachedItemsByGroup(["Group 1"]))).toEqual(["A-1", "B-2", "TPL"])
			expect(codes(await store.searchCachedItemsByGroup(["Group 1", "Group 2"], 2, 1))).toEqual(["B-2", "C-3"])
			expect(await store.countCachedItemsByGroup(["Group 1"])).toBe(3)
			expect(await store.countCachedItemsByGroup([])).toBe(4)
		})

		it("falls back to browsing without a group or brand", async () => {
			expect(codes(await store.searchCachedItemsByGroup([], 1))).toEqual(["A-1"])
			expect(codes(await store.searchCachedItemsByBrand("", 1, 1))).toEqual(["B-2"])
		})

		it("filters by brand", async () => {
			expect(codes(await store.searchCachedItemsByBrand("Acme"))).toEqual(["C-3"])
			expect(await store.searchCachedItemsByBrand("Nobody")).toEqual([])
		})

		it("reads one item, a barcode and the variants of a template", async () => {
			expect((await store.getCachedItem("A-1")).item_name).toBe("Apple")
			expect(await store.getCachedItem("nope")).toBeUndefined()
			expect((await store.getCachedItemByBarcode("1234567890")).item_code).toBe("A-1")
			expect(await store.getCachedItemByBarcode("0")).toBeUndefined()
			expect(codes(await store.getCachedVariants("TPL"))).toEqual(["TPL-S"])
		})

		it("reads barcodes in each format the server sends them", async () => {
			await store.cacheItems([
				item("P-1", { barcode: "111" }),
				item("P-2", { item_barcode: [{ barcode: "222" }, { barcode: "223" }] }),
				item("P-3", { item_barcode: "333" }),
			])

			for (const [barcode, itemCode] of [["111", "P-1"], ["223", "P-2"], ["333", "P-3"]]) {
				expect(codes(await store.searchCachedItems(barcode))).toEqual([itemCode])
			}
			expect((await store.getCachedItem("P-2")).barcodes).toEqual(["222", "223"])
		})

		it("stops finding a barcode the server took away", async () => {
			await store.cacheItems([item("A-1", { item_name: "Apple", barcodes: ["999"] })])

			expect(await store.getCachedItemByBarcode("1234567890")).toBeUndefined()
			expect((await store.getCachedItemByBarcode("999")).item_code).toBe("A-1")
		})

		it("keeps a price per price list, with a default list", async () => {
			await store.cacheItems([
				item("P-1", { rate: 5, selling_price_list: "Retail" }),
				item("P-2", { price_list_rate: 7 }),
				item("P-3"),
			])

			expect(await store.getCachedItemPrice("Retail", "P-1")).toBe(5)
			expect(await store.getCachedItemPrice("Standard", "P-2")).toBe(7)
			expect(await store.getCachedItemPrice("Standard", "P-3")).toBeUndefined()
		})

		it("counts what the screen shows", async () => {
			const stats = await store.getCacheStats()

			expect(stats.items).toBe(5)
			expect(stats.customers).toBe(0)
			expect(stats.queuedInvoices).toBe(0)
			expect(stats.cacheReady).toBe(true)
			expect(stats.lastSync).toBeGreaterThan(0)
		})

		it("updates stock on the items it holds, and only those", async () => {
			const result = await store.updateStockQuantities([
				{ item_code: "A-1", warehouse: "W1", actual_qty: 7 },
				{ item_code: "B-2", stock_qty: 3 },
				{ item_code: "not cached", actual_qty: 1 },
				{ warehouse: "W1", actual_qty: 1 },
			])

			expect(result).toEqual({ success: true, updated: 2 })
			expect(await store.getCachedItem("A-1")).toMatchObject({ actual_qty: 7, stock_qty: 7, warehouse: "W1" })
			expect(await store.getCachedItem("B-2")).toMatchObject({ actual_qty: 3, stock_qty: 3 })
			expect(await store.updateStockQuantities([])).toEqual({ success: true, updated: 0 })
		})

		it("keeps batch and serial data through a stock update", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "B1", batch_qty: 5 }] })

			await store.updateStockQuantities([{ item_code: "A-1", actual_qty: 9 }])

			const cached = await store.getCachedItem("A-1")
			expect(cached.actual_qty).toBe(9)
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1", batch_qty: 5 }])
		})

		it("keeps batch and serial data when the server sends the item again", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { serial_no_data: [{ serial_no: "S1" }] })

			await store.cacheItems([item("A-1", { item_name: "Apple 2" })])

			const cached = await store.getCachedItem("A-1")
			expect(cached.item_name).toBe("Apple 2")
			expect(cached.serial_no_data).toEqual([{ serial_no: "S1" }])
		})

		it("lets a server row that carries batch data replace the cached one", async () => {
			const { persistItemBatchSerialData } = await import("@/utils/offline/items")
			await persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "OLD" }] })

			await store.cacheItems([item("A-1", { batch_no_data: [{ batch_no: "NEW" }] })])

			expect((await store.getCachedItem("A-1")).batch_no_data).toEqual([{ batch_no: "NEW" }])
		})

		it("removes whole groups with their prices", async () => {
			await store.cacheItems([item("P-1", { item_group: "Gone", rate: 5 })])

			expect(await store.removeItemsByGroups(["Gone"])).toMatchObject({ success: true, removed: 1, pricesRemoved: 1 })
			expect(await store.getCachedItem("P-1")).toBeUndefined()
			expect(await store.getCachedItemPrice("Standard", "P-1")).toBeUndefined()
			expect(await store.removeItemsByGroups([])).toEqual({ success: true, removed: 0, pricesRemoved: 0 })
		})

		it("clears items and prices", async () => {
			await store.cacheItems([item("P-1", { rate: 5 })])

			expect(await store.clearItemsCache()).toEqual({ success: true })

			expect(await store.isCacheReady()).toBe(false)
			expect(await store.getCachedItemPrice("Standard", "P-1")).toBeUndefined()
			expect((await store.getCacheStats()).lastSync).toBeNull()
		})
	})

	describe("batches and serials through utils/offline/items", () => {
		let items

		beforeEach(async () => {
			items = await import("@/utils/offline/items")
			await store.cacheItems([item("A-1")])
		})

		it("consumes and returns serials", async () => {
			await items.persistItemBatchSerialData("A-1", {
				serial_no_data: [
					{ serial_no: "S1", warehouse: "W1" },
					{ serial_no: "S2", warehouse: "W1" },
				],
			})

			await items.consumeCachedSerials("A-1", "S1")
			expect((await items.getCachedSerialData("A-1")).map((s) => s.serial_no)).toEqual(["S2"])

			await items.returnCachedSerials("A-1", ["S1"])
			expect((await items.getCachedSerialData("A-1")).map((s) => s.serial_no)).toEqual(["S1", "S2"])
		})

		describe("through the serial number store, with nothing in memory", () => {
			let serialStore

			const serialsLeft = async () => (await items.getCachedSerialData("A-1")).map((serial) => serial.serial_no)

			beforeEach(async () => {
				const { createPinia, setActivePinia } = await import("pinia")
				const { useSerialNumberStore } = await import("@/stores/serialNumber")
				setActivePinia(createPinia())
				serialStore = useSerialNumberStore()
				serialStore.setWarehouse("W1")
				await items.persistItemBatchSerialData("A-1", { serial_no_data: [{ serial_no: "S1", warehouse: "W1" }] })
			})

			it("takes a serial that goes into the cart off the device", async () => {
				serialStore.consumeSerials("A-1", ["S1"])

				await vi.waitFor(async () => expect(await serialsLeft()).toEqual([]))
			})

			it("gives back even the last serial when the cart is abandoned", async () => {
				serialStore.consumeSerials("A-1", ["S1"])
				await vi.waitFor(async () => expect(await serialsLeft()).toEqual([]))

				serialStore.returnSerials("A-1", "S1")

				await vi.waitFor(async () => expect(await serialsLeft()).toEqual(["S1"]))
			})
		})

		it("deducts a sold batch and never goes below zero", async () => {
			await items.persistItemBatchSerialData("A-1", {
				batch_no_data: [
					{ batch_no: "B1", batch_qty: 5 },
					{ batch_no: "B2", batch_qty: 1 },
				],
			})

			await items.deductCachedBatchQty("A-1", "B1", 2)
			await items.deductCachedBatchQty("A-1", "B2", 9)

			expect((await items.getCachedBatchData("A-1")).map((b) => b.batch_qty)).toEqual([3, 0])
		})

		it("does not invent an item it does not hold", async () => {
			expect(await items.persistItemBatchSerialData("ghost", { batch_no_data: [] })).toBe(false)
			expect(await store.getCachedItem("ghost")).toBeUndefined()
		})

		it("updates several items in one call, skipping unknown ones", async () => {
			await items.updateItemBatchSerialData({
				"A-1": { batch_no_data: [{ batch_no: "B1" }] },
				ghost: { serial_no_data: [{ serial_no: "S" }] },
			})

			const cached = await store.getCachedItem("A-1")
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1" }])
			expect(cached.serial_no_data).toEqual([])
			expect(await store.getCachedItem("ghost")).toBeUndefined()
		})

		it("merges a page of items without touching batch data", async () => {
			await items.persistItemBatchSerialData("A-1", { batch_no_data: [{ batch_no: "B1" }] })

			await items.cacheItems([item("A-1", { item_barcode: [{ barcode: "555" }], rate: 3 })], "Retail")

			expect((await store.getCachedItem("A-1")).batch_no_data).toEqual([{ batch_no: "B1" }])
			expect((await items.getItemByBarcode("555")).item_code).toBe("A-1")
			expect((await items.getItemWithPrice("A-1", "Retail")).rate).toBe(3)
			expect(await items.getItemsLastSync()).toBeGreaterThan(0)
		})
	})

	describe("customers", () => {
		const customers = [
			{ name: "CUST-2", customer_name: "Sara Ali", mobile_no: "0551112222" },
			{ name: "CUST-1", customer_name: "Omar Hassan", mobile_no: "0553334444" },
		]

		beforeEach(async () => {
			await store.cacheCustomers(customers)
		})

		const names = (rows) => rows.map((row) => row.name)

		it("searches inside the name, mobile number and id, in any case", async () => {
			expect(names(await store.searchCachedCustomers("ali"))).toEqual(["CUST-2"])
			expect(names(await store.searchCachedCustomers("3334"))).toEqual(["CUST-1"])
			expect(names(await store.searchCachedCustomers("cust-1"))).toEqual(["CUST-1"])
			expect(await store.searchCachedCustomers("nobody")).toEqual([])
		})

		it("lists them, limited or whole", async () => {
			expect(names(await store.searchCachedCustomers("", 1))).toEqual(["CUST-1"])
			expect(await store.searchCachedCustomers("", 0)).toHaveLength(2)
			expect(await store.searchCachedCustomers("055", 1)).toHaveLength(1)
			expect(await store.searchCachedCustomers("055", 0)).toHaveLength(2)
		})

		it("gives each one back whole", async () => {
			expect(await store.getCachedCustomer("CUST-1")).toEqual(customers[1])
			expect(await store.getCachedCustomer("nope")).toBeUndefined()
		})

		it("deletes and clears", async () => {
			await store.deleteCustomers(["CUST-1"])
			expect(names(await store.searchCachedCustomers(""))).toEqual(["CUST-2"])
			expect(await store.deleteCustomers([])).toBe(true)

			await store.clearCustomersCache()
			expect(await store.searchCachedCustomers("")).toEqual([])
			expect(await store.getSetting("customers_last_sync")).toBeNull()
		})
	})

	describe("payment methods and sales persons", () => {
		it("keeps payment methods by profile", async () => {
			expect(
				await store.cachePaymentMethods([
					{ mode_of_payment: "Cash", pos_profile: "P1", default: 1 },
					{ mode_of_payment: "Card", pos_profile: "P2" },
				]),
			).toEqual({ success: true, count: 2 })

			expect(await store.getCachedPaymentMethods("P1")).toEqual([
				{ mode_of_payment: "Cash", pos_profile: "P1", default: 1 },
			])
			expect(await store.getCachedPaymentMethods()).toHaveLength(2)
			expect(await store.getSetting("payment_methods_last_sync")).toBeGreaterThan(0)
		})

		it("keeps sales persons by profile", async () => {
			await store.cacheSalesPersons([
				{ name: "Ali", pos_profile: "P1" },
				{ name: "Sara", pos_profile: "P2" },
			])

			expect(await store.getCachedSalesPersons("P2")).toEqual([{ name: "Sara", pos_profile: "P2" }])
			expect(await store.getCachedSalesPersons()).toHaveLength(2)
		})
	})

	describe("offers", () => {
		const nextYear = `${new Date().getFullYear() + 1}-01-01`

		it("replaces a profile's offers and leaves out expired ones", async () => {
			await store.cacheOffers([{ name: "OLD", valid_upto: nextYear }], "P1")

			expect(
				await store.cacheOffers(
					[{ name: "LIVE", valid_upto: nextYear }, { name: "FOREVER" }, { name: "EXPIRED", valid_upto: "2020-01-01" }],
					"P1",
				),
			).toEqual({ success: true, count: 3 })

			expect((await store.getCachedOffers("P1")).map((offer) => offer.name).sort()).toEqual(["FOREVER", "LIVE"])
		})

		it("keeps profiles apart", async () => {
			await store.cacheOffers([{ name: "A" }], "P1")
			await store.cacheOffers([{ name: "B" }], "P2")

			await store.clearOffersCache("P1")

			expect(await store.getCachedOffers("P1")).toEqual([])
			expect((await store.getCachedOffers("P2")).map((offer) => offer.name)).toEqual(["B"])
		})

		it("clears every profile when none is named", async () => {
			await store.cacheOffers([{ name: "A" }], "P1")
			await store.clearOffersCache()
			expect(await store.getCachedOffers("P1")).toEqual([])
		})

		it("refuses a call without offers or a profile", async () => {
			expect(await store.cacheOffers(null, "P1")).toEqual({ success: false, count: 0 })
			expect(await store.cacheOffers([], "")).toEqual({ success: false, count: 0 })
			expect(await store.getCachedOffers("")).toEqual([])
		})
	})

	describe("settings", () => {
		it("gives back what was stored, or the default", async () => {
			await store.setSetting("rules", { rate: 15, names: ["VAT"] })

			expect(await store.getSetting("rules")).toEqual({ rate: 15, names: ["VAT"] })
			expect(await store.getSetting("missing", "fallback")).toBe("fallback")
			expect(await store.getSetting("missing")).toBeNull()
		})

		it("keeps a stored false or null rather than the default", async () => {
			await store.setSetting("flag", false)
			await store.setSetting("nothing", null)

			expect(await store.getSetting("flag", true)).toBe(false)
			expect(await store.getSetting("nothing", "fallback")).toBeNull()
		})

		it("deletes by prefix", async () => {
			await store.setSetting("print_format_template_a", 1)
			await store.setSetting("print_format_template_b", 2)
			await store.setSetting("print_other", 3)

			await store.deleteSettingsByPrefix("print_format_template_")

			expect(await store.getSetting("print_format_template_a")).toBeNull()
			expect(await store.getSetting("print_other")).toBe(3)
		})
	})

	describe("clearing cached data", () => {
		beforeEach(async () => {
			await store.cacheItems([item("A-1", { rate: 5 })])
			await store.cacheCustomers([{ name: "C", customer_name: "C" }])
			await store.cachePaymentMethods([{ mode_of_payment: "Cash", pos_profile: "P" }])
			await store.cacheSalesPersons([{ name: "S", pos_profile: "P" }])
			await store.saveOfflineInvoice(invoice())
			await store.addDraft({ draft_id: "D", created_at: "2026-01-01" })
			await store.setSetting("key", 1)
		})

		it("keeps sales, drafts and settings by default", async () => {
			expect((await store.clearCachedData()).success).toBe(true)

			expect(await store.isCacheReady()).toBe(false)
			expect(await store.getCachedItemPrice("Standard", "A-1")).toBeUndefined()
			expect(await store.searchCachedCustomers("")).toEqual([])
			expect(await store.getCachedPaymentMethods("P")).toEqual([])
			expect(await store.getCachedSalesPersons("P")).toEqual([])

			expect(await store.getOfflineInvoiceCount()).toBe(1)
			expect(await store.countDrafts()).toBe(1)
			expect(await store.getSetting("key")).toBe(1)
		})

		it("keeps payment methods when asked, for a cache version upgrade", async () => {
			await store.clearCachedData({ preservePaymentMethods: true })
			expect(await store.getCachedPaymentMethods("P")).toHaveLength(1)
		})

		it("clears sales and settings only when told to", async () => {
			await store.clearCachedData({ preserveInvoices: false, preserveSettings: false })

			expect(await store.getOfflineInvoiceCount()).toBe(0)
			expect(await store.getSetting("key")).toBeNull()
			expect(await store.countDrafts()).toBe(1)
		})
	})

	describe("invoice history through utils/offline/sync", () => {
		let sync

		const history = [
			{ name: "A", customer: "Ali", posting_date: "2026-01-01", posting_time: "10:00:00" },
			{ name: "B", customer: "Sara", posting_date: "2026-03-01", posting_time: "10:00:00" },
			{ name: "C", customer: "Ali Omar", posting_date: "2026-02-01" },
		]

		beforeEach(async () => {
			sync = await import("@/utils/offline/sync")
			await sync.cacheInvoiceHistory(history, "P1")
			await sync.cacheInvoiceHistory([{ name: "Z", customer: "Zed", posting_date: "2026-01-01" }], "P2")
		})

		const names = (rows) => rows.map((row) => row.name)

		it("reads newest first, by profile", async () => {
			expect(names(await sync.getCachedInvoiceHistory("P1"))).toEqual(["B", "C", "A"])
			expect(await sync.getCachedInvoiceHistory()).toHaveLength(4)
		})

		it("filters by customer and dates, and limits", async () => {
			expect(names(await sync.getCachedInvoiceHistory("P1", { customer: "ali" }))).toEqual(["C", "A"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { fromDate: "2026-02-01" }))).toEqual(["B", "C"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { toDate: "2026-01-31" }))).toEqual(["A"])
			expect(names(await sync.getCachedInvoiceHistory("P1", { limit: 1 }))).toEqual(["B"])
		})

		it("clears one profile or all of them", async () => {
			await sync.clearInvoiceHistoryCache("P1")
			expect(await sync.getCachedInvoiceHistory("P1")).toEqual([])
			expect(await sync.getCachedInvoiceHistory()).toHaveLength(1)

			await sync.clearInvoiceHistoryCache()
			expect(await sync.getCachedInvoiceHistory()).toEqual([])
		})
	})

	describe("unpaid invoices through utils/offline/sync", () => {
		let sync

		beforeEach(async () => {
			sync = await import("@/utils/offline/sync")
		})

		it("replaces a profile's list and reads the largest amount first", async () => {
			await sync.cacheUnpaidInvoices([{ name: "OLD", outstanding_amount: 1 }], "P1")
			await sync.cacheUnpaidInvoices(
				[
					{ name: "A", outstanding_amount: 10 },
					{ name: "B", outstanding_amount: 50 },
				],
				"P1",
			)
			await sync.cacheUnpaidInvoices([{ name: "C", outstanding_amount: 99 }], "P2")

			expect((await sync.getCachedUnpaidInvoices("P1")).map((row) => row.name)).toEqual(["B", "A"])
			expect((await sync.getCachedUnpaidInvoices("P1", { limit: 1 })).map((row) => row.name)).toEqual(["B"])
			expect(await sync.getCachedUnpaidInvoices("")).toEqual([])
		})

		it("empties a profile that has nothing unpaid any more", async () => {
			await sync.cacheUnpaidInvoices([{ name: "A", outstanding_amount: 10 }], "P1")
			expect(await sync.cacheUnpaidInvoices([], "P1")).toBe(true)
			expect(await sync.getCachedUnpaidInvoices("P1")).toEqual([])
		})

		it("keeps the summary", async () => {
			await sync.cacheUnpaidSummary({ count: 2, total_outstanding: 60, total_paid: 5 }, "P1")

			expect(await sync.getCachedUnpaidSummary("P1")).toMatchObject({ count: 2, total_outstanding: 60 })
			expect(await sync.getCachedUnpaidSummary("P2")).toEqual({ count: 0, total_outstanding: 0, total_paid: 0 })
		})
	})

	describe("translations through utils/offline/translationCache", () => {
		it("survives losing the memory copy", async () => {
			const { translationCache } = await import("@/utils/offline/translationCache")
			await translationCache.set("AR", { Hello: "مرحبا" }, 1000)

			vi.resetModules()
			const fresh = (await import("@/utils/offline/translationCache")).translationCache

			expect(await fresh.get("ar")).toEqual({ locale: "ar", messages: { Hello: "مرحبا" }, timestamp: 1000 })
			expect(await fresh.get("fr")).toBeNull()
		})

		it("clears one locale or all of them", async () => {
			const { translationCache } = await import("@/utils/offline/translationCache")
			await translationCache.set("ar", { a: "1" })
			await translationCache.set("en", { a: "2" })

			expect(await translationCache.clear("ar")).toBe(true)
			expect(await store.getTranslations("ar")).toBeNull()
			expect(await store.getTranslations("en")).not.toBeNull()

			expect(await translationCache.clear()).toBe(true)
			expect(await store.getTranslations("en")).toBeNull()
		})
	})

	describe("drafts through utils/draftManager", () => {
		let drafts

		beforeEach(async () => {
			drafts = await import("@/utils/draftManager")
		})

		it("saves, reads back and counts", async () => {
			const draft = await drafts.saveDraft({ customer: "CUST-1", items: [{ item_code: "A" }] })

			expect(draft.draft_id).toMatch(/^DRAFT-/)
			expect(await drafts.getDraftById(draft.draft_id)).toMatchObject({ customer: "CUST-1" })
			expect(await drafts.getDraftById("nope")).toBeUndefined()
			expect(await drafts.getDraftsCount()).toBe(1)
		})

		it("updates in place, keeping when it was created", async () => {
			const draft = await drafts.saveDraft({ customer: "OLD" })

			const updated = await drafts.updateDraft(draft.draft_id, { customer: "NEW" })

			expect(updated.created_at).toBe(draft.created_at)
			expect(await drafts.getDraftsCount()).toBe(1)
			expect((await drafts.getDraftById(draft.draft_id)).customer).toBe("NEW")
			await expect(drafts.updateDraft("nope", {})).rejects.toThrow("Draft not found")
		})

		it("lists the newest first", async () => {
			await store.addDraft({ draft_id: "OLD", created_at: "2026-01-01T00:00:00Z" })
			await store.addDraft({ draft_id: "NEW", created_at: "2026-02-01T00:00:00Z" })

			expect((await drafts.getAllDrafts()).map((draft) => draft.draft_id)).toEqual(["NEW", "OLD"])
		})

		it("deletes one or all", async () => {
			const first = await drafts.saveDraft({})
			const second = await drafts.saveDraft({})

			expect(await drafts.deleteDraft(first.draft_id)).toBe(true)
			expect((await drafts.getAllDrafts()).map((draft) => draft.draft_id)).toEqual([second.draft_id])
			await expect(drafts.deleteDraft("nope")).rejects.toThrow("Draft not found")

			expect(await drafts.clearAllDrafts()).toBe(true)
			expect(await drafts.getDraftsCount()).toBe(0)
		})
	})

	describe("the print queue", () => {
		const job = (jobId, data = [27, 64, 200, 255]) => ({
			jobId,
			data: new Uint8Array(data),
			priority: "normal",
			status: "pending",
			retries: 0,
			maxRetries: 3,
			createdAt: 1000,
		})

		it("keeps the bytes of a job intact", async () => {
			await store.putPrintJob(job("J1"))

			const [saved] = await store.listPrintJobs()
			expect(saved.jobId).toBe("J1")
			expect(ArrayBuffer.isView(saved.data)).toBe(true)
			expect([...saved.data]).toEqual([27, 64, 200, 255])
		})

		it("replaces a job by id and deletes it", async () => {
			await store.putPrintJob(job("J1"))
			await store.putPrintJob({ ...job("J1"), status: "failed" })
			expect((await store.listPrintJobs()).map((saved) => saved.status)).toEqual(["failed"])

			await store.deletePrintJob("J1")
			expect(await store.listPrintJobs()).toEqual([])
		})
	})

	describe("the open shift", () => {
		it("is kept, replaced and cleared", async () => {
			expect(await store.getShift()).toBeNull()

			await store.saveShift({ pos_opening_shift: { name: "SHIFT-1" }, _receivedAt: 5 })
			await store.saveShift({ pos_opening_shift: { name: "SHIFT-2" }, _receivedAt: 6 })
			expect(await store.getShift()).toEqual({ pos_opening_shift: { name: "SHIFT-2" }, _receivedAt: 6 })

			await store.clearShift()
			expect(await store.getShift()).toBeNull()
		})
	})

	describe("the shift kept on the device", () => {
		const CASHIER = "a@example.com"
		const OTHER_CASHIER = "b@example.com"

		const keptShift = (user = CASHIER, name = "SHIFT-1") => ({
			pos_opening_shift: { name, user },
			pos_profile: { name: "Main" },
			company: { name: "Acme" },
			_initialElapsedMs: 5,
			_receivedAt: 6,
		})

		const signInAs = (user) => {
			document.cookie = `user_id=${user}; path=/`
		}

		const serverIsUnreachable = () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new TypeError("Failed to fetch")
				}),
			)
		}

		// Clearing the shift is not awaited by whoever asks for it
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

		let shiftStore
		let shiftState
		let markShiftClosing
		let resetShiftState
		let cleanupUserSession

		beforeEach(async () => {
			setActivePinia(createPinia())
			;({ cleanupUserSession } = await import("@/utils/sessionCleanup"))
			;({ shiftState, markShiftClosing, resetShiftState } = await import("@/composables/useShift"))
			const { usePOSShiftStore } = await import("@/stores/posShift")
			shiftStore = usePOSShiftStore()
			signInAs(CASHIER)
			await store.saveShift(keptShift())
		})

		afterEach(() => {
			document.cookie = "user_id=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
		})

		it("survives the sign-out, and comes back to its cashier offline", async () => {
			await cleanupUserSession()
			expect(shiftState.value.isOpen).toBe(false)
			expect(await store.getShift()).toEqual(keptShift())

			serverIsUnreachable()
			expect(await shiftStore.checkShift()).toBe(true)

			expect(shiftStore.currentShift.name).toBe("SHIFT-1")
			expect(shiftStore.profileName).toBe("Main")
		})

		it("goes to nobody else", async () => {
			await cleanupUserSession()

			signInAs(OTHER_CASHIER)
			serverIsUnreachable()

			expect(await shiftStore.checkShift()).toBe(false)
			expect(shiftState.value.pos_opening_shift).toBeNull()
		})

		it("waits for its cashier while somebody else is signed in", async () => {
			await cleanupUserSession()

			signInAs(OTHER_CASHIER)
			serverIsUnreachable()
			await shiftStore.checkShift()
			await cleanupUserSession()

			signInAs(CASHIER)
			expect(await shiftStore.checkShift()).toBe(true)
		})

		it("goes to nobody while nobody is signed in", async () => {
			await cleanupUserSession()

			signInAs("Guest")
			serverIsUnreachable()

			expect(await shiftStore.checkShift()).toBe(false)
		})

		it("stays when the server says another cashier has no shift", async () => {
			signInAs(OTHER_CASHIER)
			fetchResponses.set("check_opening_shift", { message: null })

			expect(await shiftStore.checkShift()).toBe(false)
			await settle()

			expect(await store.getShift()).toEqual(keptShift())
		})

		it("goes when the server says its own cashier has no shift", async () => {
			fetchResponses.set("check_opening_shift", { message: null })

			expect(await shiftStore.checkShift()).toBe(false)
			await settle()

			expect(await store.getShift()).toBeNull()
		})

		it("goes when its shift closes, even if the cashier signs out straight after", async () => {
			resetShiftState()
			signInAs("Guest")
			await settle()

			expect(await store.getShift()).toBeNull()
		})

		it("gives way to another cashier's own shift", async () => {
			signInAs(OTHER_CASHIER)
			fetchResponses.set("check_opening_shift", {
				message: {
					pos_opening_shift: { name: "SHIFT-2", user: OTHER_CASHIER },
					pos_profile: { name: "Main" },
					company: { name: "Acme" },
				},
			})

			expect(await shiftStore.checkShift()).toBe(true)
			await settle()

			expect((await store.getShift()).pos_opening_shift.name).toBe("SHIFT-2")
		})

		describe("closed offline", () => {
			const serverStillReportsItOpen = () => {
				fetchResponses.set("check_opening_shift", { message: keptShift() })
			}

			beforeEach(async () => {
				markShiftClosing("SHIFT-1")
				await store.clearShift()
			})

			it("does not reopen while the server has not heard of the close", async () => {
				serverStillReportsItOpen()

				expect(await shiftStore.checkShift()).toBe(false)
				await settle()

				expect(shiftState.value.isOpen).toBe(false)
				expect(await store.getShift()).toBeNull()
			})

			it("does not reopen after the cache is cleared", async () => {
				const { clearBrowserCache } = await import("@/utils/offline/cache")
				clearBrowserCache()
				serverStillReportsItOpen()

				expect(await shiftStore.checkShift()).toBe(false)
			})

			it("does not come back from a copy left on the device", async () => {
				await store.saveShift(keptShift())
				serverIsUnreachable()

				expect(await shiftStore.checkShift()).toBe(false)
			})

			it("leaves the cashier's next shift alone", async () => {
				fetchResponses.set("check_opening_shift", { message: keptShift(CASHIER, "SHIFT-2") })

				expect(await shiftStore.checkShift()).toBe(true)
				expect(shiftStore.currentShift.name).toBe("SHIFT-2")
			})
		})

		describe("opened offline", () => {
			const cached = {
				pos_profile: { name: "Main", company: "Acme", customer: "Walk-in" },
				company: { name: "Acme" },
			}
			const amounts = [{ mode_of_payment: "Cash", opening_amount: 100 }]

			const serverReports = (shift) => {
				fetchResponses.set("check_opening_shift", {
					message: shift && {
						pos_opening_shift: shift,
						pos_profile: { name: "Main" },
						company: { name: "Acme" },
					},
				})
			}

			let syncStore
			let local
			let useShift

			const createSyncStore = async () => {
				const { usePOSSyncStore } = await import("@/stores/posSync")

				// Its timers would outlive this store and the database behind it
				const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => 0)
				const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0)
				const created = usePOSSyncStore()
				timeout.mockRestore()
				interval.mockRestore()

				created.isOffline = true
				return created
			}

			beforeEach(async () => {
				vi.stubGlobal("__", (text) => text)
				await store.clearShift()
				const { session } = await import("@/data/session")
				session.user = CASHIER
				syncStore = await createSyncStore()
				useShift = await import("@/composables/useShift")
				await syncStore.saveShiftOpenOffline(cached, amounts)
				local = shiftStore.currentShift.name
			})

			it("takes the one slot and keeps one record, under the same name", async () => {
				expect(local.startsWith("pos_offline_")).toBe(true)
				expect((await store.getShift()).pos_opening_shift.name).toBe(local)

				const rows = await store.getQueueRows()
				expect(rows).toHaveLength(1)
				expect(rows[0].entity).toBe("shift_open")
				expect(rows[0].offline_id).toBe(local)
				expect(rows[0].data.balance_details).toEqual(amounts)
				expect(rows[0].data.cashier).toBe(CASHIER)
			})

			it("sells from the cached profile", () => {
				expect(shiftStore.hasOpenShift).toBe(true)
				expect(shiftStore.profileName).toBe("Main")
				expect(shiftStore.profileCompany).toBe("Acme")
				expect(shiftStore.profileCustomer).toBe("Walk-in")
			})

			it("cannot be opened twice", async () => {
				await expect(syncStore.saveShiftOpenOffline(cached, amounts)).rejects.toThrow()

				expect(await store.getQueueRows()).toHaveLength(1)
			})

			it("makes a sale depend on it, on every platform", async () => {
				const { offline_id } = await store.saveOfflineInvoice(invoice({ posa_pos_opening_shift: local }))

				expect((await store.getQueuedInvoice(offline_id)).depends_on).toEqual([local])
			})

			it("makes a payment depend on it", async () => {
				const { offline_id } = await syncStore.savePaymentOffline(
					{ name: "SINV-1", outstanding_amount: 50 },
					[{ mode_of_payment: "Cash", amount: 10 }],
				)

				expect((await store.getQueuedInvoice(offline_id)).depends_on).toEqual([local])
			})

			it("makes its close depend on it and on its sales", async () => {
				const sale = await store.saveOfflineInvoice(invoice({ posa_pos_opening_shift: local }))

				const { offline_id } = await syncStore.saveShiftCloseOffline({
					pos_opening_shift: local,
					opening_offline_id: local,
					pos_profile: "Main",
					company: "Acme",
					payment_reconciliation: [],
				})

				expect((await store.getQueuedInvoice(offline_id)).depends_on).toEqual([local, sale.offline_id])
			})

			it("does not lose the sales made before it got its real name", async () => {
				const sale = await store.saveOfflineInvoice(invoice({ posa_pos_opening_shift: local }))

				const { offline_id } = await syncStore.saveShiftCloseOffline({
					pos_opening_shift: "POSA-OS-1",
					opening_offline_id: local,
					pos_profile: "Main",
					company: "Acme",
					payment_reconciliation: [],
				})

				const close = await store.getQueuedInvoice(offline_id)
				expect(close.depends_on).toEqual([sale.offline_id])
				expect(close.data.manifest).toEqual([sale.offline_id])
			})

			it("makes the next shift wait for the close before it", async () => {
				const close = await syncStore.saveShiftCloseOffline({
					pos_opening_shift: local,
					opening_offline_id: local,
					pos_profile: "Main",
					company: "Acme",
					payment_reconciliation: [],
				})
				resetShiftState()
				await settle()

				await syncStore.saveShiftOpenOffline(cached, amounts)

				const next = await store.getQueuedInvoice(shiftStore.currentShift.name)
				expect(next.depends_on).toEqual([close.offline_id])
			})

			it("survives the sign-out, and comes back to its cashier offline", async () => {
				await cleanupUserSession()
				serverIsUnreachable()

				expect(await shiftStore.checkShift()).toBe(true)
				expect(shiftStore.currentShift.name).toBe(local)
			})

			it("goes to nobody else, and keeps the slot from them", async () => {
				await cleanupUserSession()
				signInAs(OTHER_CASHIER)
				serverIsUnreachable()

				expect(await shiftStore.checkShift()).toBe(false)
				expect(await useShift.isShiftSlotTaken()).toBe(true)
			})

			it("does not count as taken for its own cashier", async () => {
				expect(await useShift.isShiftSlotTaken()).toBe(false)
			})

			it("stays when the server has not heard of it", async () => {
				serverReports(null)

				expect(await shiftStore.checkShift()).toBe(true)
				await settle()

				expect(shiftStore.currentShift.name).toBe(local)
				expect((await store.getShift()).pos_opening_shift.name).toBe(local)
			})

			it("stays when the server knows another open shift of this cashier", async () => {
				serverReports({ name: "POSA-OS-9", user: CASHIER })

				expect(await shiftStore.checkShift()).toBe(true)
				await settle()

				expect(shiftStore.currentShift.name).toBe(local)
				expect((await store.getShift()).pos_opening_shift.name).toBe(local)
			})

			it("gives way to its own server copy", async () => {
				serverReports({ name: "POSA-OS-1", user: CASHIER, offline_id: local })

				expect(await shiftStore.checkShift()).toBe(true)
				await settle()

				expect(shiftStore.currentShift.name).toBe("POSA-OS-1")
				expect((await store.getShift()).pos_opening_shift.name).toBe("POSA-OS-1")
			})

			it("ends when its record is finished and the server has no such shift", async () => {
				const { id } = await store.getQueuedInvoice(local)
				await store.updateQueuedInvoice(id, { synced: true, server_status: "voided" })
				serverReports(null)

				expect(await shiftStore.checkShift()).toBe(false)
				await settle()

				expect(await store.getShift()).toBeNull()
			})

			it("takes the server's name when its record ends", async () => {
				expect(await useShift.adoptServerShift(local, "POSA-OS-1")).toBe(true)

				expect(shiftStore.currentShift.name).toBe("POSA-OS-1")
				expect(shiftStore.currentShift.offline_id).toBe(local)
				expect((await store.getShift()).pos_opening_shift.name).toBe("POSA-OS-1")
				expect(useShift.hasLocalShift.value).toBe(false)
			})

			it("leaves a colleague's work alone when it takes the name", async () => {
				await store.saveShift(keptShift(OTHER_CASHIER, "SHIFT-9"))
				useShift.shiftState.value = { ...useShift.shiftState.value, pos_opening_shift: { name: "SHIFT-9" } }

				expect(await useShift.adoptServerShift(local, "POSA-OS-1")).toBe(false)

				expect((await store.getShift()).pos_opening_shift.name).toBe("SHIFT-9")
				expect(shiftStore.currentShift.name).toBe("SHIFT-9")
			})

			it("reaches the name through the queue", async () => {
				const { syncOfflineInvoices } = await import("@/utils/offline/sync")
				const { offlineState } = await import("@/utils/offline/offlineState")
				callServer.mockImplementation(async (method) =>
					method.endsWith("push")
						? { results: [{ offline_id: local, status: "received" }] }
						: [{ offline_id: local, status: "synced", invoice: "POSA-OS-1" }],
				)
				serverReports({ name: "POSA-OS-1", user: CASHIER, offline_id: local })

				expect(offlineState.isOffline).toBe(false)
				await syncOfflineInvoices()
				await settle()

				expect(callServer.mock.calls[0][1].items[0].entity).toBe("shift_open")
				expect(shiftStore.currentShift.name).toBe("POSA-OS-1")
				expect(useShift.hasLocalShift.value).toBe(false)
			})

			it("ends when a manager voids it", async () => {
				expect(await useShift.abandonLocalShift(local)).toBe(true)

				expect(shiftStore.hasOpenShift).toBe(false)
				expect(await store.getShift()).toBeNull()
			})

			it("ends through the queue when a manager voids it", async () => {
				const { syncOfflineInvoices } = await import("@/utils/offline/sync")
				callServer.mockImplementation(async (method) =>
					method.endsWith("push")
						? { results: [{ offline_id: local, status: "received" }] }
						: [{ offline_id: local, status: "voided" }],
				)

				await syncOfflineInvoices()
				await settle()

				expect(shiftStore.hasOpenShift).toBe(false)
				expect(await store.getShift()).toBeNull()
			})

			it("stays closed when its server copy still reports open", async () => {
				markShiftClosing(local)
				await store.clearShift()
				serverReports({ name: "POSA-OS-1", user: CASHIER, offline_id: local })

				expect(await shiftStore.checkShift()).toBe(false)
			})

			it("reports what it can open for this cashier only", async () => {
				const { useShift: shiftResources } = useShift
				serverReports({ name: "POSA-OS-9", user: CASHIER })
				resetShiftState()
				await settle()
				await store.clearShift()

				await shiftResources().checkOpeningShift.fetch()
				await settle()

				expect((await useShift.getCachedShiftProfiles()).map(({ pos_profile }) => pos_profile.name)).toEqual(["Main"])

				signInAs(OTHER_CASHIER)
				expect(await useShift.getCachedShiftProfiles()).toEqual([])
			})

			it("keeps what it can open after the shift it was learned from closes", async () => {
				serverReports({ name: "POSA-OS-9", user: CASHIER })
				resetShiftState()
				await settle()
				await store.clearShift()
				await shiftStore.checkShift()
				await settle()

				serverReports(null)
				resetShiftState()
				await settle()

				expect(await store.getShift()).toBeNull()
				expect(await useShift.getCachedShiftProfiles()).toHaveLength(1)
			})
		})
	})

	describe("the periodic stock sync", () => {
		beforeEach(async () => {
			await store.cacheItems([item("A-1", { batch_no_data: [{ batch_no: "B1" }] })])
			fetchResponses.set("get_stock_quantities", {
				message: [{ item_code: "A-1", warehouse: "W1", actual_qty: 42 }],
			})
		})

		afterEach(async () => {
			await store.stopStockSync()
		})

		it("reports how it is configured", async () => {
			expect(await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"], intervalMs: 30000 })).toEqual({
				warehouse: "W1",
				itemCount: 1,
				intervalMs: 30000,
				enabled: false,
				lastSync: null,
			})
			expect(await store.getStockSyncStatus()).toMatchObject({ enabled: false, running: false, itemCount: 1 })
		})

		it("refuses an interval that would hammer the server", async () => {
			const before = await store.getStockSyncStatus()
			expect((await store.configureStockSync({ intervalMs: 5 })).intervalMs).toBe(before.intervalMs)
		})

		it("updates cached stock and announces it", async () => {
			const announced = new Promise((resolve) => {
				window.addEventListener("stockSyncComplete", (event) => resolve(event.detail), { once: true })
			})
			await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"] })

			const { success, status } = await store.triggerStockSync()

			expect(success).toBe(true)
			expect(status.lastSync).toBeGreaterThan(0)
			expect(await announced).toMatchObject({ updated: 1, total: 1 })

			const cached = await store.getCachedItem("A-1")
			expect(cached.actual_qty).toBe(42)
			expect(cached.batch_no_data).toEqual([{ batch_no: "B1" }])
		})

		it("starts and stops", async () => {
			await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"] })

			expect((await store.startStockSync()).status.enabled).toBe(true)
			expect((await store.stopStockSync()).status.enabled).toBe(false)
		})

		it("accepts the server's address and the cashier's grant", async () => {
			expect(await store.setServerAccess("https://pos.example.com", "grant")).toEqual({ success: true })
		})
	})
})

describe("reaching the server for stock", () => {
	const stockCall = () => fetch.mock.calls.find(([url]) => String(url).includes("get_stock_quantities"))

	const syncStock = async (store) => {
		await store.cacheItems([item("A-1")])
		await store.configureStockSync({ warehouse: "W1", itemCodes: ["A-1"] })
		await store.triggerStockSync()
	}

	beforeEach(() => {
		vi.resetModules()
		fetchResponses.clear()
		fetchResponses.set("get_stock_quantities", { message: [{ item_code: "A-1", actual_qty: 1 }] })
		stubFetch()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.doUnmock("@/platform/store")
	})

	it("in the worker, goes to the given server with the grant, which fetch there cannot add", async () => {
		const store = await openWebStore()
		await store.setServerAccess("https://pos.example.com", "the-grant")
		await store.setCSRFToken("the-token")

		await syncStock(store)

		const [url, { headers }] = stockCall()
		expect(url).toBe("https://pos.example.com/api/method/pos_next.api.items.get_stock_quantities")
		expect(headers.Authorization).toBe("Bearer the-grant")
		expect(headers["X-Frappe-CSRF-Token"]).toBe("the-token")
	})

	it("in the worker on the web, stays on the page's own origin with no grant", async () => {
		const store = await openWebStore()

		await syncStock(store)

		const [url, { headers }] = stockCall()
		expect(url).toBe(`${location.origin}/api/method/pos_next.api.items.get_stock_quantities`)
		expect(headers.Authorization).toBeUndefined()
	})

	it("on the main thread, leaves both to the fetch bridge", async () => {
		const store = await sqlImplementation(createNodeExecutor)()
		await store.setServerAccess("https://pos.example.com", "the-grant")

		await syncStock(store)

		const [url, { headers }] = stockCall()
		expect(url).toBe("/api/method/pos_next.api.items.get_stock_quantities")
		expect(headers.Authorization).toBeUndefined()
	})
})

describe("a save the web's worker client gave up waiting for", () => {
	/** Saves the sale but loses the answer, the way a worker busy past the timeout does */
	class AnswerLostWorker extends InProcessWorker {
		async postMessage(message) {
			if (message.type !== "SAVE_INVOICE" || this.answerLost) return super.postMessage(message)

			this.answerLost = true
			const deliver = this.onmessage
			this.onmessage = null
			await super.postMessage(message)
			this.onmessage = deliver
		}
	}

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("is sent again and leaves one sale, reported as saved", async () => {
		vi.resetModules()
		stubFetch()
		const store = await openWebStore()
		vi.stubGlobal("Worker", AnswerLostWorker)
		await store.getOfflineInvoiceCount()

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const saving = store.saveOfflineInvoice(invoice({ offline_id: "pos_offline_from_the_cart" }))
		await vi.advanceTimersByTimeAsync(31000)

		expect(await saving).toMatchObject({ success: true, offline_id: "pos_offline_from_the_cart" })
		expect((await store.getOfflineInvoices()).map((row) => row.offline_id)).toEqual(["pos_offline_from_the_cart"])
	})
})
