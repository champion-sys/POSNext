/**
 * The records that are only ever read back whole, by POS Profile: payment methods, sales
 * persons, offers, invoice history and unpaid invoices.
 *
 * @module platform/sql/documents
 */

const toDocument = (row) => JSON.parse(row.doc)

/**
 * Records keyed by profile and name. A device can serve several profiles, and the same
 * mode of payment or sales person can belong to more than one.
 * @param {import("./outbox").SqlExecutor} sql
 * @param {string} table
 * @param {string} [nameField] - The field of a record that names it
 */
export function createProfileDocuments(sql, table, nameField = "name") {
	return {
		putStatements(records) {
			return records.map((record) => ({
				sql: `INSERT INTO ${table} (pos_profile, name, doc) VALUES (?, ?, ?)
					ON CONFLICT(pos_profile, name) DO UPDATE SET doc = excluded.doc`,
				params: [record.pos_profile ?? "", record[nameField], JSON.stringify(record)],
			}))
		},

		/** @param {string} [posProfile] - Every profile when omitted */
		async list(posProfile) {
			const rows = posProfile
				? await sql.all(`SELECT doc FROM ${table} WHERE pos_profile = ? ORDER BY name`, [posProfile])
				: await sql.all(`SELECT doc FROM ${table} ORDER BY name`)
			return rows.map(toDocument)
		},

		deleteStatement(posProfile) {
			return posProfile
				? { sql: `DELETE FROM ${table} WHERE pos_profile = ?`, params: [posProfile] }
				: { sql: `DELETE FROM ${table}` }
		},
	}
}

/**
 * Submitted documents, which have one name across every profile
 * @param {import("./outbox").SqlExecutor} sql
 * @param {string} table
 */
export function createInvoiceDocuments(sql, table) {
	return {
		putStatements(invoices) {
			return invoices.map((invoice) => ({
				sql: `INSERT INTO ${table} (name, pos_profile, doc) VALUES (?, ?, ?)
					ON CONFLICT(name) DO UPDATE SET pos_profile = excluded.pos_profile, doc = excluded.doc`,
				params: [invoice.name, invoice.pos_profile ?? "", JSON.stringify(invoice)],
			}))
		},

		/** @param {string} [posProfile] - Every profile when omitted */
		async list(posProfile) {
			const rows = posProfile
				? await sql.all(`SELECT doc FROM ${table} WHERE pos_profile = ?`, [posProfile])
				: await sql.all(`SELECT doc FROM ${table}`)
			return rows.map(toDocument)
		},

		deleteStatement(posProfile) {
			return posProfile
				? { sql: `DELETE FROM ${table} WHERE pos_profile = ?`, params: [posProfile] }
				: { sql: `DELETE FROM ${table}` }
		},
	}
}
