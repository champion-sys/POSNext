# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next.api import invoices
from pos_next.api.invoices import (
    _apply_coupon,
    _apply_write_off,
    _assert_invoice_write_access,
    assert_shift_takes_sale,
)
from pos_next.services.invoice_processor import process_invoice
from pos_next.services.sync_classifier import ShiftClosedError, WrongShiftError


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


class TestDeviceProfiles(NoSiteTestCase):
    """A device keeps to its POS Profiles on every sale, shift and closing, not only in sync."""

    def setUp(self):
        super().setUp()
        frappe.local.db.exists.return_value = "row-1"
        for target, replacement in (("pos_next.auth._", lambda text: text),):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(setattr, frappe.local, "pos_device", None)

    def _with_device(self, allowed):
        frappe.local.pos_device = "device-1"
        return patch("pos_next.auth.frappe.get_all", return_value=allowed)

    def test_a_profile_the_device_is_not_enrolled_for_is_refused(self):
        with self._with_device(["SI Main"]), self.assertRaises(frappe.PermissionError):
            _assert_invoice_write_access("Sales Invoice", "PI Main")

    def test_a_profile_the_device_is_enrolled_for_passes(self):
        with self._with_device(["SI Main"]):
            _assert_invoice_write_access("Sales Invoice", "SI Main")

    def test_a_browser_has_no_device_to_hold_it_back(self):
        frappe.local.pos_device = None
        with patch("pos_next.auth.frappe.get_all") as get_all:
            _assert_invoice_write_access("Sales Invoice", "PI Main")
        get_all.assert_not_called()


class TestShiftTakesSale(NoSiteTestCase):
    """Every invoice path holds a sale to an open shift of its own POS Profile."""

    def setUp(self):
        super().setUp()
        self.shift = frappe._dict(status="Open", docstatus=1, pos_profile="Main", user="cashier@example.com")
        frappe.local.db.get_value.side_effect = lambda *_args, **_kwargs: self.shift
        patcher = patch("pos_next.services.sync_entities.has_pending_close", return_value=False)
        self.pending = patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_cashiers_own_open_shift_takes_the_sale(self):
        assert_shift_takes_sale("POSA-OS-1", "Main")

    def test_a_closed_shift_is_refused(self):
        self.shift.status = "Closed"
        with self.assertRaises(ShiftClosedError):
            assert_shift_takes_sale("POSA-OS-1", "Main")

    def test_a_cancelled_shift_is_refused(self):
        self.shift.update(status="Cancelled", docstatus=2)
        with self.assertRaises(ShiftClosedError):
            assert_shift_takes_sale("POSA-OS-1", "Main")

    def test_a_missing_shift_is_refused(self):
        self.shift = None
        with self.assertRaises(ShiftClosedError):
            assert_shift_takes_sale("POSA-OS-9", "Main")
        with self.assertRaises(ShiftClosedError):
            assert_shift_takes_sale(None, "Main")

    def test_a_shift_closed_on_a_device_is_refused(self):
        self.pending.return_value = True
        with self.assertRaises(ShiftClosedError):
            assert_shift_takes_sale("POSA-OS-1", "Main")

    def test_another_profiles_shift_is_refused(self):
        with self.assertRaises(WrongShiftError):
            assert_shift_takes_sale("POSA-OS-1", "Other")

    def test_online_a_colleagues_shift_is_refused(self):
        self.shift.user = "lina@example.com"
        with self.assertRaises(WrongShiftError):
            assert_shift_takes_sale("POSA-OS-1", "Main")

    def test_a_queued_colleagues_sale_goes_into_the_devices_shift(self):
        self.shift.user = "lina@example.com"
        assert_shift_takes_sale("POSA-OS-1", "Main", queued=True, offline_id="pos_offline_1")

    def test_a_queued_sale_is_not_refused_by_the_close_that_waits_for_it(self):
        assert_shift_takes_sale("POSA-OS-1", "Main", queued=True, offline_id="pos_offline_1")
        self.pending.assert_called_once_with("POSA-OS-1", "pos_offline_1")

    def test_online_every_close_in_the_way_counts(self):
        assert_shift_takes_sale("POSA-OS-1", "Main", offline_id="pos_offline_1")
        self.pending.assert_called_once_with("POSA-OS-1", None)

    def test_a_queued_sale_into_another_profiles_shift_is_still_refused(self):
        with self.assertRaises(WrongShiftError):
            assert_shift_takes_sale("POSA-OS-1", "Other", queued=True, offline_id="pos_offline_1")


