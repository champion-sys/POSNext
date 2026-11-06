# Copyright (c) 2021, Youssef Restom and Contributors
# See license.txt

import unittest
from datetime import date
from unittest.mock import Mock, patch

import frappe

from pos_next.pos_next.doctype.pos_coupon.pos_coupon import (
    _get_customer_coupon_usage_count,
    check_coupon_code,
    increment_coupon_usage,
)


class NoSiteTestCase(unittest.TestCase):
    def setUp(self):
        frappe.local.db = Mock()
        self.addCleanup(setattr, frappe.local, "db", None)


class TestPOSCoupon(NoSiteTestCase):
    @patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.frappe.get_meta")
    def test_one_use_coupon_counts_sales_invoice_and_pos_invoice(self, mock_get_meta):
        mock_db = frappe.local.db

        def table_exists(doctype):
            return doctype in {"Sales Invoice", "POS Invoice"}

        def count(doctype, filters=None):
            counts = {"Sales Invoice": 1, "POS Invoice": 2}
            return counts[doctype]

        mock_db.table_exists.side_effect = table_exists
        mock_db.count.side_effect = count
        mock_get_meta.return_value = Mock(has_field=lambda fieldname: fieldname == "coupon_code")

        used_count = _get_customer_coupon_usage_count("Customer A", "SAVE10")

        self.assertEqual(used_count, 3)
        mock_db.count.assert_any_call(
            "Sales Invoice",
            filters={"customer": "Customer A", "coupon_code": "SAVE10", "docstatus": 1},
        )
        mock_db.count.assert_any_call(
            "POS Invoice",
            filters={"customer": "Customer A", "coupon_code": "SAVE10", "docstatus": 1},
        )

    @patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.frappe.get_meta")
    def test_one_use_coupon_skips_doctypes_without_coupon_field(self, mock_get_meta):
        mock_db = frappe.local.db
        mock_db.table_exists.return_value = True
        mock_db.count.return_value = 4
        mock_get_meta.side_effect = [
            Mock(has_field=lambda fieldname: fieldname == "coupon_code"),
            Mock(has_field=Mock(return_value=False)),
        ]

        used_count = _get_customer_coupon_usage_count("Customer A", "SAVE10")

        self.assertEqual(used_count, 4)
        mock_db.count.assert_called_once_with(
            "Sales Invoice",
            filters={"customer": "Customer A", "coupon_code": "SAVE10", "docstatus": 1},
        )

    @patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.frappe.get_meta")
    def test_one_use_coupon_counts_sales_from_the_queue(self, mock_get_meta):
        frappe.local.db.table_exists.side_effect = lambda doctype: doctype == "Sales Invoice"
        frappe.local.db.count.side_effect = lambda _doctype, filters: 1 if "pos_coupon_code" in filters else 0
        mock_get_meta.return_value = Mock(has_field=Mock(return_value=True))

        self.assertEqual(_get_customer_coupon_usage_count("Customer A", "SAVE10"), 1)


def _coupon(**values):
    coupon = {
        "coupon_code": "SAVE10",
        "coupon_type": "Promotional",
        "disabled": 0,
        "company": "ACME",
        "customer": None,
        "valid_from": None,
        "valid_upto": None,
        "used": 0,
        "maximum_use": 0,
        "one_use": 0,
    }
    return frappe._dict({**coupon, **values})


class TestCheckCouponCode(NoSiteTestCase):
    def _check(self, coupon, used_by_customer=0, **kwargs):
        frappe.local.db.exists.return_value = True
        with (
            patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.frappe.get_doc", return_value=coupon),
            patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon._", lambda text: text),
            patch(
                "pos_next.pos_next.doctype.pos_coupon.pos_coupon._get_customer_coupon_usage_count",
                return_value=used_by_customer,
            ),
            patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.today", return_value="2026-11-06"),
        ):
            return check_coupon_code("SAVE10", customer="Customer A", company="ACME", **kwargs)

    def test_the_online_check_still_refuses_a_used_up_coupon(self):
        result = self._check(_coupon(used=5, maximum_use=5))
        self.assertIsNone(result["coupon"])
        self.assertFalse(result.get("valid"))

    def test_the_online_check_still_refuses_a_second_use_by_a_customer(self):
        result = self._check(_coupon(one_use=1), used_by_customer=1)
        self.assertFalse(result.get("valid"))

    def test_a_queued_sale_over_the_limit_is_accepted_and_reported(self):
        result = self._check(_coupon(used=5, maximum_use=5), queued_on="2026-11-05")
        self.assertTrue(result["valid"])
        self.assertIn("5", result["overrun"])

    def test_a_queued_sale_within_the_limit_reports_nothing(self):
        result = self._check(_coupon(used=4, maximum_use=5), queued_on="2026-11-05")
        self.assertTrue(result["valid"])
        self.assertIsNone(result["overrun"])

    def test_a_queued_second_use_by_a_customer_is_accepted_and_reported(self):
        result = self._check(_coupon(one_use=1), used_by_customer=1, queued_on="2026-11-05")
        self.assertTrue(result["valid"])
        self.assertIn("Customer A", result["overrun"])

    def test_a_gift_card_is_never_spent_twice(self):
        card = _coupon(coupon_type="Gift Card", customer="Customer A", used=1, maximum_use=1)
        self.assertFalse(self._check(card, queued_on="2026-11-05").get("valid"))

    def test_a_queued_sale_is_judged_on_the_day_of_the_sale(self):
        coupon = _coupon(valid_upto=date(2026, 11, 5))
        self.assertTrue(self._check(coupon, queued_on="2026-11-05")["valid"])
        self.assertFalse(self._check(coupon).get("valid"))

    def test_a_disabled_coupon_is_not_an_overrun(self):
        self.assertFalse(self._check(_coupon(disabled=1), queued_on="2026-11-05").get("valid"))


class TestIncrementCouponUsage(NoSiteTestCase):
    def test_locks_the_row_and_counts_past_the_limit(self):
        frappe.local.db.get_value.return_value = "Save Ten"
        coupon = Mock(used=5)

        with patch("pos_next.pos_next.doctype.pos_coupon.pos_coupon.frappe.get_doc", return_value=coupon):
            increment_coupon_usage("save10")

        self.assertTrue(frappe.local.db.get_value.call_args.kwargs["for_update"])
        coupon.db_set.assert_called_once_with("used", 6)
