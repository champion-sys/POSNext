/**
 * What a return refunds and where its goods go, the same online and offline.
 */

import { roundCurrency } from "@/utils/currency"

/**
 * The refund of the selected return rows, added up the way ERPNext totals the return.
 *
 * Each row is worth its rate times its quantity, rounded per row. A tax that was not in the
 * rate (tax_fraction, from prepare_return_invoice) is rounded once on the sum of the rows,
 * as ERPNext rounds each tax once over the invoice. Adding a tax rounded per unit instead
 * can run a cent over the server's total, and ERPNext refuses a refund over the total.
 * A row without tax_fraction (a sale still in the queue, or a document kept from before)
 * counts at its rate with tax.
 *
 * @param {Array<{return_qty: number, rate: number, rate_with_tax?: number, tax_fraction?: number, tax_included_in_rate?: boolean}>} items
 * @returns {number}
 */
export function computeReturnTotal(items) {
	let net = 0
	let taxable = 0

	for (const item of items || []) {
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
