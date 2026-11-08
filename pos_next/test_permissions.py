# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Who reaches a shift through the standard API, and who may undo a closing.

These run on stand-ins for the database. scripts/review_shift has the same attacks over
real HTTP, for a real site.
"""

import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next import permissions
from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import POSClosingShift

CASHIER = "sara@example.com"
MANAGER = "manager@example.com"
ROLES = {
    CASHIER: ["POSNext Cashier", "Desk User"],
    MANAGER: ["Nexus POS Manager", "Desk User"],
    "admin@example.com": ["System Manager"],
    "Administrator": [],
}


class Base(unittest.TestCase):
    def setUp(self):
        frappe.local.session = frappe._dict(user=CASHIER)
        self.addCleanup(setattr, frappe.local, "session", None)
        for target, replacement in (
            ("frappe.get_roles", lambda user=None: ROLES[user or frappe.session.user]),
            ("frappe.get_all", lambda *_args, **_kwargs: ["SI Main"]),
            ("frappe.throw", self._raise),
        ):
            patcher = patch(target, side_effect=replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def _raise(message, exc=frappe.ValidationError, **_kwargs):
        raise exc(message)


class TestShiftPermission(Base):
    def test_a_cashier_reaches_the_shifts_of_their_profiles(self):
        self.assertTrue(permissions.has_shift_permission(frappe._dict(pos_profile="SI Main"), "read", CASHIER))

    def test_a_cashier_does_not_reach_another_profiles_shift(self):
        self.assertFalse(permissions.has_shift_permission(frappe._dict(pos_profile="PI Main"), "read", CASHIER))

    def test_the_answer_is_a_boolean_frappe_reads_as_a_refusal(self):
        """Frappe takes any falsy answer, None too, as a refusal."""
        self.assertIs(permissions.has_shift_permission(frappe._dict(pos_profile=None), "read", CASHIER), False)

    def test_managers_reach_every_shift(self):
        for user in (MANAGER, "admin@example.com", "Administrator"):
            self.assertTrue(permissions.has_shift_permission(frappe._dict(pos_profile="PI Main"), "cancel", user), user)

    def test_lists_of_a_cashier_keep_to_their_profiles(self):
        with patch("frappe.db", Mock(escape=lambda value: f"'{value}'")):
            condition = permissions.get_shift_query_conditions(CASHIER, doctype="POS Closing Shift")

        self.assertIn("`tabPOS Closing Shift`.`pos_profile` in", condition)
        self.assertIn("`tabPOS Profile User`", condition)
        self.assertIn(f"'{CASHIER}'", condition)

    def test_lists_of_a_manager_are_not_narrowed(self):
        self.assertEqual(permissions.get_shift_query_conditions(MANAGER, doctype="POS Opening Shift"), "")

    def test_the_hooks_are_registered_for_both_shift_doctypes(self):
        from pos_next import hooks

        for doctype in permissions.SHIFT_DOCTYPES:
            self.assertEqual(hooks.has_permission[doctype], "pos_next.permissions.has_shift_permission")
            self.assertEqual(
                hooks.permission_query_conditions[doctype], "pos_next.permissions.get_shift_query_conditions"
            )


class TestCancelClosing(Base):
    """Cancelling a closing reopens the shift and undoes the books as the books user."""

    def _cancel(self, user):
        frappe.local.session.user = user
        closing = Mock(spec=POSClosingShift, pos_opening_shift="POSA-OS-1", pos_transactions=[])
        closing.pos_closing_entry = None
        self.books = patch("pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift.session_of").start()
        self.addCleanup(patch.stopall)
        with patch("frappe.db", Mock(exists=Mock(return_value=False))) as self.db:
            POSClosingShift.on_cancel(closing)

    def test_a_cashier_is_refused_before_anything_runs_as_the_books_user(self):
        with self.assertRaises(frappe.PermissionError):
            self._cancel(CASHIER)

        self.books.assert_not_called()
        self.db.exists.assert_not_called()

    def test_a_manager_may_cancel(self):
        self._cancel(MANAGER)
        self.books.assert_called_once()


if __name__ == "__main__":
    unittest.main()
