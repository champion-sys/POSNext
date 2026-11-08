# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""The discount and payment limits of a POS sale, held on the server.

The POS enforces these on the screen, but update_invoice and submit_invoice save with
ignore_permissions and a queued record arrives as stored on a device, so the server has
to hold them too. The settings and their defaults are the ones the POS reads (bootstrap's
_get_pos_settings), so a sale the screen allowed passes here.

Each refusal has its own exception class. The sync classifier records the class name as
the error code, so a queued record that breaks a limit goes to Needs Review with it.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt

from pos_next.api.constants import DEFAULT_POS_SETTINGS

#: What the limits read from POS Settings
LIMIT_FIELDS = (
	"max_discount_allowed",
	"allow_user_to_edit_additional_discount",
	"allow_partial_payment",
	"allow_credit_sale",
	"allow_customer_credit_payment",
)


class DiscountLimitError(frappe.ValidationError):
	"""A line or invoice discount above the POS Settings' max_discount_allowed."""


class AdditionalDiscountNotAllowedError(frappe.ValidationError):
	"""An invoice discount on a POS Profile that does not allow one."""


class CouponDiscountError(frappe.ValidationError):
	"""A discount the sale's coupon does not give."""


class UnderpaidError(frappe.ValidationError):
	"""Paid less than the total, where neither partial payment nor credit sale is allowed."""


class NonCashOverpaymentError(frappe.ValidationError):
	"""Paid above the total with money that is not cash, so no change can come of it."""


def get_limit_settings(pos_profile):
	"""The limits the POS works with for a POS Profile.

	As bootstrap loads them: an enabled POS Settings record, otherwise the defaults.

	Returns:
		frappe._dict
	"""
	settings = None
	if pos_profile:
		settings = frappe.db.get_value(
			"POS Settings",
			{"pos_profile": pos_profile, "enabled": 1},
			list(LIMIT_FIELDS),
			as_dict=True,
		)
	return frappe._dict(settings or {field: DEFAULT_POS_SETTINGS.get(field, 0) for field in LIMIT_FIELDS})


def get_rounding_settings(pos_profile_doc):
	"""What the POS needs to show and collect ERPNext's rounded total.

	The invoice takes disable_rounded_total from the POS Profile (save_invoice_draft), and
	ERPNext rounds to the currency's smallest_currency_fraction_value, or to a whole number
	when that is not set.

	Args:
		pos_profile_doc: The POS Profile, or its name

	Returns:
		dict: disable_rounded_total, and smallest_currency_fraction_value (None when the
			profile has no currency to read it from)
	"""
	if isinstance(pos_profile_doc, str):
		pos_profile_doc = frappe.get_cached_doc("POS Profile", pos_profile_doc)
	currency = pos_profile_doc.get("currency") or (
		pos_profile_doc.get("company")
		and frappe.get_cached_value("Company", pos_profile_doc.company, "default_currency")
	)
	fraction = None
	if currency:
		fraction = flt(frappe.db.get_value("Currency", currency, "smallest_currency_fraction_value", cache=True))
	return {
		"disable_rounded_total": cint(pos_profile_doc.get("disable_rounded_total")),
		"smallest_currency_fraction_value": fraction,
	}


def _precision(doc):
	return cint(doc.precision("grand_total")) or 2


def _unit(doc):
	"""One unit of the currency's last decimal, what screen and server rounding can differ by."""
	return 1 / (10 ** _precision(doc))


def _rule_names(value):
	if not value:
		return []
	if isinstance(value, list | tuple):
		return [str(name).strip() for name in value if str(name).strip()]
	return [name.strip() for name in str(value).split(",") if name.strip()]


def _active_pricing_rules(doc):
	names = {name for item in doc.get("items") or [] for name in _rule_names(item.get("pricing_rules"))}
	if not names:
		return set()
	return set(frappe.get_all("Pricing Rule", filters={"name": ["in", list(names)], "disable": 0}, pluck="name"))


