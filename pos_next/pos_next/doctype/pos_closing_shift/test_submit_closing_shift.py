# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next.api import shifts
from pos_next.pos_next.doctype.pos_closing_shift import pos_closing_shift


def closing(**values):
    return json.dumps({"doctype": "POS Closing Shift", "pos_opening_shift": "POS-1", **values})


class TestAFailedMerge(unittest.TestCase):
    def setUp(self):
        frappe.local.message_log = []

    def _entry_failing_with(self, cause):
        def submit():
            try:
                raise cause
            except type(cause):
                raise frappe.LinkValidationError("Could not find Reference Name: POS-CLO-1") from None

        return Mock(submit=submit)

    def test_the_cashier_hears_why_it_failed(self):
        cause = frappe.ValidationError("2 units of ITEM needed")

        with self.assertRaises(frappe.ValidationError) as caught:
            pos_closing_shift.submit_keeping_the_cause(self._entry_failing_with(cause))

        self.assertIs(caught.exception, cause)

    def test_a_real_link_error_stays_what_it_is(self):
        error = frappe.LinkValidationError("Could not find Customer: X")

        with self.assertRaises(frappe.LinkValidationError) as caught:
            pos_closing_shift.submit_keeping_the_cause(Mock(submit=Mock(side_effect=error)))

        self.assertIs(caught.exception, error)


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


class TestShiftReads(unittest.TestCase):
    """These run raw queries, so the rule of submit_closing_shift is all that guards them."""

    def setUp(self):
        frappe.local.flags = frappe._dict()
        frappe.local.message_log = []
        frappe.local.session = Mock(user="lina@example.com")
        self.addCleanup(setattr, frappe.local, "session", None)
        self.db = Mock(exists=Mock(return_value=True), sql=Mock(return_value=[]))

        patches = {
            "write_access": patch("pos_next.api.invoices._assert_invoice_write_access"),
            "may_close": patch("pos_next.api.shifts.assert_may_close_shift"),
            "db": patch("frappe.db", self.db),
            "get_doc": patch("frappe.get_doc", return_value=Mock(pos_profile="Main")),
            "get_all": patch("frappe.get_all", return_value=[]),
            "translate": patch.object(pos_closing_shift, "_", lambda text: text),
        }
        self.mocks = {name: patcher.start() for name, patcher in patches.items()}
        self.addCleanup(patch.stopall)

    def _refuse(self):
        self.mocks["write_access"].side_effect = frappe.PermissionError

    def _opening(self, **values):
        return json.dumps({"name": "POS-1", "balance_details": [], **values})

    def test_invoices_of_a_shift_outside_the_users_profiles_stay_hidden(self):
        self._refuse()

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.get_pos_invoices("POS-1")

        self.db.sql.assert_not_called()

    def test_reading_invoices_is_not_a_way_to_submit_them(self):
        self._refuse()

        with patch.object(pos_closing_shift, "submit_printed_invoices") as submit:
            with self.assertRaises(frappe.PermissionError):
                pos_closing_shift.get_pos_invoices("POS-1", "Sales Invoice")

        submit.assert_not_called()

    def test_the_role_for_closing_counts_too(self):
        self.mocks["may_close"].side_effect = frappe.PermissionError

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.get_pos_invoices("POS-1")

    def test_a_doctype_cannot_reach_the_query(self):
        with patch("frappe.throw", side_effect=frappe.PermissionError):
            with self.assertRaises(frappe.PermissionError):
                pos_closing_shift.get_pos_invoices("POS-1", "Sales Invoice` union select 1 -- ")

        self.db.sql.assert_not_called()

    def test_invoices_are_read_with_access(self):
        self.db.get_value.return_value = None
        self.assertEqual(pos_closing_shift.get_pos_invoices("POS-1", "POS Invoice"), [])
        self.db.sql.assert_called_once()

    def test_payments_of_a_shift_outside_the_users_profiles_stay_hidden(self):
        self._refuse()

        with self.assertRaises(frappe.PermissionError):
            pos_closing_shift.get_payments_entries("POS-1")

        self.mocks["get_all"].assert_not_called()

    def test_payments_are_read_with_access(self):
        self.assertEqual(pos_closing_shift.get_payments_entries("POS-1"), [])

    def test_a_closing_is_refused_on_the_servers_profile_not_the_requests(self):
        self._refuse()

        with patch.object(pos_closing_shift, "build_closing_shift") as build:
            with self.assertRaises(frappe.PermissionError):
                pos_closing_shift.make_closing_shift_from_opening(self._opening(pos_profile="Mine"))

        build.assert_not_called()
        self.mocks["write_access"].assert_called_once_with("Sales Invoice", "Main")

    def test_a_closing_is_built_with_access(self):
        with patch.object(pos_closing_shift, "build_closing_shift", return_value={"name": "C"}) as build:
            self.assertEqual(pos_closing_shift.make_closing_shift_from_opening(self._opening()), {"name": "C"})
        build.assert_called_once()

    def test_a_caller_who_has_authorized_is_not_checked_again(self):
        self.db.get_value.return_value = None
        with (
            patch.object(pos_closing_shift, "assert_shift_access") as check,
            patch.object(pos_closing_shift, "_read_shift_invoices", return_value=[]) as invoices,
            patch.object(pos_closing_shift, "_read_shift_payments", return_value=[]) as payments,
            patch.object(pos_closing_shift, "submit_printed_invoices"),
            patch.object(pos_closing_shift, "_get_cash_mode_of_payment", return_value="Cash"),
            patch("frappe.new_doc"),
            patch("frappe.get_cached_value", return_value="SAR"),
            patch("frappe.utils.get_datetime"),
        ):
            pos_closing_shift.build_closing_shift(self._opening())

        check.assert_not_called()
        invoices.assert_called_once()
        payments.assert_called_once()

    def test_closing_data_needs_access_to_the_profile_as_well_as_the_role(self):
        self._refuse()

        with self.assertRaises(frappe.PermissionError):
            shifts.get_closing_shift_data("POS-1")

    def _open_shift_of(self, user):
        self.mocks["get_doc"].return_value = Mock(company="Co", pos_profile="Main")
        self.db.get_all = Mock(return_value=[frappe._dict(name="POS-1", pos_profile="Main")])
        with (
            patch("pos_next.api.shifts.has_pending_close", return_value=False),
            patch("pos_next.api.shifts.get_datetime"),
        ):
            return shifts.check_opening_shift(user)

    def test_someone_elses_open_shift_stays_hidden(self):
        self._refuse()

        with self.assertRaises(frappe.PermissionError):
            self._open_shift_of("sara@example.com")

    def test_a_colleague_on_the_profile_may_ask(self):
        self.assertIsNotNone(self._open_shift_of("sara@example.com"))
        self.mocks["write_access"].assert_called_once_with("Sales Invoice", "Main")

    def test_a_cashier_may_always_ask_about_their_own(self):
        self._refuse()

        self.assertIsNotNone(self._open_shift_of(None))
        self.assertIsNotNone(self._open_shift_of("lina@example.com"))
        self.mocks["write_access"].assert_not_called()
