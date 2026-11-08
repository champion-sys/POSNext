# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import patch

import frappe
from frappe.utils import flt

from pos_next.services import sale_limits, sync_classifier
from pos_next.services.sale_limits import (
	AdditionalDiscountNotAllowedError,
	CouponDiscountError,
	DiscountLimitError,
	NonCashOverpaymentError,
	UnderpaidError,
	cap_write_off,
	enforce_discount_limits,
	enforce_payment_limits,
)

SETTINGS = {
	"max_discount_allowed": 20,
	"allow_user_to_edit_additional_discount": 0,
	"allow_partial_payment": 0,
	"allow_credit_sale": 0,
	"allow_customer_credit_payment": 0,
}


class FakeInvoice(frappe._dict):
	"""Just enough of a Sales Invoice: 15% tax on the net, discount on the grand total."""

	def precision(self, *_args):
		return 2

	def calculate_taxes_and_totals(self):
		net = sum(flt(item.rate) * flt(item.qty) for item in self["items"])
		tax = flt(net * 0.15, 2)
		self.net_total = flt(net - (flt(self.discount_amount) / 1.15 if self.discount_amount else 0), 2)
		self.grand_total = flt(net + tax - flt(self.discount_amount), 2)
		self.rounded_total = self.grand_total


def invoice(items, payments=(), discount_amount=0, doctype="Sales Invoice", **extra):
	doc = FakeInvoice(
		doctype=doctype,
		pos_profile="SI Main",
		discount_amount=discount_amount,
		additional_discount_percentage=0,
		items=[
			frappe._dict(
				idx=index + 1,
				item_code=code,
				qty=qty,
				rate=rate,
				price_list_rate=plr,
				pricing_rules=rules,
				is_free_item=0,
				is_rate_manually_edited=0,
			)
			for index, (code, qty, rate, plr, rules) in enumerate(items)
		],
		payments=[frappe._dict(mode_of_payment=mode, amount=amount, type=kind) for mode, amount, kind in payments],
		**extra,
	)
	doc.calculate_taxes_and_totals()
	return doc


def row(code, qty, rate, plr=None, rules=""):
	return (code, qty, rate, rate if plr is None else plr, rules)


class LimitsTestCase(unittest.TestCase):
	settings = SETTINGS

	def setUp(self):
		patcher = patch.object(sale_limits, "get_limit_settings", lambda _profile: frappe._dict(self.settings))
		patcher.start()
		self.addCleanup(patcher.stop)


class TestLineDiscounts(LimitsTestCase):
	def test_a_line_sold_below_the_limit_is_refused(self):
		doc = invoice([row("ITEM-A", 1, 10, 100)])
		with self.assertRaises(DiscountLimitError):
			enforce_discount_limits(doc, "SI Main")

	def test_a_line_at_the_limit_passes_despite_rounding(self):
		# 20% of 9.99 is 1.998, which the screen rounds to 2.00
		enforce_discount_limits(invoice([row("ITEM-A", 3, 7.99, 9.99)]), "SI Main")

	def test_a_line_priced_by_an_offer_follows_the_offer(self):
		doc = invoice([row("ITEM-A", 1, 50, 100, "PRLE-0001")])
		with patch.object(sale_limits.frappe, "get_all", return_value=["PRLE-0001"]):
			enforce_discount_limits(doc, "SI Main")

	def test_a_line_naming_an_offer_that_does_not_exist_is_held_to_the_limit(self):
		doc = invoice([row("ITEM-A", 1, 50, 100, "MADE-UP")])
		with patch.object(sale_limits.frappe, "get_all", return_value=[]), self.assertRaises(DiscountLimitError):
			enforce_discount_limits(doc, "SI Main")

	def test_a_return_is_not_checked(self):
		enforce_discount_limits(invoice([row("ITEM-A", -1, 10, 100)], is_return=1), "SI Main")


class TestInvoiceDiscount(LimitsTestCase):
	def test_an_invoice_discount_is_refused_where_it_is_not_allowed(self):
		with self.assertRaises(AdditionalDiscountNotAllowedError):
			enforce_discount_limits(invoice([row("ITEM-A", 1, 100)], discount_amount=60), "SI Main")

	def test_an_allowed_invoice_discount_is_held_to_the_limit(self):
		self.settings = {**SETTINGS, "allow_user_to_edit_additional_discount": 1}
		enforce_discount_limits(invoice([row("ITEM-A", 1, 100)], discount_amount=20), "SI Main")
		with self.assertRaises(DiscountLimitError):
			enforce_discount_limits(invoice([row("ITEM-A", 1, 100)], discount_amount=21), "SI Main")

	def test_no_limit_when_max_discount_is_zero(self):
		self.settings = {**SETTINGS, "allow_user_to_edit_additional_discount": 1, "max_discount_allowed": 0}
		enforce_discount_limits(invoice([row("ITEM-A", 1, 10, 100)], discount_amount=5), "SI Main")