def check_line_discounts(doc, settings, pos_profile):
	"""Refuse a line sold further below its list price than max_discount_allowed.

	A line priced by an offer follows that offer, as on the screen, and a free item is
	free. An edited rate is checked against its original price the way the draft checks it.
	"""
	from pos_next.api.invoices import validate_manual_rate_edit

	max_percent = flt(settings.max_discount_allowed)
	precision = _precision(doc)
	unit = _unit(doc)
	offers = None

	for item in doc.get("items") or []:
		if cint(item.get("is_free_item")):
			continue

		if cint(item.get("is_rate_manually_edited")):
			result = validate_manual_rate_edit(item, pos_profile)
			if not result.get("valid"):
				frappe.throw(result.get("message"), DiscountLimitError)
			continue

		if max_percent <= 0:
			continue

		rules = _rule_names(item.get("pricing_rules"))
		if rules:
			if offers is None:
				offers = _active_pricing_rules(doc)
			if all(name in offers for name in rules):
				continue

		list_rate = flt(item.get("price_list_rate"))
		rate = flt(item.get("rate"))
		if list_rate <= 0 or rate >= list_rate:
			continue

		lowest = list_rate * (1 - max_percent / 100)
		if flt(lowest - rate, precision) > unit:
			frappe.throw(
				_("Row #{0}: {1} is sold at {2}, {3}% below its price of {4}. The most allowed is {5}%.").format(
					item.get("idx"),
					item.get("item_code"),
					rate,
					flt((list_rate - rate) / list_rate * 100, 2),
					list_rate,
					max_percent,
				),
				DiscountLimitError,
			)


def _totals_before_invoice_discount(doc):
	"""Net and grand total of the sale with no invoice discount, a coupon's two bases."""
	saved = (doc.get("discount_amount"), doc.get("additional_discount_percentage"))
	doc.discount_amount = 0
	doc.additional_discount_percentage = 0
	try:
		doc.calculate_taxes_and_totals()
		return flt(doc.net_total), flt(doc.grand_total)
	finally:
		doc.discount_amount, doc.additional_discount_percentage = saved
		doc.calculate_taxes_and_totals()


def get_coupon_allowance(doc, coupon_code):
	"""The discount a coupon gives this sale, worked out from the coupon itself.

	The same rule as CouponDialog: its percentage (or amount) of its base, at most its
	maximum, never more than the base. A sale below its minimum gets nothing from it.

	Returns:
		float
	"""
	coupon = frappe.db.get_value(
		"POS Coupon",
		{"coupon_code": str(coupon_code).upper()},
		["coupon_code", "discount_type", "discount_percentage", "discount_amount", "min_amount", "max_amount", "apply_on"],
		as_dict=True,
	)
	if not coupon:
		return 0

	precision = _precision(doc)
	net_base, grand_base = _totals_before_invoice_discount(doc)
	base = net_base if coupon.apply_on == "Net Total" else grand_base

	if flt(coupon.min_amount) and flt(coupon.min_amount - base, precision) > 0:
		frappe.throw(
			_("Coupon {0} needs a sale of at least {1}, and this one is {2}").format(
				coupon.coupon_code, flt(coupon.min_amount), base
			),
			CouponDiscountError,
		)

	if coupon.discount_type == "Percentage":
		amount = flt(base * flt(coupon.discount_percentage) / 100, precision)
	else:
		amount = flt(coupon.discount_amount)
	if flt(coupon.max_amount):
		amount = min(amount, flt(coupon.max_amount))
	return max(0.0, min(amount, base))


