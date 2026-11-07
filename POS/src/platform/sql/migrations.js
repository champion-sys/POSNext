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
	{
		version: 2,
		statements: [
			"ALTER TABLE outbox ADD COLUMN sync_failed INTEGER NOT NULL DEFAULT 0",
			`CREATE TABLE catalog_item (
				item_code TEXT PRIMARY KEY,
				item_name TEXT,
				item_group TEXT,
				brand TEXT,
				variant_of TEXT,
				has_variants INTEGER NOT NULL DEFAULT 0,
				disabled INTEGER NOT NULL DEFAULT 0,
				hide_without_stock INTEGER NOT NULL DEFAULT 0,
				search_code TEXT NOT NULL,
				search_name TEXT NOT NULL,
				search_text TEXT NOT NULL,
				actual_qty REAL,
				stock_qty REAL,
				warehouse TEXT,
				batch_no_data TEXT,
				serial_no_data TEXT,
				doc TEXT NOT NULL
			)`,
			// The filters are in the index so a deep page skips rows without reading each doc
			`CREATE INDEX idx_catalog_item_name
				ON catalog_item(item_name, disabled, variant_of, has_variants, hide_without_stock, actual_qty)`,
			"CREATE INDEX idx_catalog_item_group ON catalog_item(item_group)",
			"CREATE INDEX idx_catalog_item_brand ON catalog_item(brand)",
			// Partial, or browsing picks it for variant_of IS NULL and sorts the whole table
			"CREATE INDEX idx_catalog_item_variant ON catalog_item(variant_of) WHERE variant_of IS NOT NULL",
			"CREATE INDEX idx_catalog_item_search_code ON catalog_item(search_code)",
			"CREATE INDEX idx_catalog_item_search_name ON catalog_item(search_name)",
			`CREATE TABLE item_barcode (
				barcode TEXT NOT NULL,
				item_code TEXT NOT NULL,
				PRIMARY KEY (barcode, item_code)
			)`,
			"CREATE INDEX idx_item_barcode_item ON item_barcode(item_code)",
			`CREATE TABLE item_price (
				price_list TEXT NOT NULL,
				item_code TEXT NOT NULL,
				rate REAL NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (price_list, item_code)
			)`,
			"CREATE INDEX idx_item_price_item ON item_price(item_code)",
			`CREATE TABLE customer (
				name TEXT PRIMARY KEY,
				search_text TEXT NOT NULL,
				doc TEXT NOT NULL
			)`,
			`CREATE TABLE payment_method (
				pos_profile TEXT NOT NULL,
				name TEXT NOT NULL,
				doc TEXT NOT NULL,
				PRIMARY KEY (pos_profile, name)
			)`,
			`CREATE TABLE sales_person (
				pos_profile TEXT NOT NULL,
				name TEXT NOT NULL,
				doc TEXT NOT NULL,
				PRIMARY KEY (pos_profile, name)
			)`,
			`CREATE TABLE offer (
				pos_profile TEXT NOT NULL,
				name TEXT NOT NULL,
				doc TEXT NOT NULL,
				PRIMARY KEY (pos_profile, name)
			)`,
			`CREATE TABLE invoice_history (
				name TEXT PRIMARY KEY,
				pos_profile TEXT NOT NULL,
				doc TEXT NOT NULL
			)`,
			"CREATE INDEX idx_invoice_history_profile ON invoice_history(pos_profile)",
			`CREATE TABLE unpaid_invoice (
				name TEXT PRIMARY KEY,
				pos_profile TEXT NOT NULL,
				doc TEXT NOT NULL
			)`,
			"CREATE INDEX idx_unpaid_invoice_profile ON unpaid_invoice(pos_profile)",
			`CREATE TABLE translation (
				locale TEXT PRIMARY KEY,
				messages TEXT NOT NULL,
				timestamp INTEGER
			)`,
			`CREATE TABLE draft (
				draft_id TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			)`,
			`CREATE TABLE current_shift (
				slot INTEGER PRIMARY KEY CHECK (slot = 1),
				doc TEXT NOT NULL
			)`,
			`CREATE TABLE print_job (
				job_id TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			)`,
		],
	},
	{
		version: 3,
		statements: ["ALTER TABLE outbox ADD COLUMN void_reason TEXT"],
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
