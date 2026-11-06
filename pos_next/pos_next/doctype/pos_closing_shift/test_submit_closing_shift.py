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
        self.write_access = patch("pos_next.api.invoices._assert_invoice_write_access")
        self.may_close = patch("pos_next.api.shifts.assert_may_close_shift")
        self.exists = patch("frappe.db", Mock(exists=Mock(return_value=True)))
        self.opening = patch("frappe.get_doc", return_value=Mock(pos_profile="Main"))
        self.save = patch.object(pos_closing_shift, "save_closing_shift", return_value="CLOSE-1")

        self.assert_write_access = self.write_access.start()
        self.assert_may_close = self.may_close.start()
        self.exists.start()
        self.get_doc = self.opening.start()
        self.saved = self.save.start()
        self.addCleanup(patch.stopall)

    def test_any_other_doctype_is_refused_before_it_is_built(self):
        request = json.dumps({"doctype": "Journal Entry", "pos_opening_shift": "POS-1"})

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(request)

        self.get_doc.assert_not_called()
        self.saved.assert_not_called()

    def test_a_request_with_no_doctype_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(json.dumps({"pos_opening_shift": "POS-1"}))

        self.saved.assert_not_called()

    def test_a_user_without_access_to_the_profile_is_refused(self):
        self.assert_write_access.side_effect = frappe.PermissionError

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(closing())

        self.assert_write_access.assert_called_once_with("Sales Invoice", "Main")
        self.saved.assert_not_called()

    def test_a_user_without_the_closing_role_is_refused(self):
        self.assert_may_close.side_effect = frappe.PermissionError

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.submit_closing_shift(closing())

        self.saved.assert_not_called()

    def test_a_missing_shift_is_refused(self):
        with patch("frappe.db", Mock(exists=Mock(return_value=False))):
            with self.assertRaises(frappe.ValidationError):
                pos_closing_shift.submit_closing_shift(closing())

        self.saved.assert_not_called()

    def test_an_allowed_close_goes_through(self):
        self.assertEqual(pos_closing_shift.submit_closing_shift(closing()), "CLOSE-1")
        self.saved.assert_called_once()
