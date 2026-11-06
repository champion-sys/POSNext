/**
 * Pure helpers for the queue records that are not plain sales: customers, payments on
 * existing invoices, and shift closes. Offline returns and coupons live here too,
 * because both depend on what is waiting in the queue.
 * No store or database imports, so they can be tested directly and shared with the worker.
 *
 * @module utils/offline/entities
 */

import { formatLocalPosting } from "./invoicePayload"

export const ENTITY_INVOICE = "invoice"
export const ENTITY_CUSTOMER = "customer"
export const ENTITY_PAYMENT = "payment"
export const ENTITY_SHIFT_CLOSE = "shift_close"

const LOCAL_NAME_PREFIX = "pos_offline_"

/** Same tolerance as AMOUNT_TOLERANCE in pos_next.api.partial_payments */
const AMOUNT_TOLERANCE = 0.01

const MS_PER_DAY = 24 * 60 * 60 * 1000

const roundAmount = (value) => Math.round((Number(value) || 0) * 100) / 100

const unique = (values) => [...new Set(values)]

/**
 * Whether a name was given by a device and does not exist on the server yet.
 * @param {*} value
 * @returns {boolean}
 */
export function isLocalName(value) {
	return typeof value === "string" && value.startsWith(LOCAL_NAME_PREFIX)
}

/**
 * Rows queued before the outbox had entities are all sales.
 * @param {Object} row - Queue row
 * @returns {string}
 */
export function getEntity(row) {
	return row?.entity || ENTITY_INVOICE
}

/**
 * Records an invoice cannot post without. A local customer's or invoice's name is the
 * offline_id of its queue row, so this still works after that row has left the device.
 * @param {Object} invoice - Invoice payload
 * @returns {string[]} Offline IDs
 */
export function getInvoiceDependencies(invoice) {
	return unique([invoice.customer, invoice.return_against].filter(isLocalName))
}

/**
 * Queue rows that would wait forever if this one were deleted or replaced.
 * @param {Array} rows - Pending queue rows
 * @param {string} offlineId
 * @returns {Array}
 */
export function getDependentRows(rows, offlineId) {
	return rows.filter((row) => row.depends_on?.includes(offlineId))
}

/**
 * @param {Object} customer - The form's values
 * @param {{offlineId: string, posProfile: string, company: string, cashier: string}} context
 * @returns {Object} Queue payload
 */
export function buildCustomerPayload(customer, { offlineId, posProfile, company, cashier }) {
	return {
		doctype: "Customer",
		offline_id: offlineId,
		customer_name: customer.customer_name,
		mobile_no: customer.mobile_no || "",
		email_id: customer.email_id || "",
		customer_group: customer.customer_group,
		territory: customer.territory,
		pos_profile: posProfile,
		company,
		cashier,
	}
}

/**
 * The customer the POS works with until the server gives it a real name.
 * @param {Object} payload - From buildCustomerPayload
 * @returns {Object}
 */
export function buildLocalCustomer(payload) {
	return {
		name: payload.offline_id,
		customer_name: payload.customer_name,
		mobile_no: payload.mobile_no,
		email_id: payload.email_id,
		customer_group: payload.customer_group,
		territory: payload.territory,
		disabled: 0,
		is_local: 1,
	}
}

/**
 * @param {{invoice: Object, payments: Array, posProfile: string, shift: string,
 *   cashier: string, timestamp?: number}} payment
 * @returns {Object} Queue payload
 */
export function buildPaymentPayload({ invoice, payments, posProfile, shift, cashier, timestamp = Date.now() }) {
	return {
		doctype: "Payment Entry",
		invoice_name: invoice.name,
		customer: invoice.customer,
		pos_profile: posProfile,
		posa_pos_opening_shift: shift,
		cashier,
		...formatLocalPosting(timestamp),
		payments: payments
			.filter((payment) => Number(payment.amount) > 0)
			.map(({ mode_of_payment, amount }) => ({ mode_of_payment, amount })),
	}
}

/**
 * Payments waiting to reach the server, per invoice.
 * @param {Array} rows - Pending queue rows
 * @returns {Map<string, number>}
 */
export function sumQueuedPayments(rows) {
	const totals = new Map()
	for (const row of rows) {
		if (getEntity(row) !== ENTITY_PAYMENT) continue
		const amount = (row.data?.payments || []).reduce(
			(sum, payment) => sum + (Number(payment.amount) || 0),
			0,
		)
		totals.set(row.data?.invoice_name, roundAmount((totals.get(row.data?.invoice_name) || 0) + amount))
	}
	return totals
}

/**
 * Show unpaid invoices as they will be once the queue has reached the server. Derived
 * from the queue, so it survives a restart and clears as payments leave it.
 * @param {Array} invoices - Invoices as the server last reported them
 * @param {Array} rows - Pending queue rows
 * @returns {Array} New invoice objects where a payment is waiting
 */
