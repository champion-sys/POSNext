/**
 * The offline limit on returns and payments. The sale's side is in
 * pages/__tests__/POSSale.offlineLimit.test.js.
 */
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const limit = vi.hoisted(() => ({ passed: false }))
const worker = vi.hoisted(() => ({
	getOfflineInvoiceCount: vi.fn(async () => 0),
	getOfflineInvoices: vi.fn(async () => []),
	getQueueRows: vi.fn(async () => []),
	requestPersistentStorage: vi.fn(async () => true),
	saveOfflineInvoice: vi.fn(async () => ({ success: true, offline_id: "pos_offline_new" })),
	saveQueueEntity: vi.fn(async () => ({ id: 1, offline_id: "pos_offline_new" })),
}))
const stock = vi.hoisted(() => ({ queued: new Map(), warehouse: null, setQueued: vi.fn() }))
const settings = vi.hoisted(() => ({ syncIntervalMinutes: 5, syncMode: "Periodic" }))
const shift = vi.hoisted(() => ({ currentShift: { name: "POS-OPE-1" }, profileName: "Main" }))

vi.mock("@/platform/auth", () => ({ isPastOfflineSaleLimit: () => limit.passed }))
vi.mock("@/utils/offline", () => ({ syncOfflineInvoices: vi.fn(), announceRecordEnded: vi.fn() }))
vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { isOffline: false, getConnectionQuality: () => "good", subscribe: () => () => {} },
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: worker }))
vi.mock("@/utils/offline/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/core/sync/webPull", () => ({ pullChanges: vi.fn() }))
vi.mock("@/composables/useShift", () => ({ clearShiftClosing: vi.fn(), markShiftClosing: vi.fn() }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/data/session", () => ({ session: { isLoggedIn: true, user: "a@example.com" } }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => settings }))
vi.mock("@/stores/posShift", () => ({ usePOSShiftStore: () => shift }))
vi.mock("@/stores/stock", () => ({ useStockStore: () => stock }))

const { usePOSSyncStore } = await import("../posSync")

const RETURN = { doctype: "Sales Invoice", is_return: 1, return_against: "SINV-1", items: [{ item_code: "A", qty: -1 }] }
const INVOICE = { name: "SINV-1", customer: "CUST-1", outstanding_amount: 100 }
const PAYMENTS = [{ mode_of_payment: "Cash", amount: 40 }]

describe("the offline limit", () => {
	let store

	beforeEach(() => {
		globalThis.__ = (text) => text
		limit.passed = false
		vi.clearAllMocks()

		setActivePinia(createPinia())
		store = usePOSSyncStore()
		store.isOffline = true
	})

	describe("offline, past the limit", () => {
		beforeEach(() => {
			limit.passed = true
		})

		it("refuses a return, under the same title as a sale", async () => {
			await expect(store.saveReturnOffline(RETURN)).rejects.toMatchObject({
				title: "Offline limit reached",
				message: expect.stringContaining("this return was not saved"),
			})

			expect(worker.saveOfflineInvoice).not.toHaveBeenCalled()
		})

		it("refuses a partial payment, under the same title as a sale", async () => {
			await expect(store.savePaymentOffline(INVOICE, PAYMENTS)).rejects.toMatchObject({
				title: "Offline limit reached",
				message: expect.stringContaining("this payment was not saved"),
			})

			expect(worker.saveQueueEntity).not.toHaveBeenCalled()
		})
	})

	describe("offline, within the limit", () => {
		it("queues a return", async () => {
			const result = await store.saveReturnOffline(RETURN)

			expect(result.offline_id).toBe("pos_offline_new")
			expect(worker.saveOfflineInvoice).toHaveBeenCalledWith(RETURN, {})
		})

		it("queues a partial payment", async () => {
			await store.savePaymentOffline(INVOICE, PAYMENTS)

			expect(worker.saveQueueEntity).toHaveBeenCalledTimes(1)
		})
	})

	describe("online, in a shift opened offline", () => {
		beforeEach(() => {
			limit.passed = true
			store.isOffline = false
		})

		it("queues a return, since the limit is about being offline", async () => {
			await store.saveReturnOffline(RETURN)

			expect(worker.saveOfflineInvoice).toHaveBeenCalledTimes(1)
		})

		it("queues a partial payment", async () => {
			await store.savePaymentOffline(INVOICE, PAYMENTS)

			expect(worker.saveQueueEntity).toHaveBeenCalledTimes(1)
		})
	})

	it("still lets a cashier close their shift offline past the limit", async () => {
		limit.passed = true

		await store.saveShiftCloseOffline({
			pos_opening_shift: "POS-OPE-1",
			payment_reconciliation: [],
		})

		expect(worker.saveQueueEntity).toHaveBeenCalledWith(
			"shift_close",
			expect.objectContaining({ pos_opening_shift: "POS-OPE-1" }),
			expect.anything(),
		)
	})
})
