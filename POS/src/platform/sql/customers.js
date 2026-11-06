/**
 * Customers on SQLite, searchable by name, mobile number or id.
 *
 * @module platform/sql/customers
 */

import { buildSearchText, chunk, normalizeSearchText, placeholders } from "./searchText"

const toCustomer = (row) => JSON.parse(row.doc)

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createCustomers(sql) {
	return {
		putStatements(customers) {
			return customers.map((customer) => ({
				sql: `INSERT INTO customer (name, search_text, doc) VALUES (?, ?, ?)
					ON CONFLICT(name) DO UPDATE SET search_text = excluded.search_text, doc = excluded.doc`,
				params: [
					customer.name,
					buildSearchText(customer.customer_name, customer.mobile_no, customer.name),
					JSON.stringify(customer),
				],
			}))
		},

		async get(name) {
			const [row] = await sql.all("SELECT doc FROM customer WHERE name = ?", [name])
			return row ? toCustomer(row) : undefined
		},

		/**
		 * @param {string} searchTerm
		 * @param {number} limit - 0 returns every match
		 */
		async search(searchTerm, limit) {
			const term = normalizeSearchText(searchTerm)
			const limitClause = limit > 0 ? "LIMIT ?" : ""
			const limitParams = limit > 0 ? [limit] : []

			const rows = term
				? await sql.all(
						`SELECT doc FROM customer WHERE instr(search_text, ?) > 0 ORDER BY name ${limitClause}`,
						[term, ...limitParams],
					)
				: await sql.all(`SELECT doc FROM customer ORDER BY name ${limitClause}`, limitParams)
			return rows.map(toCustomer)
		},

		async remove(names) {
			await sql.batch(
				chunk(names).map((page) => ({
					sql: `DELETE FROM customer WHERE name IN (${placeholders(page)})`,
					params: page,
				})),
			)
		},

		async count() {
			const [{ count }] = await sql.all("SELECT COUNT(*) AS count FROM customer")
			return count
		},

		clearStatements() {
			return [{ sql: "DELETE FROM customer" }]
		},
	}
}
