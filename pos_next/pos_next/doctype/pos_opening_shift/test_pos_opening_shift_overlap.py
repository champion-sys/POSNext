# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from datetime import datetime
from unittest.mock import Mock

import frappe

from pos_next.pos_next.doctype.pos_opening_shift.pos_opening_shift import POSOpeningShift


class TestOpeningEntryOverlap(unittest.TestCase):
    def setUp(self):
        frappe.local.db = Mock()
        frappe.local.db.get_value.return_value = None
        self.addCleanup(setattr, frappe.local, "db", None)

    @staticmethod
    def _blocked(entry_user, opened, shift_opened=datetime(2026, 11, 6, 9, 0)):
        shift = Mock(user="a@example.com", pos_profile="Main", period_start_date=shift_opened)
        entry = frappe._dict(user=entry_user, period_start_date=opened)
        return POSOpeningShift.is_blocked_by_opening_entry(shift, entry)

    def test_own_entry_does_not_block(self):
        self.assertFalse(self._blocked("a@example.com", datetime(2026, 11, 6, 8, 0)))

    def test_entry_abandoned_on_an_earlier_day_does_not_block(self):
        self.assertFalse(self._blocked("b@example.com", datetime(2026, 8, 23, 20, 23)))

    def test_another_cashier_working_today_blocks(self):
        self.assertTrue(self._blocked("b@example.com", datetime(2026, 11, 6, 8, 0)))

    def test_pos_invoice_mode_reuses_only_todays_own_entry(self):
        frappe.local.db.get_value.return_value = "POS Invoice"
        self.assertFalse(self._blocked("a@example.com", datetime(2026, 11, 6, 8, 0)))

    def test_pos_invoice_mode_refuses_an_outdated_entry(self):
        frappe.local.db.get_value.return_value = "POS Invoice"
        self.assertTrue(self._blocked("a@example.com", datetime(2026, 8, 23, 20, 23)))
        self.assertTrue(self._blocked("b@example.com", datetime(2026, 11, 6, 8, 0)))


if __name__ == "__main__":
    unittest.main()
