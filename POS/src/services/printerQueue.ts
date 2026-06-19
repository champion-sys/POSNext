import { logger } from "../utils/logger"

const log = logger.create("PrinterQueue")

export type PrintJobStatus =
	| "pending"
	| "printing"
	| "completed"
	| "failed"
	| "cancelled"

export type PrintJobPriority = "low" | "normal" | "high"

export interface PrintJob {
	id: string
	data: Uint8Array
	priority: PrintJobPriority
	status: PrintJobStatus
	retries: number
	maxRetries: number
	createdAt: number
	startedAt?: number
	completedAt?: number
	error?: Error
}

export type QueueEventMap = {
	added: (job: PrintJob) => void
	started: (job: PrintJob) => void
	completed: (job: PrintJob) => void
	failed: (job: PrintJob, error: Error) => void
	cancelled: (job: PrintJob) => void
	statusChanged: (job: PrintJob) => void
	drain: () => void
	error: (error: Error) => void
}

export class PrinterQueue {
	private jobs: PrintJob[] = []
	private isProcessing = false
	private listeners: { [K in keyof QueueEventMap]?: QueueEventMap[K][] } = {}
	private printWorker: ((data: Uint8Array) => Promise<void>) | null = null

	constructor(printWorker?: (data: Uint8Array) => Promise<void>) {
		if (printWorker) {
			this.printWorker = printWorker
		}
	}

	/**
	 * Set the underlying worker function that sends bytes to the Bluetooth printer
	 */
	public setPrintWorker(worker: (data: Uint8Array) => Promise<void>): void {
		this.printWorker = worker
	}

	/**
	 * Add an event listener
	 */
	public on<K extends keyof QueueEventMap>(
		event: K,
		listener: QueueEventMap[K],
	): void {
		if (!this.listeners[event]) {
			this.listeners[event] = []
		}
		this.listeners[event]?.push(listener)
	}

	/**
	 * Remove an event listener
	 */
	public off<K extends keyof QueueEventMap>(
		event: K,
		listener: QueueEventMap[K],
	): void {
		const list = this.listeners[event]
		if (!list) return
		const index = list.indexOf(listener)
		if (index !== -1) {
			list.splice(index, 1)
		}
	}

	private emit<K extends keyof QueueEventMap>(
		event: K,
		...args: Parameters<QueueEventMap[K]>
	): void {
		const list = this.listeners[event]
		if (!list) return
		for (const listener of list) {
			try {
				// @ts-ignore
				listener(...args)
			} catch (e) {
				log.error(`Error in event listener for ${event}:`, e)
			}
		}
	}

	/**
	 * Enqueue a print job
	 */
	public enqueue(
		data: Uint8Array,
		priority: PrintJobPriority = "normal",
		maxRetries = 3,
	): PrintJob {
		const job: PrintJob = {
			id: Math.random().toString(36).substring(2, 11),
			data,
			priority,
			status: "pending",
			retries: 0,
			maxRetries,
			createdAt: Date.now(),
		}

		// Insert based on priority
		// high > normal > low
		// Find first job that has lower priority or equals and place before it (to keep stable sort within priority)
		const priorityWeight = { high: 3, normal: 2, low: 1 }
		const targetWeight = priorityWeight[priority]

		let insertIndex = this.jobs.length
		for (let i = 0; i < this.jobs.length; i++) {
			const existingJob = this.jobs[i]
			// Only insert in front of pending jobs (don't interrupt currently printing or completed/failed jobs)
			if (existingJob.status === "pending") {
				const existingWeight = priorityWeight[existingJob.priority]
				if (targetWeight > existingWeight) {
					insertIndex = i
					break
				}
			}
		}

		this.jobs.splice(insertIndex, 0, job)
		log.info(
			`Enqueued job ${job.id} with priority ${priority}. Queue size: ${this.jobs.length}`,
		)

		this.emit("added", job)
		this.emit("statusChanged", job)

		// Start processing async
		this.processQueue()

		return job
	}

	/**
	 * Cancel a pending job
	 */
	public cancelJob(jobId: string): boolean {
		const job = this.jobs.find((j) => j.id === jobId)
		if (!job) return false

		if (job.status === "pending") {
			job.status = "cancelled"
			this.emit("cancelled", job)
			this.emit("statusChanged", job)
			// Remove from active processing list
			this.jobs = this.jobs.filter((j) => j.id !== jobId)
			return true
		}
		return false
	}

	/**
	 * Clear all pending jobs from the queue
	 */
	public clear(): void {
		const pendingJobs = this.jobs.filter((j) => j.status === "pending")
		for (const job of pendingJobs) {
			job.status = "cancelled"
			this.emit("cancelled", job)
			this.emit("statusChanged", job)
		}
		// Keep only printing/active jobs
		this.jobs = this.jobs.filter((j) => j.status === "printing")
		log.info("Queue cleared of all pending jobs.")
	}

	/**
	 * Get the list of all jobs currently tracked
	 */
	public getJobs(): PrintJob[] {
		return [...this.jobs]
	}

	/**
	 * Get the active printing job, if any
	 */
	public getActiveJob(): PrintJob | undefined {
		return this.jobs.find((j) => j.status === "printing")
	}

	/**
	 * Process the next job in queue sequentially
	 */
	private async processQueue(): Promise<void> {
		if (this.isProcessing) return
		this.isProcessing = true

		try {
			while (true) {
				const nextJob = this.jobs.find((j) => j.status === "pending")
				if (!nextJob) {
					break
				}

				await this.executeJob(nextJob)
			}
		} catch (error) {
			log.error("Fatal queue processing error:", error)
			this.emit(
				"error",
				error instanceof Error ? error : new Error(String(error)),
			)
		} finally {
			this.isProcessing = false
			this.emit("drain")
		}
	}

	/**
	 * Execute a single job with retry policy
	 */
	private async executeJob(job: PrintJob): Promise<void> {
		if (!this.printWorker) {
			const error = new Error("No print worker defined for the queue.")
			job.status = "failed"
			job.error = error
			this.emit("failed", job, error)
			this.emit("statusChanged", job)
			return
		}

		job.status = "printing"
		job.startedAt = Date.now()
		this.emit("started", job)
		this.emit("statusChanged", job)

		while (job.status === "printing") {
			try {
				await this.printWorker(job.data)
				job.status = "completed"
				job.completedAt = Date.now()
				this.emit("completed", job)
				this.emit("statusChanged", job)
				// Clean up finished job from memory tracking after success
				this.jobs = this.jobs.filter((j) => j.id !== job.id)
			} catch (err) {
				const errorObj = err instanceof Error ? err : new Error(String(err))
				job.retries++
				log.warn(
					`Job ${job.id} failed attempt ${job.retries}/${job.maxRetries + 1}: ${errorObj.message}`,
				)

				if (job.retries <= job.maxRetries) {
					// Wait before retrying (exponential backoff starting at 500ms)
					const delay = Math.min(500 * 2 ** (job.retries - 1), 5000)
					await new Promise((resolve) => setTimeout(resolve, delay))
				} else {
					job.status = "failed"
					job.error = errorObj
					this.emit("failed", job, errorObj)
					this.emit("statusChanged", job)
					// Remove failed job or keep it for logs (we keep it in list, but let's filter after some time or keep it until cleared)
				}
			}
		}
	}
}
