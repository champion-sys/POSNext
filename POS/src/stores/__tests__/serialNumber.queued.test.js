/**
 * Serials sold in the queue, on the real store and the real helpers. Only the server and
 * the device's storage are faked.
 */
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const queue = vi.hoisted(() => ({ rows: [] }))
const local = vi.hoisted(() => ({
	getCachedItem: vi.fn(),
	getOfflineInvoices: vi.fn(async () => queue.rows),
	updateItemBatchSerial: vi.fn(async () => 1),
}))
const server = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/platform/store", () => ({ localStore: local }))
vi.mock("@/utils/apiWrapper", () => server)

import { useSerialNumberStore } from "@/stores/serialNumber"
import { getCachedSerialData } from "@/utils/offline/items"

const sale = (serial_no, extra = {}) => ({
	id: 1,
	offline_id: "pos_offline_1",
	data: { doctype: "Sales Invoice", items: [{ item_code: "PHONE", qty: 1, serial_no }] },
	...extra,
})

const numbers = (serials) => serials.map((serial) => serial.serial_no)

describe("serials in the queue", () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useSerialNumberStore()
		store.setWarehouse("W1")

		queue.rows = []
		vi.clearAllMocks()
		local.getOfflineInvoices.mockImplementation(async () => queue.rows)
		server.call.mockResolvedValue([
			{ serial_no: "S1", warehouse: "W1" },
			{ serial_no: "S2", warehouse: "W1" },
			{ serial_no: "S3", warehouse: "W1" },
		])
	})

	it("leaves out a serial a queued sale has sold", async () => {
		queue.rows = [sale("S2")]

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S3"])
	})

	it("reads every serial of a line that sold several", async () => {
		queue.rows = [sale("S1\nS3\n")]

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S2"])
	})

	it("does not take another item's serial", async () => {
		queue.rows = [sale("S2")]
		queue.rows[0].data.items[0].item_code = "TABLET"

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S2", "S3"])
	})

	it("keeps the serial out of memory and off the device", async () => {
		queue.rows = [sale("S2")]

		await store.fetchSerials("PHONE")

		expect(numbers(store.getSerials("PHONE"))).toEqual(["S1", "S3"])
		const [, update] = local.updateItemBatchSerial.mock.calls[0]
		expect(numbers(update().serial_no_data)).toEqual(["S1", "S3"])
	})

	it("treats a sale the server holds but has not finished as sold", async () => {
		queue.rows = [sale("S2", { server_status: "needs_review" })]

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S3"])
	})

	it("does not hold a serial for a return, an order or a sale being voided", async () => {
		const held = (data, extra) => {
			const row = sale("S2", extra)
			Object.assign(row.data, data)
			return row
		}
		queue.rows = [
			held({ is_return: 1 }),
			held({ doctype: "Sales Order" }),
			held({}, { void_reason: "Wrong customer" }),
		]

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S2", "S3"])
	})

	it("skips records that are not sales", async () => {
		queue.rows = [{ entity: "payment", data: { invoice_name: "SINV-1" } }, { entity: "customer" }]

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S2", "S3"])
	})

	it("still lists serials when the queue cannot be read", async () => {
		local.getOfflineInvoices.mockRejectedValue(new Error("database closed"))

		expect(numbers(await store.fetchSerials("PHONE"))).toEqual(["S1", "S2", "S3"])
	})

	it("also leaves it out of what the device kept for offline", async () => {
		queue.rows = [sale("S2")]
		local.getCachedItem.mockResolvedValue({
			serial_no_data: [{ serial_no: "S1" }, { serial_no: "S2" }],
		})

		expect(numbers(await getCachedSerialData("PHONE"))).toEqual(["S1"])
	})
})