export function applyQueuedPayments(invoices, rows) {
	const queued = sumQueuedPayments(rows)
	return invoices.map((invoice) => {
		const amount = queued.get(invoice.name)
		if (!amount) return invoice
		return {
			...invoice,
			queued_payment: amount,
			paid_amount: roundAmount(Number(invoice.paid_amount) + amount),
			outstanding_amount: Math.max(0, roundAmount(Number(invoice.outstanding_amount) - amount)),
		}
	})
}

/**
 * The offline form of the server's check, on the amount left after the queue.
 * @param {Object} invoice - From applyQueuedPayments
 * @param {Array} payments
 * @returns {boolean}
 */
export function exceedsOutstanding(invoice, payments) {
	const total = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0)
	return total > Number(invoice.outstanding_amount) + AMOUNT_TOLERANCE
}

/**
 * Uses of a coupon by sales this device has not sent yet, which the cached count cannot include.
 * @param {Array} rows - Pending queue rows
 * @param {string} code
 * @param {string} [customer]
 * @returns {{total: number, forCustomer: number}}
 */
export function countQueuedCouponUses(rows, code, customer) {
	const target = String(code).toUpperCase()
	const uses = rows.filter(
		(row) =>
			getEntity(row) === ENTITY_INVOICE &&
			String(row.data?.coupon_code || "").toUpperCase() === target,
	)
	return {
		total: uses.length,
		forCustomer: uses.filter((row) => row.data?.customer === customer).length,
	}
}

/**
 * Check a coupon against the cache, with the rules of pos_next.api.offers.validate_coupon.
 * Another device may use the same coupon meanwhile, which only the server can see.
 * @param {Object|null} coupon - The cached coupon
 * @param {{customer: string, company: string, today: string, total: number,
 *   forCustomer: number}} context - today is YYYY-MM-DD; total and forCustomer are queued uses
 * @returns {string|null} Why it was refused, or null when it may be applied
 */
export function getCachedCouponProblem(coupon, { customer, company, today, total = 0, forCustomer = 0 }) {
	if (!coupon || coupon.company !== company) return "not_found"
	if (coupon.disabled) return "disabled"
	if (coupon.coupon_type === "Gift Card") return "gift_card"
	if (coupon.maximum_use > 0 && (Number(coupon.used) || 0) + total >= coupon.maximum_use) return "limit"
	if (coupon.valid_from && coupon.valid_from > today) return "not_started"
	if (coupon.valid_upto && coupon.valid_upto < today) return "expired"
	if (coupon.customer && coupon.customer !== customer) return "customer"
	if (coupon.one_use && forCustomer > 0) return "one_use"
	return null
}

const dayNumber = (date) => Math.floor(Date.parse(String(date).slice(0, 10)) / MS_PER_DAY)

/**
 * The rules of pos_next.api.invoices.check_invoice_return_validity, on a cached document.
 * @param {Object} doc - Prepared return with _return_rules and _original_invoice
 * @param {string} today - YYYY-MM-DD
 * @returns {Object} The same shape as the server's answer
 */
export function checkReturnValidity(doc, today) {
	const rules = doc._return_rules || {}
	if (!rules.allow_return) return { valid: false, error_type: "return_not_allowed" }

	const allowedDays = Number(rules.return_validity_days) || 0
	const postingDate = doc._original_invoice?.posting_date
	if (allowedDays > 0 && postingDate) {
		const daysSince = dayNumber(today) - dayNumber(postingDate)
		if (daysSince > allowedDays) {
			return {
				valid: false,
				error_type: "return_period_expired",
				invoice_name: doc.return_against,
				invoice_date: postingDate,
				days_since: daysSince,
				allowed_days: allowedDays,
			}
		}
	}
	return { valid: true }
}

const getReturnItemKey = (item) =>
	item.sales_invoice_item || item.pos_invoice_item || `${item.item_code}:${item.original_idx}`

/**
 * Take off what returns in the queue already gave back. A synced return counts only
 * if it is newer than the cached document, otherwise the document includes it.
 * @param {Object} doc - Prepared return
 * @param {Array} rows - Queue rows, including those that have synced
 * @returns {Object} A new document
 */
export function subtractQueuedReturns(doc, rows) {
	const returned = new Map()
	for (const row of rows) {
		const data = row.data || {}
		if (getEntity(row) !== ENTITY_INVOICE || !data.is_return) continue
		if (data.return_against !== doc.return_against) continue
		if (row.synced && row.timestamp <= (doc._cached_at || 0)) continue

		for (const item of data.items || []) {
			const key = getReturnItemKey(item)
			returned.set(key, (returned.get(key) || 0) + Math.abs(Number(item.qty) || 0))
		}
	}

	return {
		...doc,
		items: doc.items.map((item) => {
			const used = returned.get(getReturnItemKey(item)) || 0
			return {
				...item,
				already_returned: (Number(item.already_returned) || 0) + used,
				remaining_qty: Math.max(0, item.remaining_qty - used),
			}
		}),
	}
}

