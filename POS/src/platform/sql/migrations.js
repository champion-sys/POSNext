/**
 * SQLite schema for the desktop and Android apps.
 *
 * Numbered and append-only: a shipped migration never changes, because devices upgrade
 * while holding unsynced sales. Each one runs once, in a single batch.
 *
 * @module platform/sql/migrations
 */

export const MIGRATIONS = [
	{
		version: 1,
		statements: [
			`CREATE TABLE outbox (
				offline_id TEXT PRIMARY KEY,
				seq INTEGER NOT NULL UNIQUE,
				entity TEXT NOT NULL,
				entity_version INTEGER NOT NULL,
				local_number TEXT,
				payload TEXT NOT NULL,
				state TEXT NOT NULL,
				depends_on TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				server_name TEXT,
				superseded_by TEXT,
				shift TEXT,
				created_at INTEGER NOT NULL,
				acked_at INTEGER,
				synced_at INTEGER
			)`,
			"CREATE INDEX idx_outbox_due ON outbox(state, next_attempt_at, seq)",
			"CREATE INDEX idx_outbox_shift ON outbox(shift, state)",
			`CREATE TABLE stock_base (
				item_code TEXT NOT NULL,
				warehouse TEXT NOT NULL,
				qty REAL NOT NULL,
				as_of INTEGER NOT NULL,
				PRIMARY KEY (item_code, warehouse)
			)`,
			`CREATE TABLE stock_reservation (
				offline_id TEXT NOT NULL,
				item_code TEXT NOT NULL,
				warehouse TEXT NOT NULL,
				stock_qty REAL NOT NULL,
				PRIMARY KEY (offline_id, item_code, warehouse)
			)`,
			`CREATE TABLE receipt (
				offline_id TEXT PRIMARY KEY,
				doc TEXT NOT NULL,
				printed_count INTEGER NOT NULL DEFAULT 0
			)`,
			"CREATE TABLE device_sequence (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
			"CREATE TABLE sync_cursor (entity TEXT PRIMARY KEY, cursor TEXT, synced_at INTEGER)",
			"CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		],
	},
]

/**
 * Bring a database up to date. A failed batch leaves it at the last good version.
 * @param {import("./outbox").SqlExecutor} sql
 * @param {Array} [migrations]
 * @returns {Promise<number>} The schema version
 */
export async function migrate(sql, migrations = MIGRATIONS) {
	await sql.run(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
	)
	const [{ version: current }] = await sql.all(
		"SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
	)

	const pending = migrations.filter((migration) => migration.version > current)
	for (const migration of pending) {
		await sql.batch([
			...migration.statements.map((statement) => ({ sql: statement })),
			{
				sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				params: [migration.version, Date.now()],
			},
		])
	}
	return pending.at(-1)?.version ?? current
}