class TestCouponDiscount(LimitsTestCase):
	coupon = frappe._dict(
		coupon_code="MONEYCAP20",
		discount_type="Percentage",
		discount_percentage=50,
		discount_amount=0,
		min_amount=150,
		max_amount=20,
		apply_on="Net Total",
	)

	def _check(self, doc):
		with patch.object(sale_limits.frappe.db, "get_value", return_value=self.coupon):
			enforce_discount_limits(doc, "SI Main", "MONEYCAP20")

	def test_a_coupon_gives_no_more_than_its_maximum(self):
		self._check(invoice([row("ITEM-A", 2, 100)], discount_amount=20))
		with self.assertRaises(CouponDiscountError):
			self._check(invoice([row("ITEM-A", 2, 100)], discount_amount=100))

	def test_a_coupon_gives_nothing_below_its_minimum(self):
		with self.assertRaises(CouponDiscountError):
			self._check(invoice([row("ITEM-A", 1, 100)], discount_amount=20))

	def test_the_coupon_is_worked_out_without_the_discount_and_the_totals_come_back(self):
		doc = invoice([row("ITEM-A", 2, 100)], discount_amount=20)
		self._check(doc)
		self.assertEqual(doc.discount_amount, 20)
		self.assertEqual(doc.grand_total, 210)


class TestPayments(LimitsTestCase):
	def test_a_sale_paid_short_is_refused_without_partial_payment_or_credit(self):
		with self.assertRaises(UnderpaidError):
			enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Cash", 50, "Cash")]), "SI Main")

	def test_two_cents_short_is_short(self):
		doc = invoice([row("ITEM-A", 1, 100)], [("Cash", 114.98, "Cash")])
		with self.assertRaises(UnderpaidError):
			enforce_payment_limits(doc, "SI Main")

	def test_partial_payment_or_credit_sale_allows_it(self):
		for setting in ("allow_partial_payment", "allow_credit_sale"):
			self.settings = {**SETTINGS, setting: 1}
			enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Cash", 50, "Cash")]), "SI Main")

	def test_a_write_off_and_customer_credit_count_as_paid(self):
		doc = invoice([row("ITEM-A", 1, 100)], [("Cash", 114.5, "Cash")])
		enforce_payment_limits(doc, "SI Main", write_off_amount=0.5)
		enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Cash", 15, "Cash")]), "SI Main", redeemed_credit=100)

	def test_a_write_off_does_not_count_on_a_pos_invoice(self):
		doc = invoice([row("ITEM-A", 1, 100)], [("Cash", 114.5, "Cash")], doctype="POS Invoice")
		with self.assertRaises(UnderpaidError):
			enforce_payment_limits(doc, "SI Main", write_off_amount=0.5)

	def test_the_rounded_total_is_what_is_due(self):
		doc = invoice([row("ITEM-BL", 1, 10)], [("Cash", 11.5, "Cash")])
		doc.rounded_total = 12
		with self.assertRaises(UnderpaidError):
			enforce_payment_limits(doc, "SI Main")

	def test_a_card_overpayment_is_refused(self):
		with self.assertRaises(NonCashOverpaymentError):
			enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Credit Card", 120, "Bank")]), "SI Main")

	def test_change_out_of_cash_is_fine(self):
		enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Cash", 120, "Cash")]), "SI Main")
		enforce_payment_limits(
			invoice([row("ITEM-A", 1, 100)], [("Credit Card", 100, "Bank"), ("Cash", 20, "Cash")]), "SI Main"
		)
		enforce_payment_limits(invoice([row("ITEM-A", 1, 100)], [("Cash", 115, "Cash")]), "SI Main")

	def test_an_overpayment_larger_than_the_cash_is_refused(self):
		doc = invoice([row("ITEM-A", 1, 100)], [("Credit Card", 118, "Bank"), ("Cash", 2, "Cash")])
		with self.assertRaises(NonCashOverpaymentError):
			enforce_payment_limits(doc, "SI Main")

	def test_a_write_off_never_covers_more_than_is_unpaid(self):
		self.assertEqual(cap_write_off(invoice([row("ITEM-A", 1, 100)], [("Cash", 115, "Cash")]), 0.5), 0)
		self.assertEqual(cap_write_off(invoice([row("ITEM-A", 1, 100)], [("Cash", 114.6, "Cash")]), 0.5), 0.4)


class TestRefusalsGoToReview(unittest.TestCase):
	def test_each_refusal_needs_a_person_with_its_own_code(self):
		for error in (
			DiscountLimitError,
			AdditionalDiscountNotAllowedError,
			CouponDiscountError,
			UnderpaidError,
			NonCashOverpaymentError,
		):
			result = sync_classifier.classify(error("refused"))
			self.assertEqual(result.error_class, sync_classifier.BUSINESS)
			self.assertEqual(result.error_code, error.__name__)
			self.assertIsNone(sync_classifier.next_retry_minutes(result.error_class, 1))


class TestQueuedTotalCheck(unittest.TestCase):
	def _check(self, client_grand, result, payload):
		from pos_next.services.sync_inbox import _assert_totals_match

		row = frappe._dict(client_grand_total=client_grand, accept_total_difference=0)
		with patch("pos_next.services.sync_inbox.frappe.db.get_value", return_value=0.05):
			_assert_totals_match(row, result, "SI Main", payload)

	def test_compares_what_was_collected_when_rounding_is_on(self):
		self._check(11.5, {"grand_total": 11.5, "rounded_total": 12}, {"rounded_total": 12})

	def test_a_device_that_collected_the_grand_total_is_flagged_when_the_server_rounds(self):
		from pos_next.services.sync_classifier import TotalMismatchError

		with self.assertRaises(TotalMismatchError):
			self._check(11.5, {"grand_total": 11.5, "rounded_total": 12}, {})

	def test_without_rounding_the_grand_totals_are_compared(self):
		self._check(115, {"grand_total": 115, "rounded_total": 0}, {})
