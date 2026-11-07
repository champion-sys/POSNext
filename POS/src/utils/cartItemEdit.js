/**
 * What a cashier may change on a cart line, and how a change is checked. The edit
 * dialog and the cart's table both use these rules, so neither can do what the other
 * refuses.
 *
 * @module utils/cartItemEdit
 */

import { roundCurrency } from "@/utils/currency"

const ARABIC_DIGIT_ZERO = "٠".charCodeAt(0)
const PERSIAN_DIGIT_ZERO = "۰".charCodeAt(0)

// As the app prints a figure. Read as a decimal, 1,000 would become 1 with no warning.
const GROUPED_FIGURE = /^-?\d{1,3}(?:[,٬]\d{3})+(?:[.٫]\d*)?$/

/**
 * @param {Object} item - Cart line
 * @returns {boolean} Whether a promotional offer set this line's price
 */
export function hasPricingRules(item) {
	return Boolean(item?.pricing_rules) && item.pricing_rules.length > 0
}

/**
 * @param {Object} item - Cart line
 * @param {Object} settings - POS settings store
 * @returns {boolean}
 */
export function canEditItemRate(item, settings) {
	return Boolean(settings.allowUserToEditRate) && !hasPricingRules(item)
}

/**
 * @param {Object} item - Cart line
 * @param {Object} settings - POS settings store
 * @returns {string} Why the rate is locked, empty when it is not
 */
export function getRateLockReason(item, settings) {
	if (!settings.allowUserToEditRate) return __("Rate editing is disabled")
	if (hasPricingRules(item)) return __("Locked (offer applied)")
	return ""
}

/**
 * A rate below the list price is a discount, so it has the same limit.
 * @param {number} rate - The new rate
 * @param {number} listRate - The rate before editing
 * @param {number} maxDiscount - Percent, 0 for no limit
 * @returns {string|null} Why the rate is refused
 */
export function getRateError(rate, listRate, maxDiscount) {
	if (rate <= 0) return __("Rate must be greater than zero")

	if (maxDiscount > 0 && rate < listRate) {
		const percent = Math.round(((listRate - rate) / listRate) * 10000) / 100
		if (percent > maxDiscount) {
			return __(
				"Rate reduction of {0}% exceeds maximum allowed discount of {1}%",
				[percent.toFixed(2), maxDiscount],
			)
		}
	}
	return null
}

/**
 * @param {number} rate - The new rate
 * @param {number} listRate - The rate before editing
 * @returns {Object} What the cart store needs to record a rate, and whether it was edited
 */
export function buildRateUpdate(rate, listRate) {
	const edited = rate !== listRate
	return {
		rate,
		price_list_rate: listRate,
		is_rate_manually_edited: edited ? 1 : 0,
		original_rate: edited ? listRate : null,
	}
}

/**
 * @param {number} percent
 * @param {number} maxDiscount - Percent, 0 for no limit
 * @returns {number}
 */
export function capDiscountPercent(percent, maxDiscount) {
	return Math.min(percent, maxDiscount > 0 ? Math.min(maxDiscount, 100) : 100)
}

/**
 * @param {number} amount
 * @param {number} subtotal - The line before discount
 * @param {number} maxDiscount - Percent, 0 for no limit
 * @returns {number}
 */
export function capDiscountAmount(amount, subtotal, maxDiscount) {
	return Math.min(
		amount,
		roundCurrency((subtotal * capDiscountPercent(100, maxDiscount)) / 100),
	)
}

/**
 * @param {Object} item - Cart line
 * @returns {string[]} Units this line can be sold in
 */
export function getUnitOptions(item) {
	const units = [
		item.uom,
		item.stock_uom,
		...(item.item_uoms || []).map((row) => row.uom),
	]
	return [...new Set(units.filter(Boolean))]
}

/**
 * What can be changed in the line itself. A serial or batch quantity depends on what
 * was picked, and a resolved barcode carries its own quantity, unit and price.
 * @param {Object} item - Cart line
 * @param {Object} settings - POS settings store
 * @returns {{quantity: boolean, quantityInDialog: boolean, unit: boolean, rate: boolean,
 *   discount: boolean, remove: boolean}}
 */
export function getLineEditRules(item, settings) {
	if (item.is_free_item) {
		return {
			quantity: false,
			quantityInDialog: false,
			unit: false,
			rate: false,
			discount: false,
			remove: false,
		}
	}

	const tracked = Boolean(item.has_serial_no || item.has_batch_no)
	const resolved = Boolean(item.is_resolved_barcode)

	return {
		quantity: !tracked && !resolved,
		quantityInDialog: tracked && !resolved,
		unit: !tracked && !resolved && getUnitOptions(item).length > 1,
		rate: !resolved && canEditItemRate(item, settings),
		discount: Boolean(settings.allowItemDiscount),
		remove: true,
	}
}

/**
 * @param {string} text - As typed, on a keyboard that may give Arabic digits
 * @returns {number|null} null when it is not a number
 */
export function parseCartNumber(text) {
	const digits = String(text ?? "")
		.trim()
		.replace(/[٠-٩]/g, (digit) => digit.charCodeAt(0) - ARABIC_DIGIT_ZERO)
		.replace(/[۰-۹]/g, (digit) => digit.charCodeAt(0) - PERSIAN_DIGIT_ZERO)

	const western = (
		GROUPED_FIGURE.test(digits) ? digits.replace(/[,٬]/g, "") : digits
	).replace(/[٫,]/g, ".")

	if (!/^-?(\d+\.?\d*|\.\d+)$/.test(western)) return null
	return Number.parseFloat(western)
}

/**
 * @param {number|null} quantity - As typed
 * @returns {number|null} The quantity to use, or null when it must be refused
 */
export function normalizeQuantity(quantity) {
	if (quantity === null || !(quantity > 0)) return null
	return Math.round(quantity * 10000) / 10000
}

/**
 * @param {Object} item - Cart line
 * @returns {boolean} Whether the code tells the cashier anything the name does not
 */
export function showsItemCode(item) {
	const code = String(item.item_code ?? "")
		.trim()
		.toLowerCase()
	return (
		Boolean(code) &&
		code !==
			String(item.item_name ?? "")
				.trim()
				.toLowerCase()
	)
}

/**
 * @param {Object} item - Cart line
 * @param {boolean} [taxInclusive] - Whether rates include tax, which a line's amount leaves out
 * @returns {number} The line's total, in the same terms as its rate
 */
export function getLineTotal(item, taxInclusive = false) {
	if (item.is_free_item) return 0

	const amount = item.amount ?? item.rate * item.quantity
	return taxInclusive ? roundCurrency(amount + (item.tax_amount || 0)) : amount
}

/**
 * @param {KeyboardEvent} event
 * @returns {boolean} Whether the key is one of the app's shortcuts, not input for a field
 */
export function isShortcutKey(event) {
	return event.altKey || /^F\d+$/.test(event.key)
}
