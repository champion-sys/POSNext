import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queue = vi.hoisted(() => ({ rows: [] }))
const worker = vi.hoisted(() => ({
	getOfflineInvoiceCount: vi.fn(async () => queue.rows.length),
	getOfflineInvoices: vi.fn(async () => queue.rows),
	requestPersistentStorage: vi.fn(async () => true),
	requestVoid: vi.fn(async () => ({ success: true })),
	updateQueuedInvoice: vi.fn(),
	deleteOfflineInvoice: vi.fn(),
}))
const syncOfflineInvoices = vi.hoisted(() => vi.fn())
const announceRecordEnded = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }))
const stock = vi.hoisted(() => ({
	queued: new Map(),
	warehouse: null,
	setQueued: vi.fn(),
	refresh: vi.fn(async () => {}),
}))
const settings = vi.hoisted(() => ({ syncIntervalMinutes: 5, syncMode: "Realtime" }))

vi.mock("@/utils/offline", () => ({ syncOfflineInvoices, announceRecordEnded }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: {
		isOffline: false,
		getConnectionQuality: () => "good",
		subscribe: () => () => {},
	},
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: worker }))
vi.mock("@/utils/offline/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ clearShiftClosing: vi.fn(), markShiftClosing: vi.fn() }))
vi.mock("@/composables/useToast", () => ({ useToast: () => toast }))
vi.mock("@/data/session", () => ({ session: { isLoggedIn: true } }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => settings }))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => ({}) }))
vi.mock("@/stores/stock", () => ({ useStockStore: () => stock }))

const { usePOSSyncStore } = await import("../posSync")

const REASON = "The customer changed their mind"

const outcome = (counts) => ({
	success: 0,
	failed: 0,
	skipped: 0,
	waiting: 0,
	delivered: 0,
	voided: 0,
	saleStands: 0,
	errors: [],
	...counts,
})

const row = (extra) => ({
	id: 1,
	offline_id: "pos_offline_1",
	entity: "invoice",
	data: { items: [{ item_code: "A", qty: 1 }] },
	...extra,
})

describe("asking to void a queued record", () => {
	let store

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })
		vi.stubGlobal("__", (text) => text)
		vi.clearAllMocks()
		localStorage.clear()
		queue.rows = [row()]
		settings.syncMode = "Realtime"
		stock.queued = new Map()
		syncOfflineInvoices.mockResolvedValue(outcome())
		setActivePinia(createPinia())
		store = usePOSSyncStore()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("hands the store the reason, without surrounding space", async () => {
		await store.requestVoid(1, `  ${REASON}\n`)
		expect(worker.requestVoid).toHaveBeenCalledWith(1, REASON)
	})

	it("no longer removes anything itself", async () => {
		await store.requestVoid(1, REASON)
		expect(worker.deleteOfflineInvoice).not.toHaveBeenCalled()
	})

	it.each([[""], ["   "], [null], [undefined]])("refuses %j as a reason", async (reason) => {
		await expect(store.requestVoid(1, reason)).rejects.toThrow("A reason is required")

		expect(worker.requestVoid).not.toHaveBeenCalled()
		expect(toast.showError).toHaveBeenCalledWith("A reason is required")
	})

	it("refuses a row that other queued records depend on", async () => {
		queue.rows = [row(), row({ id: 2, offline_id: "pos_offline_2", depends_on: ["pos_offline_1"] })]

		await expect(store.requestVoid(1, REASON)).rejects.toThrow("depend on this one")

		expect(worker.requestVoid).not.toHaveBeenCalled()
	})

	it("refuses a shift close, which only a manager can undo", async () => {
		queue.rows = [row({ entity: "shift_close" })]

		await expect(store.requestVoid(1, REASON)).rejects.toThrow("A shift cannot be voided")

		expect(worker.requestVoid).not.toHaveBeenCalled()
	})

	it("tells the cashier when the row has finished meanwhile", async () => {
		worker.requestVoid.mockResolvedValueOnce({ success: false })

		await expect(store.requestVoid(1, REASON)).rejects.toThrow("can no longer be voided")
	})

	it("refreshes what the POS shows", async () => {
		queue.rows = [row({ void_reason: REASON })]

		await store.requestVoid(1, REASON)

		expect(store.pendingInvoicesList[0].void_reason).toBe(REASON)
		expect(stock.setQueued.mock.calls.at(-1)[0].size).toBe(0)
	})

	it("sends the request at once", async () => {
		await store.requestVoid(1, REASON)
		await vi.waitFor(() => expect(syncOfflineInvoices).toHaveBeenCalledTimes(1))
	})

	it("waits for the next batch where the POS batches on purpose", async () => {
		settings.syncMode = "Periodic"

		await store.requestVoid(1, REASON)
		await vi.dynamicImportSettled()
		for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate)

		expect(syncOfflineInvoices).not.toHaveBeenCalled()
	})

	it("takes a queued customer out of use at once, so no sale comes to depend on it", async () => {
		const customer = row({ entity: "customer" })
		queue.rows = [customer]

		await store.requestVoid(1, REASON)

		expect(announceRecordEnded).toHaveBeenCalledWith(customer, "voided")
	})

	it("leaves a sale or a payment to the server's answer", async () => {
		await store.requestVoid(1, REASON)
		expect(announceRecordEnded).not.toHaveBeenCalled()
	})
})

