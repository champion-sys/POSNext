/**
 * Bluetooth print jobs on SQLite, so they survive a restart. The bytes travel as base64:
 * the Capacitor bridge only carries JSON.
 *
 * @module platform/sql/printJobs
 */

function toBase64(bytes) {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function fromBase64(text) {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createPrintJobs(sql) {
	return {
		async put(job) {
			await sql.run(
				`INSERT INTO print_job (job_id, doc) VALUES (?, ?)
				ON CONFLICT(job_id) DO UPDATE SET doc = excluded.doc`,
				[job.jobId, JSON.stringify({ ...job, data: toBase64(job.data) })],
			)
		},

		async list() {
			const rows = await sql.all("SELECT doc FROM print_job")
			return rows.map((row) => {
				const job = JSON.parse(row.doc)
				return { ...job, data: fromBase64(job.data) }
			})
		},

		async remove(jobId) {
			await sql.run("DELETE FROM print_job WHERE job_id = ?", [jobId])
		},

		clearStatements() {
			return [{ sql: "DELETE FROM print_job" }]
		},
	}
}
