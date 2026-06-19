import { describe, it, expect, vi } from "vitest"
import { PrinterQueue } from "../printerQueue"

describe("PrinterQueue", () => {
	it("should process jobs in priority order", async () => {
		const completedJobs: string[] = []
		const worker = vi.fn().mockImplementation(async (data: Uint8Array) => {
			const label = new TextDecoder().decode(data)
			completedJobs.push(label)
			// simulate short delay
			await new Promise((resolve) => setTimeout(resolve, 5))
		})

		const queue = new PrinterQueue(worker)

		// Enqueue low, high, and normal priority jobs
		// Since queue starting processing is async, let's enqueue them quickly
		// Or we can stop processing or check how they arrange before processing
		// Let's mock worker delay so they stack up
		let delayResolve: () => void = () => {}
		const blockPromise = new Promise<void>((r) => {
			delayResolve = r
		})

		const slowWorker = vi.fn().mockImplementation(async (data: Uint8Array) => {
			const label = new TextDecoder().decode(data)
			completedJobs.push(label)
			if (label === "first") {
				await blockPromise
			}
		})

		queue.setPrintWorker(slowWorker)

		// First job starts immediately and blocks the worker loop
		queue.enqueue(new TextEncoder().encode("first"), "normal")

		// These jobs will get queued while the first job is blocking
		queue.enqueue(new TextEncoder().encode("low-priority"), "low")
		queue.enqueue(new TextEncoder().encode("high-priority"), "high")
		queue.enqueue(new TextEncoder().encode("normal-priority"), "normal")

		// Release the block so they execute
		delayResolve()

		// Wait for queue drain
		await new Promise<void>((resolve) => {
			queue.on("drain", () => {
				resolve()
			})
		})

		// Expected order: "first" (started first), then "high-priority", then "normal-priority", then "low-priority"
		expect(completedJobs).toEqual([
			"first",
			"high-priority",
			"normal-priority",
			"low-priority",
		])
	})

	it("should retry failed jobs up to maxRetries", async () => {
		let attempts = 0
		const worker = vi.fn().mockImplementation(async () => {
			attempts++
			if (attempts < 3) {
				throw new Error("Temporary connection issue")
			}
		})

		const queue = new PrinterQueue(worker)
		const job = queue.enqueue(new Uint8Array([1, 2, 3]), "normal", 3)

		// Wait for job completion or failure
		await new Promise<void>((resolve) => {
			queue.on("statusChanged", (j) => {
				if (
					j.id === job.id &&
					(j.status === "completed" || j.status === "failed")
				) {
					resolve()
				}
			})
		})

		expect(attempts).toBe(3)
		expect(job.status).toBe("completed")
		expect(job.retries).toBe(2) // 2 failed retries, 3rd attempt succeeded
	})
})
