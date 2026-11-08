/**
 * Review proof: the status poll only ever asks about the oldest 200 rows the server holds.
 *
 * Rows in review stay on the device until a manager acts, and they are the oldest. Once 200
 * of them pile up (a disabled item or a closed period does that in one busy day), no later
 * row is ever asked about again: it stays "received" here after the server has posted it,
 * and keeps its stock hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { createNativeStore } from "@/platform/store/native"
import { createSqlStore } from "@/platform/store/sqlStore"
import { createNodeExecutor } from "@/platform/store/__tests__/sqliteHarness"

const current = vi.hoisted(() => ({ store: null }))
const callServer = vi.hoisted(() => vi.fn())

vi.mock("@/platform/store", async () => {
	const { STORE_METHODS } = await vi.importActual("@/platform/store/methods")
	return {
		localStore: Object.fromEntries(
			STORE_METHODS.map((name) => [name, (...args) => current.store[name](...args)]),
		),
	}
})
vi.mock("@/utils/apiWrapper", () => ({ call: callServer }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { isOffline: false, setServerOnline: () => {}, subscribe: () => () => {} },
}))

const REVIEWS = 200

const sale = (index) => ({
	doctype: "Sales Invoice",
	customer: "Walk-in",
	posa_pos_opening_shift: "SHIFT-1",
	grand_total: 10,
	offline_id: `pos_offline_${String(index).padStart(4, "0")}`,
	items: [{ item_code: "A", qty: 1, warehouse: "W1" }],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
})

describe("the status poll after a day of reviews", () => {
	let store

	beforeEach(async () => {
		const sql = createNodeExecutor()
		await migrate(sql)
		store = createNativeStore(async () => createSqlStore(sql))
		current.store = store
		callServer.mockReset()
	})

	afterEach(async () => {
		current.store = null
		vi.useRealTimers()
		const { resetReviewStatusCycle } = await import("@/utils/offline/sync")
		resetReviewStatusCycle()
	})

	const seed = async (count, statusOf) => {
		for (let index = 1; index <= count; index++) {
			const { id } = await store.saveOfflineInvoice(sale(index))
			const status = statusOf(index)
			await store.updateQueuedInvoice(id, { server_status: status, sync_failed: status === "needs_review" })
		}
	}

	const answerAll = (asked, statusOf) =>
		callServer.mockImplementation(async (method, args) => {
			if (!method.endsWith("get_status")) throw new Error(`unexpected ${method}`)
			asked.push(args.offline_ids)
			return args.offline_ids.map((offline_id) => ({ offline_id, ...statusOf(offline_id) }))
		})

	it("asks about every row still on its way, a page at a time", async () => {
		await seed(450, () => "received")
		const asked = []
		// Still being processed, so none of them drops out between polls
		answerAll(asked, () => ({ status: "processing", server_status: "Processing" }))

		const { syncOfflineInvoices } = await import("@/utils/offline/sync")
		await syncOfflineInvoices()

		expect(asked.slice(0, 3).map((page) => page.length)).toEqual([200, 200, 50])
		expect(new Set(asked.slice(0, 3).flat()).size).toBe(450)
		expect((await store.getQueuedInvoice(sale(450).offline_id)).server_status).toBe("processing")
	}, 30000)

	it("asks about rows in review on a slower cycle", async () => {
		await seed(3, (index) => (index === 1 ? "needs_review" : "received"))
		const review = sale(1).offline_id
		const asked = []
		answerAll(asked, (offline_id) =>
			offline_id === review
				? { status: "needs_review", server_status: "Needs Review", message: "Item disabled" }
				: { status: "synced", server_status: "Synced", invoice: "SINV" },
		)

		const { syncOfflineInvoices } = await import("@/utils/offline/sync")
		const reviewAsks = () => asked.filter((page) => page.includes(review)).length

		await syncOfflineInvoices()
		expect(reviewAsks()).toBe(1)
		expect((await store.getQueuedInvoice(sale(2).offline_id)).server_status).toBe("synced")

		await syncOfflineInvoices()
		expect(reviewAsks()).toBe(1)

		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(Date.now() + 6 * 60 * 1000)
		await syncOfflineInvoices()
		expect(reviewAsks()).toBe(2)
	}, 30000)

	it("still learns that a newer sale was posted", async () => {
		// 200 sales the server put in review, then one it took and has since posted
		for (let index = 1; index <= REVIEWS + 1; index++) {
			const { id } = await store.saveOfflineInvoice(sale(index))
			const status = index <= REVIEWS ? "needs_review" : "received"
			await store.updateQueuedInvoice(id, { server_status: status, sync_failed: status === "needs_review" })
		}
		const newest = sale(REVIEWS + 1).offline_id

		const asked = []
		callServer.mockImplementation(async (method, args) => {
			if (!method.endsWith("get_status")) throw new Error(`unexpected ${method}`)
			asked.push(...args.offline_ids)
			return args.offline_ids.map((offline_id) =>
				offline_id === newest
					? { offline_id, status: "synced", server_status: "Synced", invoice: "SINV-NEW" }
					: { offline_id, status: "needs_review", server_status: "Needs Review", message: "Item disabled" },
			)
		})

		const { syncOfflineInvoices } = await import("@/utils/offline/sync")
		await syncOfflineInvoices()

		const row = await store.getQueuedInvoice(newest)
		expect(asked).toContain(newest)
		expect(row.server_status).toBe("synced")
		expect(row.server_invoice).toBe("SINV-NEW")
	}, 30000)
})