class TestEveryOnlinePathChecksTheShift(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        for target in ("pos_next.api.invoices._assert_invoice_write_access", "pos_next.api.invoices.frappe.log_error"):
            patcher = patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.refuse = patch("pos_next.api.invoices.assert_shift_takes_sale", side_effect=ShiftClosedError("closed"))

    def test_update_invoice_refuses_a_draft_for_a_closed_shift(self):
        draft = Mock(posa_pos_opening_shift="POSA-OS-1")
        draft.get = lambda field, default=None: {"posa_pos_opening_shift": "POSA-OS-1", "pos_profile": "Main"}.get(field)
        with self.refuse as check, patch("pos_next.api.invoices.frappe.get_doc", return_value=draft):
            with self.assertRaises(ShiftClosedError):
                invoices.update_invoice({"doctype": "Sales Invoice", "pos_profile": "Main", "posa_pos_opening_shift": "POSA-OS-1"})

        check.assert_called_once_with("POSA-OS-1", "Main")
        draft.save.assert_not_called()

    def test_submitting_a_saved_draft_checks_its_shift(self):
        draft = Mock()
        draft.get = lambda field, default=None: {"posa_pos_opening_shift": "POSA-OS-1", "pos_profile": "Main"}.get(field)
        frappe.local.db.exists.return_value = True
        with (
            patch("pos_next.services.invoice_processor.assert_shift_takes_sale", side_effect=ShiftClosedError) as check,
            patch("pos_next.services.invoice_processor._assert_invoice_write_access"),
            patch("pos_next.services.invoice_processor.frappe.get_doc", return_value=draft),
        ):
            with self.assertRaises(ShiftClosedError):
                process_invoice({"name": "SINV-1"}, {}, "Sales Invoice", "Main")

        check.assert_called_once_with("POSA-OS-1", "Main")
        draft.submit.assert_not_called()

    def test_the_queue_checks_its_records_itself(self):
        draft = Mock()
        draft.get = lambda field, default=None: None
        frappe.local.db.exists.return_value = True
        with (
            patch("pos_next.services.invoice_processor.assert_shift_takes_sale") as check,
            patch("pos_next.services.invoice_processor._assert_invoice_write_access"),
            patch("pos_next.services.invoice_processor.frappe.get_doc", return_value=draft),
            patch("pos_next.services.invoice_processor._set_payment_accounts"),
            patch("pos_next.services.invoice_processor._auto_set_return_batches"),
            patch("pos_next.services.invoice_processor._validate_stock_on_invoice"),
            patch("pos_next.services.invoice_processor.enforce_discount_limits"),
            patch("pos_next.services.invoice_processor.enforce_payment_limits"),
            patch("pos_next.services.invoice_processor.cap_write_off", return_value=0),
        ):
            frappe.local.flags = frappe._dict()
            process_invoice({"name": "SINV-1"}, {}, "Sales Invoice", "Main", queued=True)

        check.assert_not_called()


class TestApplyCoupon(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        checker = patch(
            "pos_next.pos_next.doctype.pos_coupon.pos_coupon.check_coupon_code",
            return_value={"valid": True, "overrun": "limit"},
        )
        checker.start()
        self.addCleanup(checker.stop)

    def test_pos_coupon_stays_out_of_erpnexts_link_field(self):
        frappe.local.db.exists.return_value = None
        invoice = Mock(coupon_code="SAVE10")

        overrun = _apply_coupon(invoice, "SAVE10", queued=False)

        self.assertIsNone(invoice.coupon_code)
        self.assertEqual(invoice.pos_coupon_code, "SAVE10")
        self.assertIsNone(overrun)

    def test_erpnext_coupon_keeps_its_field_online(self):
        frappe.local.db.exists.return_value = "SAVE10"
        invoice = Mock(coupon_code=None)

        _apply_coupon(invoice, "SAVE10", queued=False)

        self.assertEqual(invoice.coupon_code, "SAVE10")

    def test_every_pos_sale_notes_the_coupon_it_will_count(self):
        frappe.local.db.exists.return_value = "SAVE10"
        invoice = Mock(coupon_code=None)

        _apply_coupon(invoice, "SAVE10", queued=False)

        self.assertEqual(invoice.pos_coupon_code, "SAVE10")

    def test_queued_sale_reports_an_overrun(self):
        frappe.local.db.exists.return_value = "SAVE10"
        invoice = Mock()

        overrun = _apply_coupon(invoice, "SAVE10", queued=True)

        self.assertIsNone(invoice.coupon_code)
        self.assertEqual(overrun, "limit")


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
