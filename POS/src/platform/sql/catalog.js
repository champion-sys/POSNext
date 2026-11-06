/**
 * Items, barcodes, prices and stock on SQLite.
 *
 * Stock and batch/serial data have their own columns, because they change on their own
 * while the rest of an item only changes when the server sends it again. A write to one
 * can then never overwrite the other, without an interactive transaction.
 *
 * @module platform/sql/catalog
 */

import { buildSearchText, chunk, normalizeSearchText, placeholders, prefixEnd } from "./searchText"

const JSON_COLUMNS = ["batch_no_data", "serial_no_data"]
const STOCK_COLUMNS = ["actual_qty", "stock_qty", "warehouse"]

const SCORE = { NAME_EXACT: 1000, CODE_EXACT: 900, NAME_PREFIX: 500, CODE_PREFIX: 400, CONTAINS: 100 }

function toItem(row) {
	const item = JSON.parse(row.doc)
	for (const column of STOCK_COLUMNS) {
		if (row[column] !== null) item[column] = row[column]
	}
	for (const column of JSON_COLUMNS) {
		if (row[column] !== null) item[column] = JSON.parse(row[column])
	}
	return item
}

const toJson = (value) => (value === undefined || value === null ? null : JSON.stringify(value))

function visible(showVariantsAsItems) {
	return `disabled = 0 AND ${showVariantsAsItems ? "has_variants = 0" : "variant_of IS NULL"}`
}

/** @returns {Array<string>} Every barcode an item arrives with, in any of the server's formats */
export function extractBarcodes(item) {
	if (Array.isArray(item.barcodes)) return item.barcodes
	if (item.barcode) return [item.barcode]
	if (item.item_barcode) {
		if (Array.isArray(item.item_barcode)) {
			return item.item_barcode.map((b) => (typeof b === "object" ? b.barcode : b)).filter(Boolean)
		}
		return [item.item_barcode]
	}
	return []
}

function itemStatements(item, now) {
	const { actual_qty, stock_qty, warehouse, batch_no_data, serial_no_data, ...doc } = item
	const barcodes = [...new Set(extractBarcodes(item).map((barcode) => String(barcode).toLowerCase()))]
	const qty = actual_qty ?? stock_qty ?? null

	const statements = [
		{
			sql: `INSERT INTO catalog_item (item_code, item_name, item_group, brand, variant_of, has_variants,
					disabled, search_code, search_name, search_text, actual_qty, stock_qty, warehouse,
					batch_no_data, serial_no_data, doc)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(item_code) DO UPDATE SET
					item_name = excluded.item_name, item_group = excluded.item_group, brand = excluded.brand,
					variant_of = excluded.variant_of, has_variants = excluded.has_variants,
					disabled = excluded.disabled, search_code = excluded.search_code,
					search_name = excluded.search_name, search_text = excluded.search_text,
					actual_qty = excluded.actual_qty, stock_qty = excluded.stock_qty,
					warehouse = excluded.warehouse,
					batch_no_data = COALESCE(excluded.batch_no_data, catalog_item.batch_no_data),
					serial_no_data = COALESCE(excluded.serial_no_data, catalog_item.serial_no_data),
					doc = excluded.doc`,
			params: [
				item.item_code,
				item.item_name ?? null,
				item.item_group ?? null,
				item.brand ?? null,
				item.variant_of || null,
				item.has_variants ? 1 : 0,
				item.disabled ? 1 : 0,
				normalizeSearchText(item.item_code),
				normalizeSearchText(item.item_name),
				buildSearchText(item.item_code, item.item_name, item.description),
				actual_qty ?? null,
				stock_qty ?? null,
				warehouse ?? null,
				toJson(batch_no_data),
				toJson(serial_no_data),
				JSON.stringify({ ...doc, barcodes: extractBarcodes(item) }),
			],
		},
		...barcodes.map((barcode) => ({
			sql: "INSERT OR IGNORE INTO item_barcode (barcode, item_code) VALUES (?, ?)",
			params: [barcode, item.item_code],
		})),
	]

	if (warehouse && qty !== null) {
		statements.push(stockStatement(item.item_code, warehouse, qty, now))
	}
	return statements
}

function stockStatement(itemCode, warehouse, qty, now) {
	return {
		sql: `INSERT INTO stock_base (item_code, warehouse, qty, as_of) VALUES (?, ?, ?, ?)
			ON CONFLICT(item_code, warehouse) DO UPDATE SET qty = excluded.qty, as_of = excluded.as_of`,
		params: [itemCode, warehouse, qty, now],
	}
}

