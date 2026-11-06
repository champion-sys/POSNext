import { describe, expect, it } from "vitest"
import {
	QUEUE_FAILED,
	QUEUE_RECEIVED,
	QUEUE_REVIEW,
	QUEUE_SALE_STANDS,
	QUEUE_SENDING,
	QUEUE_VOIDING,
	QUEUE_WAITING,
	formatSyncTime,
	getQueueRowState,
	isWaitingToSend,
	needsAttention,
	sortQueueRows,
} from "../syncQueue"

describe("getQueueRowState", () => {
	it("reads the server's answer first", () => {
		expect(
			getQueueRowState({ server_status: "needs_review", sync_failed: true }),
		).toBe(QUEUE_REVIEW)
		expect(getQueueRowState({ server_status: "received" }, true)).toBe(
			QUEUE_RECEIVED,
		)
		expect(getQueueRowState({ server_status: "processing" })).toBe(
			QUEUE_RECEIVED,
		)
	})

	it("tells a failed sale from one still waiting", () => {
		expect(getQueueRowState({ sync_failed: true }, true)).toBe(QUEUE_FAILED)
		expect(getQueueRowState({ retry_count: 2, error: "timeout" })).toBe(
			QUEUE_WAITING,
		)
	})

	it("shows waiting sales as sending during a sync", () => {
		expect(getQueueRowState({}, true)).toBe(QUEUE_SENDING)
	})
})

describe("queue counts", () => {
	const rows = [
		{},
		{ retry_count: 1 },
		{ server_status: "received" },
		{ server_status: "needs_review", sync_failed: true },
		{ sync_failed: true },
	]

	it("counts only sales the server does not have yet as waiting", () => {
		expect(rows.filter(isWaitingToSend)).toHaveLength(2)
	})

	it("counts failed and reviewed sales as needing a person", () => {
		expect(rows.filter(needsAttention)).toHaveLength(2)
	})
})

describe("a void request", () => {
	const voiding = { void_reason: "Wrong sale" }
	const stands = { ...voiding, server_status: "sale_stands", server_invoice: "SINV-1" }

	it("reads as waiting to be voided, sending or not", () => {
		expect(getQueueRowState(voiding)).toBe(QUEUE_VOIDING)
		expect(getQueueRowState(voiding, true)).toBe(QUEUE_VOIDING)
	})

	it("reads the same on a row the server holds, until the server answers", () => {
		expect(getQueueRowState({ ...voiding, server_status: "needs_review", sync_failed: true })).toBe(QUEUE_VOIDING)
		expect(getQueueRowState({ ...voiding, server_status: "received" })).toBe(QUEUE_VOIDING)
	})

	it("counts as waiting to send, because the request has not reached the server", () => {
		expect(isWaitingToSend(voiding)).toBe(true)
		expect(needsAttention(voiding)).toBe(false)
	})

	it("needs a person once the server keeps refusing it", () => {
		const refused = { ...voiding, sync_failed: true }

		expect(isWaitingToSend(refused)).toBe(false)
		expect(needsAttention(refused)).toBe(true)
	})

	it("needs a person when it came too late, and goes first in the list", () => {
		expect(getQueueRowState(stands)).toBe(QUEUE_SALE_STANDS)
		expect(needsAttention(stands)).toBe(true)
		expect(isWaitingToSend(stands)).toBe(false)
		expect(sortQueueRows([{ timestamp: 1 }, { ...stands, timestamp: 2 }])[0].server_status).toBe("sale_stands")
	})

	it("is over once the cashier has seen that the sale stands", () => {
		const seen = { ...voiding, synced: true, server_status: "synced" }

		expect(getQueueRowState(seen)).toBe(QUEUE_RECEIVED)
		expect(needsAttention(seen)).toBe(false)
	})
})

describe("sortQueueRows", () => {
	it("puts sales needing a person first, then the oldest", () => {
		const sorted = sortQueueRows([
			{ id: 1, timestamp: 100 },
			{ id: 2, timestamp: 50 },
			{ id: 3, timestamp: 300, sync_failed: true },
		])
		expect(sorted.map((row) => row.id)).toEqual([3, 2, 1])
	})

	it("leaves the original list alone", () => {
		const rows = [
			{ id: 1, timestamp: 2 },
			{ id: 2, timestamp: 1 },
		]
		sortQueueRows(rows)
		expect(rows[0].id).toBe(1)
	})
})

describe("formatSyncTime", () => {
	const now = new Date(2026, 10, 6, 18, 30).getTime()

	it("gives the clock time for today", () => {
		expect(formatSyncTime(new Date(2026, 10, 6, 9, 5).getTime(), now)).toBe(
			"09:05",
		)
	})

	it("adds the date for an earlier day", () => {
		expect(formatSyncTime(new Date(2026, 10, 5, 23, 59).getTime(), now)).toBe(
			"2026-11-05 23:59",
		)
	})
})
