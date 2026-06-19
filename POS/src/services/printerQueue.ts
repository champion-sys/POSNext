import { logger } from "../utils/logger"
import { db } from "../utils/offline/db"

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
	
	// Registry for tracking individual job execution Promises
	private jobCallbacks = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

	constructor(printWorker?: (data: Uint8Array) => Promise<void>) {
		if (printWorker) {
			this.printWorker = printWorker
		}
		// Attempt to restore queue from IndexedDB on startup
		this.loadPersistedJobs()
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

		this.persistJob(job)

		this.emit("added", job)
		this.emit("statusChanged", job)

		// Start processing async
		this.processQueue()

		return job
	}

	/**
	 * Returns a Promise that resolves/rejects based on a specific job ID completion
	 */
	public waitForJob(jobId: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			// If job is already finished, resolve or reject immediately
			const existingJob = this.jobs.find(j => j.id === jobId)
			if (existingJob) {
				if (existingJob.status === "completed") {
					resolve()
					return
				} else if (existingJob.status === "failed") {
					reject(existingJob.error || new Error("Printing failed"))
					return
				} else if (existingJob.status === "cancelled") {
					reject(new Error("Printing job cancelled"))
					return
				}
			} else {
				// If not found in memory, it might have been completed and pruned
				resolve()
				return
			}
			this.jobCallbacks.set(jobId, { resolve, reject })
		})
	}

	/**
	 * Cancel a pending job
	 */
	public cancelJob(jobId: string): boolean {
		const job = this.jobs.find((j) => j.id === jobId)
		if (!job) return false

		if (job.status === "pending" || job.status === "failed") {
			job.status = "cancelled"
			
			// Resolve promise callback if registered
			const callbacks = this.jobCallbacks.get(jobId)
			if (callbacks) {
				callbacks.reject(new Error("Printing job cancelled"))
				this.jobCallbacks.delete(jobId)
			}

			this.removePersistedJob(jobId)

			this.emit("cancelled", job)
			this.emit("statusChanged", job)
			
			// Prune and cleanup memory list
			this.pruneHistory()
			return true
		}
		return false
	}

	/**
	 * Clear all pending/failed jobs from the queue
	 */
	public clear(): void {
		const cancellableJobs = this.jobs.filter((j) => j.status === "pending" || j.status === "failed")
		for (const job of cancellableJobs) {
			job.status = "cancelled"
			
			const callbacks = this.jobCallbacks.get(job.id)
			if (callbacks) {
				callbacks.reject(new Error("Printing job cancelled"))
				this.jobCallbacks.delete(job.id)
			}

			this.removePersistedJob(job.id)

			this.emit("cancelled", job)
			this.emit("statusChanged", job)
		}
		// Keep only printing/active jobs and clear finished/failed
		this.jobs = this.jobs.filter((j) => j.status === "printing")
		log.info("Queue cleared.")
	}

	/**
	 * Get the list of all jobs currently tracked (in memory)
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
			
			const callbacks = this.jobCallbacks.get(job.id)
			if (callbacks) {
				callbacks.reject(error)
				this.jobCallbacks.delete(job.id)
			}

			this.persistJob(job)
			this.emit("failed", job, error)
			this.emit("statusChanged", job)
			this.pruneHistory()
			return
		}

		job.status = "printing"
		job.startedAt = Date.now()
		this.persistJob(job)
		this.emit("started", job)
		this.emit("statusChanged", job)

		while (job.status === "printing") {
			try {
				await this.printWorker(job.data)
				job.status = "completed"
				job.completedAt = Date.now()
				
				// Handle promise resolution
				const callbacks = this.jobCallbacks.get(job.id)
				if (callbacks) {
					callbacks.resolve()
					this.jobCallbacks.delete(job.id)
				}

				// Successfully printed: remove from offline queue DB
				this.removePersistedJob(job.id)

				this.emit("completed", job)
				this.emit("statusChanged", job)
				this.pruneHistory()
			} catch (err) {
				const errorObj = err instanceof Error ? err : new Error(String(err))
				job.retries++
				log.warn(
					`Job ${job.id} failed attempt ${job.retries}/${job.maxRetries + 1}: ${errorObj.message}`,
				)

				if (job.retries <= job.maxRetries) {
					job.status = "pending" // Put back to pending to allow delay retry
					this.persistJob(job)
					this.emit("statusChanged", job)
					
					// Wait before retrying (exponential backoff starting at 500ms)
					const delay = Math.min(500 * 2 ** (job.retries - 1), 5000)
					await new Promise((resolve) => setTimeout(resolve, delay))
					
					job.status = "printing" // Re-mark as printing to continue loop
				} else {
					job.status = "failed"
					job.error = errorObj

					// Reject promise callback
					const callbacks = this.jobCallbacks.get(job.id)
					if (callbacks) {
						callbacks.reject(errorObj)
						this.jobCallbacks.delete(job.id)
					}

					// Update status to failed in offline DB
					this.persistJob(job)

					this.emit("failed", job, errorObj)
					this.emit("statusChanged", job)
					this.pruneHistory()
				}
			}
		}
	}

	/**
	 * Cleans up finished/failed jobs in memory to prevent memory leaks
	 * Retains up to 20 recently finished/failed/cancelled jobs for UI history
	 */
	private pruneHistory(): void {
		const activeJobs = this.jobs.filter(j => j.status === "pending" || j.status === "printing")
		const finishedJobs = this.jobs.filter(j => j.status !== "pending" && j.status !== "printing")

		if (finishedJobs.length > 20) {
			// Sort by completedAt or createdAt descending
			finishedJobs.sort((a, b) => {
				const timeA = a.completedAt || a.createdAt
				const timeB = b.completedAt || b.createdAt
				return timeB - timeA
			})

			// Keep 20, delete the rest from memory
			const keptFinished = finishedJobs.slice(0, 20)
			
			// For the ones pruned, make sure they are removed from the database as well (if failed)
			const prunedJobs = finishedJobs.slice(20)
			for (const pruned of prunedJobs) {
				this.removePersistedJob(pruned.id)
			}

			this.jobs = [...activeJobs, ...keptFinished]
		}
	}

	/**
	 * IndexedDB persistence helper (checks localStorage directly for speed)
	 */
	private async persistJob(job: PrintJob): Promise<void> {
		const persistenceEnabled = localStorage.getItem("pos_bt_queue_persistence") !== "0"
		if (!persistenceEnabled) return

		try {
			await db.table("print_queue").put({
				jobId: job.id,
				data: job.data,
				priority: job.priority,
				status: job.status,
				retries: job.retries,
				maxRetries: job.maxRetries,
				createdAt: job.createdAt,
				errorMsg: job.error ? job.error.message : undefined
			})
		} catch (err) {
			log.error("Failed to persist print job in IndexedDB:", err)
		}
	}

	/**
	 * IndexedDB removal helper
	 */
	private async removePersistedJob(jobId: string): Promise<void> {
		try {
			await db.table("print_queue").delete(jobId)
		} catch (err) {
			log.error("Failed to delete print job from IndexedDB:", err)
		}
	}

	/**
	 * Startup recovery helper
	 */
	public async loadPersistedJobs(): Promise<void> {
		const persistenceEnabled = localStorage.getItem("pos_bt_queue_persistence") !== "0"
		if (!persistenceEnabled) return

		try {
			const saved = await db.table("print_queue").toArray()
			if (saved && saved.length > 0) {
				log.info(`Found ${saved.length} persisted print jobs in IndexedDB. Restoring...`)
				const priorityWeight = { high: 3, normal: 2, low: 1 }
				
				// Filter to only restore pending or failed print jobs
				const toRestore = saved.filter(item => item.status === "pending" || item.status === "failed")
				
				toRestore.sort((a, b) => {
					const wA = priorityWeight[a.priority as PrintJobPriority] || 2
					const wB = priorityWeight[b.priority as PrintJobPriority] || 2
					if (wA !== wB) return wB - wA
					return a.createdAt - b.createdAt
				})

				for (const item of toRestore) {
					// Check if already in queue memory (avoid duplicates)
					if (this.jobs.some(j => j.id === item.jobId)) continue

					const job: PrintJob = {
						id: item.jobId,
						data: item.data,
						priority: item.priority,
						status: "pending", // Reset back to pending to process it
						retries: 0, // Reset retries to start clean
						maxRetries: item.maxRetries || 3,
						createdAt: item.createdAt,
					}
					this.jobs.push(job)
					this.emit("added", job)
					this.emit("statusChanged", job)
				}

				if (this.jobs.length > 0) {
					this.processQueue()
				}
			}
		} catch (err) {
			log.error("Failed to load persisted print jobs from IndexedDB:", err)
		}
	}

	/**
	 * Manually retry all failed print jobs in the queue
	 */
	public retryFailedJobs(): void {
		const failed = this.jobs.filter(j => j.status === "failed")
		for (const job of failed) {
			job.status = "pending"
			job.retries = 0
			this.persistJob(job)
			this.emit("statusChanged", job)
		}
		if (failed.length > 0) {
			this.processQueue()
		}
	}
}