describe("what the cashier hears from a sync", () => {
	let store

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })
		vi.stubGlobal("__", (text) => text)
		vi.clearAllMocks()
		localStorage.clear()
		queue.rows = []
		stock.queued = new Map()
		setActivePinia(createPinia())
		store = usePOSSyncStore()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("says plainly that a void came too late", async () => {
		syncOfflineInvoices.mockResolvedValue(outcome({ saleStands: 2, delivered: 2 }))

		await store.syncAllPending()

		expect(toast.showWarning).toHaveBeenCalledWith(expect.stringContaining("already on the server"))
	})

	it("says when a void went through", async () => {
		syncOfflineInvoices.mockResolvedValue(outcome({ voided: 1, delivered: 1 }))

		await store.syncAllPending()

		expect(toast.showSuccess).toHaveBeenCalledWith(expect.stringContaining("voided"))
		expect(toast.showWarning).not.toHaveBeenCalled()
	})

	it("says nothing about voids when there were none", async () => {
		syncOfflineInvoices.mockResolvedValue(outcome({ success: 1 }))

		await store.syncAllPending()

		expect(toast.showWarning).not.toHaveBeenCalled()
	})

	it("asks the server for the stock of a sale that stands, which holds nothing here any more", async () => {
		queue.rows = [row({ void_reason: REASON })]
		await store.updatePendingCount()
		syncOfflineInvoices.mockResolvedValue(outcome({ saleStands: 1, delivered: 1 }))

		await store.syncAllPending()

		expect(stock.refresh).toHaveBeenCalledWith(["A"], null)
	})

	it("counts an answered void as the queue reaching the server", async () => {
		syncOfflineInvoices.mockResolvedValue(outcome({ voided: 1, delivered: 1 }))

		await store.syncAllPending()

		expect(store.lastSyncedAt).toEqual(expect.any(Number))
	})
})

describe("after a void came too late", () => {
	let store

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })
		vi.stubGlobal("__", (text) => text)
		vi.clearAllMocks()
		queue.rows = []
		setActivePinia(createPinia())
		store = usePOSSyncStore()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("lets the row go once the cashier has seen it, as a synced record", async () => {
		queue.rows = [row({ void_reason: REASON, server_status: "sale_stands", server_invoice: "SINV-1" })]

		await store.acknowledgeSaleStands(1)

		expect(worker.updateQueuedInvoice).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ synced: true, server_status: "synced", server_invoice: "SINV-1" }),
		)
	})

	it("touches nothing else", async () => {
		queue.rows = [row({ void_reason: REASON })]

		await store.acknowledgeSaleStands(1)

		expect(worker.updateQueuedInvoice).not.toHaveBeenCalled()
	})
})
