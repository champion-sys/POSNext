import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	listUnconfirmedRows: vi.fn(),
	saveQueueFile: vi.fn(),
}))

vi.mock("@/platform/store", () => ({
	localStore: { listUnconfirmedRows: mocks.listUnconfirmedRows },
}))
vi.mock("@/platform/queueFile", () => ({ saveQueueFile: mocks.saveQueueFile }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))

const { QUEUE_FILE_VERSION, buildQueueFile, exportQueue, getQueueFileName } = await import("../queueFile")

const QUEUED_AT = Date.parse("2026-11-06T09:30:00Z")
const CUSTOMER = "pos_offline_customer-1"

const ROWS = [
	{
		id: 11,
		offline_id: CUSTOMER,
		entity: "customer",
		depends_on: [],
		timestamp: QUEUED_AT,
		data: {
			doctype: "Customer",
			customer_name: "عميل جديد",
			pos_profile: "Main",
			cashier: "lina@example.com",
		},
	},
	{
		id: 12,
		offline_id: "pos_offline_sale-1",
		entity: "invoice",
		depends_on: [CUSTOMER],
		timestamp: QUEUED_AT,
		data: {
			doctype: "Sales Invoice",
			pos_profile: "Main",
			customer: CUSTOMER,
			cashier: "lina@example.com",
			grand_total: 25,
			set_posting_time: 1,
			posting_date: "2026-11-06",
			posting_time: "12:30:00",
			edited_from: null,
			items: [{ item_code: "A", qty: 1, rate: 25, pricing_rules: ["RULE-1"] }],
			payments: [{ mode_of_payment: "Cash", amount: 25 }],
		},
	},
	{
		id: 13,
		offline_id: "pos_offline_payment-1",
		entity: "payment",
		depends_on: [],
		timestamp: QUEUED_AT,
		data: {
			doctype: "Payment Entry",
			invoice_name: "SINV-0001",
			customer: "CUST-1",
			pos_profile: "Main",
			cashier: "lina@example.com",
			payments: [{ mode_of_payment: "Cash", amount: 10 }],
		},
	},
]

const HEADER = {
	deviceId: "0294017d-77a0-4cb1-89d8-82ee5271911a",
	appVersion: "1.16.0",
	server: "https://old.example.com",
	exportedAt: new Date("2026-11-07T10:00:00.000Z"),
}

describe("buildQueueFile", () => {
	const file = buildQueueFile({ rows: ROWS, ...HEADER })

	it("says what it is and where it came from", () => {
		expect(file).toMatchObject({
			format_version: QUEUE_FILE_VERSION,
			device_id: HEADER.deviceId,
			app_version: "1.16.0",
			server: "https://old.example.com",
			exported_at: "2026-11-07T10:00:00.000Z",
			protocol_version: 1,
		})
	})

	it("keeps each row's identity, order and timing", () => {
		expect(file.rows.map((row) => [row.offline_id, row.entity, row.seq])).toEqual([
			[CUSTOMER, "customer", 11],
			["pos_offline_sale-1", "invoice", 12],
			["pos_offline_payment-1", "payment", 13],
		])
		expect(file.rows[1].depends_on).toEqual([CUSTOMER])
		expect(file.rows[1].created_at_device).toBe("2026-11-06T09:30:00.000Z")
	})

	it("normalizes a sale as a push does", () => {
		expect(file.rows[1].payload.items[0]).toMatchObject({ qty: 1, pricing_rules: "RULE-1" })
		expect(file.rows[1].payload.offline_id).toBe("pos_offline_sale-1")
	})

	it("carries the cashier and profile the server checks", () => {
		expect(file.rows[1]).toMatchObject({ cashier: "lina@example.com", pos_profile: "Main" })
	})

	it("is the file pos_next/api/test_queue_import.py reads", () => {
		const fixture = resolve(__dirname, "fixtures/queue-file-v1.json")
		expect(file).toEqual(JSON.parse(readFileSync(fixture, "utf8")))
	})
})

describe("getQueueFileName", () => {
	it("tells two devices and two exports apart, in local time", () => {
		const name = getQueueFileName("0294017d-77a0", new Date(2026, 10, 7, 9, 5, 3))
		expect(name).toBe("pos-queue-0294017d-20261107-090503.json")
	})
})

describe("exportQueue", () => {
	beforeEach(() => {
		mocks.listUnconfirmedRows.mockReset().mockResolvedValue(ROWS)
		mocks.saveQueueFile.mockReset().mockResolvedValue(true)
	})

	it("writes every row to one file", async () => {
		expect(await exportQueue(HEADER.exportedAt)).toEqual({ count: 3, saved: true })

		const [name, text] = mocks.saveQueueFile.mock.calls[0]
		expect(name).toMatch(/^pos-queue-.*\.json$/)
		expect(JSON.parse(text).rows).toHaveLength(3)
	})

	it("writes no file when nothing is waiting", async () => {
		mocks.listUnconfirmedRows.mockResolvedValue([])

		expect(await exportQueue()).toEqual({ count: 0, saved: false })
		expect(mocks.saveQueueFile).not.toHaveBeenCalled()
	})

	it("fails on a failed read, so a damaged device never gets an empty file", async () => {
		mocks.listUnconfirmedRows.mockRejectedValue(new Error("database disk image is malformed"))

		await expect(exportQueue()).rejects.toThrow("malformed")
		expect(mocks.saveQueueFile).not.toHaveBeenCalled()
	})

	it("reports a person backing out of the save", async () => {
		mocks.saveQueueFile.mockResolvedValue(false)
		expect(await exportQueue()).toEqual({ count: 3, saved: false })
	})

	it("names this app's server on the web", async () => {
		await exportQueue()
		expect(JSON.parse(mocks.saveQueueFile.mock.calls[0][1]).server).toBe(window.location.origin)
	})
})
