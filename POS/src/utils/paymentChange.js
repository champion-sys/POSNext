/**
 * How a payment above the total is handed back, the way ERPNext books it.
 *
 * ERPNext gives change only when a payment row's Mode of Payment type is Cash, and it
 * takes that change out of the cash account. Any part of an overpayment that no cash
 * covers would come out of the drawer without having gone in, or stay on the customer
 * as credit, so the payment dialog refuses it.
 *
 * @module utils/paymentChange
 */

import { roundCurrency } from "@/utils/currency"

/**
 * @param {Object} entry - Payment entry: { mode_of_payment, amount, type, is_customer_credit }
 * @param {Array} methods - The POS Profile's payment methods
 * @param {Function} isCashMethod - Fallback for a method whose type is not known
 * @returns {boolean} Whether change can come out of this payment
 */
export function givesChange(entry, methods, isCashMethod) {
	if (entry?.is_customer_credit) return false
	const method = (methods || []).find((m) => m.mode_of_payment === entry?.mode_of_payment)
	const type = method?.type || entry?.type
	if (type) return String(type).toLowerCase() === "cash"
	return Boolean(isCashMethod?.(method))
}

/**
 * @param {Object} options
 * @param {Array} options.entries - Payment entries
 * @param {Array} options.methods - The POS Profile's payment methods
 * @param {number} options.total - The amount to collect
 * @param {Function} [options.isCashMethod] - Fallback for a method whose type is not known
 * @returns {{paid: number, cashPaid: number, overpaid: number, nonCashOverpayment: number, change: number}}
 */
export function getChangeBreakdown({ entries, methods, total, isCashMethod }) {
	let paid = 0
	let cashPaid = 0
	for (const entry of entries || []) {
		const amount = Number(entry.amount) || 0
		paid += amount
		if (givesChange(entry, methods, isCashMethod)) cashPaid += amount
	}
	paid = roundCurrency(paid)
	cashPaid = roundCurrency(cashPaid)

	const over = paid - roundCurrency(Number(total) || 0)
	const overpaid = over > 0 ? roundCurrency(over) : 0
	const uncovered = overpaid - cashPaid
	const nonCashOverpayment = uncovered > 0 ? roundCurrency(uncovered) : 0

	return {
		paid,
		cashPaid,
		overpaid,
		nonCashOverpayment,
		change: nonCashOverpayment > 0 ? 0 : overpaid,
	}
}
