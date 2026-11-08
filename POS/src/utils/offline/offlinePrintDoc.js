/**
 * The receipt the checkout keeps for a sale saved offline. The built-in receipts, the
 * receipt cache and the print templates all print from it, so fields are only ever
 * added: the built-in layouts read the first group, and print templates also read
 * the second.
 *
 * @module utils/offline/offlinePrintDoc
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * @param {Object} sale
 * @param {Object} sale.invoiceData - The queued payload, with offline_id, items and payments
 * @param {Object} sale.paymentData - The payment dialog's result
 * @param {Object} sale.totals - {grandTotal, roundedTotal, roundingAdjustment, totalTax, subtotal, totalDiscount, taxLines}
 * @param {string} sale.doctype
 * @param {string} sale.posProfile
 * @param {string} [sale.company]
 * @param {string} [sale.currency]
 * @param {string} sale.customerLabel - The customer's name as the cashier saw it
 * @param {Object|string} [sale.customer] - The cart's customer
 * @param {{user?: string, full_name?: string}} [sale.cashier]
 * @returns {Object}
 */
export function buildOfflinePrintDoc({
	invoiceData,
	paymentData = {},
	totals,
	doctype,
	posProfile,
	company,
	currency,
	customerLabel,
	customer,
	cashier = {},
}) {
	const paidAmount = paymentData.paid_amount ?? totals.roundedTotal ?? 0
	const grandTotal = totals.grandTotal || 0
	const amountDue = totals.roundedTotal || 0
	const totalTax = totals.totalTax || 0
	const additionalDiscount = Number(invoiceData.discount_amount) || 0
	const netTotal = round2(grandTotal - totalTax)
	const customerDoc = customer && typeof customer === "object" ? customer : {}

	return {
		// What the built-in receipts and the receipt cache have always read
		name: invoiceData.offline_id,
		doctype: doctype || "Sales Invoice",
		is_offline: true,
		pos_profile: posProfile,
		owner: cashier.full_name || undefined,
		pos_order_type: invoiceData.pos_order_type || undefined,
		posting_date: invoiceData.posting_date,
		company: company || undefined,
		customer_name: customerLabel,
		items: invoiceData.items.map((item) => ({
			...item,
			quantity: item.qty ?? item.quantity,
		})),
		grand_total: grandTotal,
		rounded_total: amountDue,
		rounding_adjustment: totals.roundingAdjustment,
		total_taxes_and_charges: totalTax,
		payments: invoiceData.payments,
		paid_amount: paidAmount,
		change_amount: paymentData.change_amount || 0,
		outstanding_amount: Math.max(0, amountDue - paidAmount),
		status: Math.max(0, amountDue - paidAmount) < 0.01 ? "Paid" : "Unpaid",
		remarks: invoiceData.remarks,
		docstatus: 0,

		// Added for print templates. The built-in layouts read none of these, so they print as before.
		offline_id: invoiceData.offline_id,
		customer: invoiceData.customer || customerDoc.name || undefined,
		customer_tax_id: customerDoc.tax_id || undefined,
		customer_mobile: customerDoc.mobile_no || undefined,
		posting_time: invoiceData.posting_time || undefined,
		currency: currency || undefined,
		cashier: cashier.user || undefined,
		cashier_name: cashier.full_name || undefined,
		taxes: (totals.taxLines || []).map((line, index) => ({ idx: index + 1, ...line })),
		net_total: netTotal,
		total: round2(netTotal + additionalDiscount),
		// discount_amount is left out: the built-in receipts would print it as a new line
		additional_discount_amount: additionalDiscount,
		total_discount: totals.totalDiscount || 0,
		total_qty: invoiceData.items.reduce((sum, item) => sum + (Number(item.qty ?? item.quantity) || 0), 0),
	}
}
