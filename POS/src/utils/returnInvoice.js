/**
 * What a return refunds and where its goods go, the same online and offline.
 */

import { roundCurrency } from "@/utils/currency"

/**
 * What the first `units` units returned of a row give back, in the smallest coin.
 *
 * Rounded down, so the coins a row's value does not divide into come back with its last
 * units, and all of its units give back exactly its value. The server works this out the
 * same way, in _refund_for_units of pos_next/api/invoices.py, and prices the return to it.
 *
 * @param {number} value - What the sale took for the whole row, in coins
 * @param {number} qtySold - The row's quantity on the sale
 * @param {number} units - Units returned, counting this return
 * @returns {number}
 */
export function refundForUnits(value, qtySold, units) {
	if (units <= 0) return 0
	if (units >= qtySold) return value
	return Math.floor((value * units) / qtySold + 1e-6)
}

/**
 * What one selected row of a return gives back.
 *
 * A row with refund_value (from prepare_return_invoice) gives back its share of what the
 * sale took for it, counting the units earlier returns took. A row without it (a sale still
 * in the queue, or a document kept from before) counts at its rate with tax.
 *
 * @param {{return_qty: number, refund_value?: number, original_qty?: number, already_returned?: number, rate: number, rate_with_tax?: number}} item
 * @param {{precision?: number}} [ledger] - refund_precision of the prepared return
 * @returns {number}
 */
export function returnRowRefund(item, { precision = 2 } = {}) {
	const qty = Number(item.return_qty) || 0
	if (item.refund_value === undefined || item.refund_value === null) {
		return roundCurrency(qty * (Number(item.rate_with_tax || item.rate) || 0))
	}
	const factor = 10 ** precision
	const value = Math.round(Number(item.refund_value) * factor)
	const sold = Number(item.original_qty) || 0
	const before = Number(item.already_returned) || 0
	return (refundForUnits(value, sold, before + qty) - refundForUnits(value, sold, before)) / factor
}

/**
 * The refund of the selected return rows: what the server will total the return at.
 *
 * Rows with refund_value add up their shares in whole coins, plus the balance earlier
 * returns of the invoice left (return_balance, nothing unless one was priced some other
 * way). Returning everything then gives back exactly what the sale took. A refund is
 * never below nothing.
 *
 * Rows without refund_value are added up the way ERPNext totals a return at their rates:
 * each row is worth its rate times its quantity, rounded per row, and a tax that was not
 * in the rate (tax_fraction) is rounded once on the sum of the rows, as ERPNext rounds
 * each tax once over the invoice. A row without tax_fraction counts at its rate with tax.
 *
 * @param {Array<{return_qty: number, rate: number, refund_value?: number, original_qty?: number, already_returned?: number, rate_with_tax?: number, tax_fraction?: number, tax_included_in_rate?: boolean}>} items
 * @param {{balance?: number, precision?: number}} [ledger] - return_balance and refund_precision of the prepared return
 * @returns {number}
 */
export function computeReturnTotal(items, { balance = 0, precision = 2 } = {}) {
	const rows = items || []
	if (rows.length && rows.every((item) => item.refund_value !== undefined && item.refund_value !== null)) {
		const factor = 10 ** precision
		let coins = Math.round((Number(balance) || 0) * factor)
		for (const item of rows) {
			coins += Math.round(returnRowRefund(item, { precision }) * factor)
		}
		return Math.max(0, coins) / factor
	}

	let net = 0
	let taxable = 0

	for (const item of rows) {
		const qty = Number(item.return_qty) || 0
		const known = item.tax_fraction !== undefined && item.tax_fraction !== null
		if (known) {
			net += roundCurrency(qty * (Number(item.rate) || 0))
			if (!item.tax_included_in_rate) {
				taxable += qty * (Number(item.rate) || 0) * Number(item.tax_fraction)
			}
		} else {
			net += roundCurrency(qty * (Number(item.rate_with_tax || item.rate) || 0))
		}
	}

	return roundCurrency(net + roundCurrency(taxable))
}

/**
 * The warehouse a returned row goes back into.
 *
 * A return taken at another branch puts the goods on that branch's shelves, where its
 * refund also comes from, not into the warehouse of the branch that sold them.
 *
 * @param {{warehouse?: string}} item - Row of the prepared return
 * @param {{originalProfile?: string, currentProfile?: string, currentWarehouse?: string}} context
 * @returns {string|undefined}
 */
export function returnRowWarehouse(item, { originalProfile, currentProfile, currentWarehouse } = {}) {
	const otherBranch = Boolean(originalProfile && currentProfile && originalProfile !== currentProfile)
	return (otherBranch && currentWarehouse) || item.warehouse
}