def check_invoice_discount(doc, settings, coupon_code=None):
	"""Refuse an invoice discount the POS would not have allowed.

	A coupon's share is what the coupon gives. Anything above it is a discount the cashier
	typed: refused when additional discount is off, and held to max_discount_allowed of
	the sale's list price, the base the payment dialog uses.
	"""
	discount = flt(doc.get("discount_amount"))
	if discount <= 0:
		return

	precision = _precision(doc)
	unit = _unit(doc)
	coupon_share = get_coupon_allowance(doc, coupon_code) if coupon_code else 0
	typed = flt(discount - coupon_share, precision)
	if typed <= unit:
		return

	if not cint(settings.allow_user_to_edit_additional_discount):
		if coupon_code:
			frappe.throw(
				_("The invoice discount is {0}, and coupon {1} gives {2}").format(discount, coupon_code, coupon_share),
				CouponDiscountError,
			)
		frappe.throw(
			_("An invoice discount of {0} is not allowed on POS Profile {1}").format(discount, doc.get("pos_profile")),
			AdditionalDiscountNotAllowedError,
		)

	max_percent = flt(settings.max_discount_allowed)
	if max_percent <= 0:
		return

	base = sum(
		flt(item.get("price_list_rate")) * flt(item.get("qty"))
		for item in doc.get("items") or []
		if not cint(item.get("is_free_item"))
	)
	allowed = flt(base * max_percent / 100, precision)
	if flt(typed - allowed, precision) > unit:
		frappe.throw(
			_("The invoice discount of {0} is more than {1}% of {2}, the most allowed").format(typed, max_percent, base),
			DiscountLimitError,
		)


def enforce_discount_limits(doc, pos_profile, coupon_code=None):
	"""Hold a sale's line and invoice discounts to the POS Profile's limits.

	Args:
		doc: The invoice, with its totals worked out
		pos_profile: POS Profile name
		coupon_code: The POS Coupon on the sale, if any
	"""
	if doc.get("is_return"):
		return

	settings = get_limit_settings(pos_profile)
	check_line_discounts(doc, settings, pos_profile)
	check_invoice_discount(doc, settings, coupon_code)


def _payment_type(row):
	return row.get("type") or frappe.get_cached_value("Mode of Payment", row.get("mode_of_payment"), "type")


def enforce_payment_limits(doc, pos_profile, write_off_amount=0, redeemed_credit=0):
	"""Refuse a sale paid short where the POS allows no debt, or overpaid with non-cash money.

	The amount due is what ERPNext collects: the rounded total when rounding is on. A
	write-off counts on a Sales Invoice only, the one doctype that applies it.

	Args:
		doc: The invoice, with its totals worked out
		pos_profile: POS Profile name
		write_off_amount: The write-off that will be applied
		redeemed_credit: Customer credit redeemed for this sale
	"""
	if doc.doctype not in ("Sales Invoice", "POS Invoice") or doc.get("is_return"):
		return

	precision = _precision(doc)
	due = flt(doc.get("rounded_total")) or flt(doc.get("grand_total"))
	paid = flt(sum(flt(row.amount) for row in doc.get("payments") or []), precision)
	if doc.get("redeem_loyalty_points"):
		paid += flt(doc.get("loyalty_amount"))

	write_off = flt(write_off_amount) if doc.doctype == "Sales Invoice" else 0
	short = flt(due - paid - flt(redeemed_credit) - write_off, precision)
	if short > 0:
		settings = get_limit_settings(pos_profile)
		if not (cint(settings.allow_partial_payment) or cint(settings.allow_credit_sale)):
			frappe.throw(
				_("{0} is due and {1} was paid. POS Profile {2} allows neither partial payment nor credit sale.").format(
					due, flt(paid + flt(redeemed_credit) + write_off, precision), pos_profile
				),
				UnderpaidError,
			)

	over = flt(paid - due, precision)
	if over > 0:
		cash = sum(flt(row.amount) for row in doc.get("payments") or [] if _payment_type(row) == "Cash")
		if flt(over - cash, precision) > 0:
			frappe.throw(
				_("Paid {0} above the total of {1}, more than the {2} paid in cash. Change is given only from cash.").format(
					over, due, flt(cash, precision)
				),
				NonCashOverpaymentError,
			)


def cap_write_off(doc, write_off_amount, redeemed_credit=0):
	"""A write-off covers at most what is left unpaid, never more.

	A larger one, such as one carried over from a failed checkout, would leave the
	customer a credit nobody gave.

	Returns:
		float
	"""
	precision = _precision(doc)
	due = flt(doc.get("rounded_total")) or flt(doc.get("grand_total"))
	paid = sum(flt(row.amount) for row in doc.get("payments") or [])
	left = flt(due - paid - flt(redeemed_credit), precision)
	return max(0.0, min(flt(write_off_amount), left))