function priceStatement({ price_list, item_code, rate }, now) {
	return {
		sql: `INSERT INTO item_price (price_list, item_code, rate, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(price_list, item_code) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at`,
		params: [price_list, item_code, rate, now],
	}
}

/**
 * @param {import("./outbox").SqlExecutor} sql
 */
export function createCatalog(sql) {
	const pageByName = (rows, limit, offset) =>
		rows.sort((a, b) => (a.item_name || "").localeCompare(b.item_name || "")).slice(offset, offset + limit)

	/** Load a page in full. Only its names are needed to sort a whole group in the app's locale. */
	async function loadInOrder(rows) {
		const items = new Map()
		for (const codes of chunk(rows.map((row) => row.item_code))) {
			const found = await sql.all(
				`SELECT * FROM catalog_item WHERE item_code IN (${placeholders(codes)})`,
				codes,
			)
			for (const row of found) items.set(row.item_code, toItem(row))
		}
		return rows.map((row) => items.get(row.item_code))
	}

	async function searchByTerm(term, limit) {
		const words = term.split(" ").filter(Boolean)

		if (words.length === 1) {
			const byBarcode = await sql.all(
				`SELECT catalog_item.* FROM item_barcode
				JOIN catalog_item ON catalog_item.item_code = item_barcode.item_code
				WHERE item_barcode.barcode = ? AND disabled = 0 LIMIT ?`,
				[term, limit],
			)
			if (byBarcode.length > 0) return byBarcode

			for (const column of ["search_code", "search_name"]) {
				const byPrefix = await sql.all(
					`SELECT * FROM catalog_item WHERE ${column} >= ? AND ${column} < ? AND disabled = 0
					ORDER BY ${column} LIMIT ?`,
					[term, prefixEnd(term), limit],
				)
				if (byPrefix.length > 0) return byPrefix
			}
		}

		return sql.all(
			`SELECT * FROM catalog_item
			WHERE disabled = 0 AND ${words.map(() => "instr(search_text, ?) > 0").join(" AND ")}
			ORDER BY CASE
				WHEN search_name = ? THEN ${SCORE.NAME_EXACT}
				WHEN search_code = ? THEN ${SCORE.CODE_EXACT}
				WHEN search_name >= ? AND search_name < ? THEN ${SCORE.NAME_PREFIX}
				WHEN search_code >= ? AND search_code < ? THEN ${SCORE.CODE_PREFIX}
				ELSE ${SCORE.CONTAINS}
			END DESC, item_code
			LIMIT ?`,
			[...words, term, term, term, prefixEnd(term), term, prefixEnd(term), limit],
		)
	}

	return {
		/**
		 * The statements that store a page of items, to commit together with what goes with them
		 * @param {Array<Object>} items
		 * @param {number} [now]
		 */
		putStatements(items, now = Date.now()) {
			return [
				{
					sql: `DELETE FROM item_barcode WHERE item_code IN (${placeholders(items)})`,
					params: items.map((item) => item.item_code),
				},
				...items.flatMap((item) => itemStatements(item, now)),
			]
		},

		priceStatements(prices, now = Date.now()) {
			return prices.map((price) => priceStatement(price, now))
		},

		async get(itemCode) {
			const [row] = await sql.all("SELECT * FROM catalog_item WHERE item_code = ?", [itemCode])
			return row ? toItem(row) : undefined
		},

		async getByBarcode(barcode) {
			const [row] = await sql.all(
				`SELECT catalog_item.* FROM item_barcode
				JOIN catalog_item ON catalog_item.item_code = item_barcode.item_code
				WHERE item_barcode.barcode = ? LIMIT 1`,
				[String(barcode).toLowerCase()],
			)
			return row ? toItem(row) : undefined
		},

		async getVariants(templateItemCode) {
			const rows = await sql.all("SELECT * FROM catalog_item WHERE variant_of = ?", [templateItemCode])
			return rows.map(toItem)
		},

		async getPrice(priceList, itemCode) {
			const [row] = await sql.all("SELECT rate FROM item_price WHERE price_list = ? AND item_code = ?", [
				priceList,
				itemCode,
			])
			return row?.rate
		},

		async browse({ limit, offset = 0, showVariantsAsItems }) {
			const rows = await sql.all(
				`SELECT * FROM catalog_item
				WHERE item_name IS NOT NULL AND ${visible(showVariantsAsItems)}
				ORDER BY item_name LIMIT ? OFFSET ?`,
				[limit, offset],
			)
			return rows.map(toItem)
		},

		async search(searchTerm, limit) {
			const rows = await searchByTerm(normalizeSearchText(searchTerm), limit)
			return rows.map(toItem)
		},

		async searchByGroups(groups, { limit, offset = 0, showVariantsAsItems }) {
			const rows = await sql.all(
				`SELECT item_code, item_name FROM catalog_item
				WHERE ${visible(showVariantsAsItems)} AND item_group IN (${placeholders(groups)})`,
				groups,
			)
			return loadInOrder(pageByName(rows, limit, offset))
		},

		async searchByBrand(brand, { limit, offset = 0, showVariantsAsItems }) {
			const rows = await sql.all(
				`SELECT item_code, item_name FROM catalog_item WHERE ${visible(showVariantsAsItems)} AND brand = ?`,
				[brand],
			)
			return loadInOrder(pageByName(rows, limit, offset))
		},

		async count(where = "1 = 1", params = []) {
			const [{ count }] = await sql.all(`SELECT COUNT(*) AS count FROM catalog_item WHERE ${where}`, params)
			return count
		},

		countVisible(groups, showVariantsAsItems) {
			return groups?.length
				? this.count(`${visible(showVariantsAsItems)} AND item_group IN (${placeholders(groups)})`, groups)
				: this.count(visible(showVariantsAsItems))
		},

		countHidden(showVariantsAsItems) {
			return this.count(showVariantsAsItems ? "has_variants = 1" : "variant_of IS NOT NULL")
		},

		/**
		 * @param {Array<{item_code: string, warehouse?: string, actual_qty?: number, stock_qty?: number}>} updates
		 * @param {number} [now]
		 * @returns {Promise<number>} How many updates hit a cached item
		 */
		async updateStock(updates, now = Date.now()) {
			const valid = updates.filter((update) => update.item_code)
			const cached = new Set()
			for (const codes of chunk([...new Set(valid.map((update) => update.item_code))])) {
				const rows = await sql.all(
					`SELECT item_code FROM catalog_item WHERE item_code IN (${placeholders(codes)})`,
					codes,
				)
				for (const { item_code } of rows) cached.add(item_code)
			}

			const applicable = valid.filter((update) => cached.has(update.item_code))
			const statements = applicable.flatMap(({ item_code, warehouse, actual_qty, stock_qty }) => {
				const actual = actual_qty !== undefined ? actual_qty : stock_qty
				const stock = stock_qty !== undefined ? stock_qty : actual_qty
				return [
					{
						sql: `UPDATE catalog_item SET actual_qty = ?, stock_qty = ?, warehouse = COALESCE(?, warehouse)
							WHERE item_code = ?`,
						params: [actual ?? null, stock ?? null, warehouse || null, item_code],
					},
					...(warehouse && actual != null ? [stockStatement(item_code, warehouse, actual, now)] : []),
				]
			})

			for (const statementsPage of chunk(statements)) {
				await sql.batch(statementsPage)
			}
			return applicable.length
		},

		/**
		 * @param {Array<{item_code: string, batch_no_data?: Array, serial_no_data?: Array}>} changes
		 */
		async updateBatchSerial(changes) {
			await sql.batch(
				changes.map(({ item_code, batch_no_data, serial_no_data }) => ({
					sql: `UPDATE catalog_item SET batch_no_data = COALESCE(?, batch_no_data),
						serial_no_data = COALESCE(?, serial_no_data) WHERE item_code = ?`,
					params: [toJson(batch_no_data), toJson(serial_no_data), item_code],
				})),
			)
		},

		/** @returns {Promise<{removed: number, pricesRemoved: number}>} */
		async removeGroups(groups) {
			const rows = await sql.all(
				`SELECT item_code FROM catalog_item WHERE item_group IN (${placeholders(groups)})`,
				groups,
			)
			const codes = rows.map((row) => row.item_code)

			let pricesRemoved = 0
			const statements = [
				{
					sql: `DELETE FROM catalog_item WHERE item_group IN (${placeholders(groups)})`,
					params: groups,
				},
			]
			for (const page of chunk(codes)) {
				const [{ count }] = await sql.all(
					`SELECT COUNT(*) AS count FROM item_price WHERE item_code IN (${placeholders(page)})`,
					page,
				)
				pricesRemoved += count
				for (const table of ["item_price", "item_barcode", "stock_base"]) {
					statements.push({
						sql: `DELETE FROM ${table} WHERE item_code IN (${placeholders(page)})`,
						params: page,
					})
				}
			}

			await sql.batch(statements)
			return { removed: codes.length, pricesRemoved }
		},

		clearStatements() {
			return ["catalog_item", "item_barcode", "item_price", "stock_base"].map((table) => ({
				sql: `DELETE FROM ${table}`,
			}))
		},
	}
}
