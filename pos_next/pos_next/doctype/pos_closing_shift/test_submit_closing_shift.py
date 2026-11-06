# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next.pos_next.doctype.pos_closing_shift import pos_closing_shift


def closing(**values):
    return json.dumps({"doctype": "POS Closing Shift", "pos_opening_shift": "POS-1", **values})


class TestSubmitClosingShift(unittest.TestCase):
    def setUp(self):
        frappe.local.flags = frappe._dict()
        frappe.local.message_log = []
        frappe.local.session = frappe._dict(user="cashier@example.com")
        self.addCleanup(setattr, frappe.local, "session", None)

        self.db = Mock(exists=Mock(return_value=True), get_value=Mock(return_value=None))
        self.document = Mock(pos_profile="Main")
        self.document.name = "CLOSE-1"
        for target, replacement in (
            ("frappe.db", self.db),
            ("frappe.get_doc", Mock(return_value=self.document)),
            ("frappe.get_roles", Mock(return_value=["POSNext Cashier"])),
            ("frappe.has_permission", Mock(return_value=False)),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_any_other_doctype_is_refused_before_it_is_built(self):
        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(json.dumps({"doctype": "Journal Entry"}))

        frappe.get_doc.assert_not_called()

    def test_a_request_with_no_doctype_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(json.dumps({"pos_opening_shift": "POS-1"}))

        frappe.get_doc.assert_not_called()

    def test_a_missing_shift_is_refused(self):
        self.db.exists.return_value = False

        with self.assertRaises(frappe.ValidationError):
            pos_closing_shift.submit_closing_shift(closing())

        self.document.save.assert_not_called()

    def test_a_user_of_another_profile_is_refused(self):
        self.db.exists.side_effect = lambda doctype, _filters: doctype != "POS Profile User"

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(closing())

        self.document.save.assert_not_called()

    def test_a_user_without_the_closing_role_is_refused(self):
        self.db.get_value.return_value = "POS Manager"

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(closing())

        self.document.save.assert_not_called()

    def test_a_cashier_of_the_profile_closes_the_shift(self):
        self.assertEqual(pos_closing_shift.submit_closing_shift(closing()), "CLOSE-1")

        self.document.save.assert_called_once()
        self.document.submit.assert_called_once()
