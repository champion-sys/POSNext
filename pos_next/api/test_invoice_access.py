# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next.api.invoices import _apply_write_off, _assert_invoice_write_access


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class NoSiteTestCase(unittest.TestCase):
    """Replace the helpers that need a site, so these run without a database."""

    def setUp(self):
        for target, replacement in (
            ("pos_next.api.invoices.frappe.throw", _raise),
            ("pos_next.api.invoices._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        frappe.local.session = Mock(user="cashier@example.com")
        frappe.local.db = Mock()
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)


class TestInvoiceWriteAccess(NoSiteTestCase):
    def test_rejects_doctype_outside_the_pos_flow(self):
        with self.assertRaises(frappe.PermissionError):
            _assert_invoice_write_access("Purchase Invoice", "Main")

    def test_rejects_missing_pos_profile(self):
        with self.assertRaises(frappe.PermissionError):
            _assert_invoice_write_access("Sales Invoice", None)

    @patch("pos_next.api.invoices.frappe.has_permission", return_value=False)
    def test_rejects_user_outside_the_profile(self, _mock_has_permission):
        frappe.local.db.exists.return_value = None
        with self.assertRaises(frappe.PermissionError):
            _assert_invoice_write_access("Sales Invoice", "Main")

    @patch("pos_next.api.invoices.frappe.has_permission", return_value=False)
    def test_allows_user_assigned_to_the_profile(self, _mock_has_permission):
        frappe.local.db.exists.return_value = "row-1"
        _assert_invoice_write_access("POS Invoice", "Main")

    @patch("pos_next.api.invoices.frappe.has_permission", return_value=True)
    def test_allows_profile_manager(self, _mock_has_permission):
        frappe.local.db.exists.return_value = None
        _assert_invoice_write_access("Sales Order", "Main")


class TestApplyWriteOff(NoSiteTestCase):
    @staticmethod
    def _profile(limit):
        return Mock(
            write_off_account="Write Off - T",
            write_off_cost_center="Main - T",
            write_off_limit=limit,
        )

    @patch("pos_next.api.invoices.frappe.get_cached_doc")
    def test_over_limit_fails_the_invoice(self, mock_get_cached_doc):
        mock_get_cached_doc.return_value = self._profile(10)
        with self.assertRaises(frappe.ValidationError):
            _apply_write_off(Mock(), 25, "Main")

    @patch("pos_next.api.invoices.frappe.get_cached_doc")
    def test_within_limit_sets_the_amount(self, mock_get_cached_doc):
        mock_get_cached_doc.return_value = self._profile(10)
        invoice = Mock()
        _apply_write_off(invoice, 5, "Main")
        self.assertEqual(invoice.write_off_amount, 5)
        self.assertEqual(invoice.base_write_off_amount, 5)


if __name__ == "__main__":
    unittest.main()