/**
 * Whether a queued sale can be returned. A sale under review may never post.
 * @param {Object} row - Queue row
 * @returns {boolean}
 */
export function isReturnableQueueRow(row) {
	const data = row.data || {}
	return (
		getEntity(row) === ENTITY_INVOICE &&
		!data.is_return &&
		data.doctype !== "Sales Order" &&
		!row.superseded &&
		!row.sync_failed &&
		row.server_status !== "voided"
	)
}

/**
 * A prepared return for a sale that exists only in the queue, in the shape of
 * prepare_return_invoice. The refund per unit is an estimate: the server replaces the
 * rates with the invoice's own when it processes the return.
 * @param {Object} row - Queue row of the sale
 * @param {{allow_return: *, return_validity_days: *}} rules - The POS Settings
 * @returns {Object}
 */
export function buildReturnDocFromQueue(row, rules) {
	const invoice = row.data
	const items = invoice.items || []
	const subtotal = items.reduce((sum, item) => sum + Number(item.qty) * Number(item.rate), 0)
	const toPaid = subtotal > 0 && invoice.grand_total ? invoice.grand_total / subtotal : 1

	const paid = roundAmount(
		(invoice.payments || []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0) -
			(Number(invoice.change_amount) || 0),
	)

	return {
		doctype: invoice.doctype || "Sales Invoice",
		return_against: row.server_invoice || row.offline_id,
		customer: invoice.customer,
		customer_name: invoice.customer_name,
		company: invoice.company,
		sales_team: invoice.sales_team || [],
		_return_rules: rules,
		_original_invoice: {
			name: row.server_invoice || row.offline_id,
			customer: invoice.customer,
			customer_name: invoice.customer_name,
			posting_date: invoice.posting_date,
			grand_total: invoice.grand_total,
			paid_amount: paid,
			outstanding_amount: Math.max(0, roundAmount(invoice.grand_total - paid)),
			payments: invoice.payments || [],
		},
		items: items.map((item, index) => ({
			item_code: item.item_code,
			item_name: item.item_name,
			uom: item.uom,
			warehouse: item.warehouse,
			conversion_factor: item.conversion_factor,
			rate: item.rate,
			price_list_rate: item.price_list_rate,
			rate_with_tax: roundAmount(Number(item.rate) * toPaid),
			original_idx: index + 1,
			original_qty: Number(item.qty),
			already_returned: 0,
			remaining_qty: Number(item.qty),
		})),
	}
}

/**
 * The opening shift's modes and the profile's, for the counted amounts. Wallets are left
 * out as they are from the opening balance, because no cash for them is in the drawer.
 * @param {Object} openingShift - POS Opening Shift
 * @param {Array} paymentMethods - Cached payment methods
 * @returns {Object} A draft with the shape ShiftClosingDialog works with
 */
export function buildClosingDraft(openingShift, paymentMethods) {
	const modes = unique([
		...(openingShift.balance_details || []).map((row) => row.mode_of_payment),
		...paymentMethods.filter((method) => !method.is_wallet_payment).map((method) => method.mode_of_payment),
	])

	return {
		pos_opening_shift: openingShift.name,
		pos_profile: openingShift.pos_profile,
		company: openingShift.company,
		period_start_date: openingShift.period_start_date,
		user: openingShift.user,
		pos_transactions: [],
		payment_reconciliation: modes.map((mode_of_payment) => ({
			mode_of_payment,
			opening_amount: 0,
			expected_amount: 0,
		})),
	}
}

/**
 * Everything of this shift that went through the queue. The server compares this list
 * with what it received, so a sale that never arrived cannot be closed over.
 * @param {Array} rows - Queue rows, including those that have synced
 * @param {string} shift - POS Opening Shift name
 * @returns {string[]} Offline IDs
 */
export function getShiftManifest(rows, shift) {
	return rows
		.filter(
			(row) =>
				getEntity(row) !== ENTITY_SHIFT_CLOSE &&
				!row.superseded &&
				row.data?.posa_pos_opening_shift === shift,
		)
		.map((row) => row.offline_id)
}

/**
 * @param {{closing: Object, manifest: string[], cashier: string, timestamp?: number}} shiftClose
 * @returns {Object} Queue payload. Only what was counted: the server works out the rest.
 */
export function buildShiftClosePayload({ closing, manifest, cashier, timestamp = Date.now() }) {
	const { posting_date, posting_time } = formatLocalPosting(timestamp)
	return {
		doctype: "POS Closing Shift",
		pos_opening_shift: closing.pos_opening_shift,
		pos_profile: closing.pos_profile,
		company: closing.company,
		cashier,
		posting_date,
		period_end_date: `${posting_date} ${posting_time}`,
		closing_amounts: closing.payment_reconciliation.map((row) => ({
			mode_of_payment: row.mode_of_payment,
			closing_amount: Number(row.closing_amount) || 0,
		})),
		manifest,
	}
}
