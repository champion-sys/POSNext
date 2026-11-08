# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import frappe

from pos_next import install
from pos_next.api.sales_invoice_hooks import free_offline_id_on_amend


class TestCashierPermissions(unittest.TestCase):
    def run_with(self, existing):
        with (
            patch("pos_next.install.frappe.db", Mock(exists=Mock(return_value=existing))),
            patch("pos_next.install.frappe.clear_cache"),
            patch("frappe.permissions.add_permission") as add,
            patch("frappe.permissions.update_permission_property") as self.update,
            patch("pos_next.install.ensure_manager_closing_rights"),
            patch("pos_next.install.revoke_cashier_rights") as self.revoke,
        ):
            install.ensure_cashier_permissions()
        return add

    def test_the_role_gets_what_selling_needs(self):
        add = self.run_with(existing=False)

        add.assert_any_call("Account", install.CASHIER_ROLE, ptype="select")
        add.assert_any_call("Address", install.CASHIER_ROLE, ptype="read")

    def test_the_screens_can_list_what_they_show(self):
        add = self.run_with(existing=False)

        add.assert_any_call("Customer Group", install.CASHIER_ROLE, ptype="read")
        add.assert_any_call("Sales Person", install.CASHIER_ROLE, ptype="read")

    def test_only_select_turns_read_off(self):
        self.run_with(existing=False)

        self.update.assert_called_once_with("Account", install.CASHIER_ROLE, 0, "read", 0)

    def test_running_again_changes_nothing(self):
        self.run_with(existing=True).assert_not_called()

    def test_what_a_cashier_must_not_do_is_taken_back_on_every_run(self):
        self.run_with(existing=True)
        self.revoke.assert_called_once_with()


APP = Path(install.__file__).resolve().parent


class TestCashierCannotCancel(unittest.TestCase):
    """Through frappe.client a cashier could cancel any closing, which undoes the books as the
    books user, and any sale. The POS saves shifts without the cashier's permissions."""

    def _rights(self, rows, doctype):
        row = next(row for row in rows if row.get("role") == install.CASHIER_ROLE and row.get("parent", doctype) == doctype)
        return {right for right in ("read", "write", "create", "submit", "cancel", "amend") if row.get(right)}

    def test_the_shift_doctypes_give_a_cashier_reading_only(self):
        for name in ("pos_opening_shift", "pos_closing_shift"):
            doctype = json.loads((APP / "pos_next" / "doctype" / name / f"{name}.json").read_text())
            self.assertEqual(self._rights(doctype["permissions"], doctype["name"]), {"read"}, name)

    def test_the_fixtures_give_no_cancel(self):
        rows = json.loads((APP / "fixtures" / "custom_docperm.json").read_text())

        self.assertEqual(self._rights(rows, "POS Closing Entry"), {"read"})
        self.assertEqual(self._rights(rows, "Sales Invoice"), {"read", "write", "create", "submit"})

    def test_every_revoked_right_is_gone_from_the_files(self):
        rows = json.loads((APP / "fixtures" / "custom_docperm.json").read_text())
        for doctype in ("POS Closing Entry", "Sales Invoice"):
            self.assertFalse(set(install.CASHIER_REVOKED_RIGHTS[doctype]) & self._rights(rows, doctype), doctype)

    def test_a_site_rule_that_still_gives_them_loses_them(self):
        rows = {
            "POS Opening Shift": [frappe._dict(name="p1", write=1, create=1, submit=1, cancel=1, amend=0)],
            "Sales Invoice": [frappe._dict(name="p2", cancel=1, amend=1)],
            "POS Closing Entry": [frappe._dict(name="p3", write=0, create=0, submit=0, cancel=0, amend=0)],
        }
        db = Mock()
        with (
            patch("pos_next.install.frappe.get_all", side_effect=lambda _dt, filters, fields: rows.get(filters["parent"], [])),
            patch("pos_next.install.frappe.db", db),
            patch("pos_next.install.frappe.clear_cache") as clear_cache,
        ):
            install.revoke_cashier_rights()

        db.set_value.assert_any_call("Custom DocPerm", "p1", {"write": 0, "create": 0, "submit": 0, "cancel": 0})
        db.set_value.assert_any_call("Custom DocPerm", "p2", {"cancel": 0, "amend": 0})
        self.assertEqual(db.set_value.call_count, 2)
        self.assertEqual({call.kwargs["doctype"] for call in clear_cache.call_args_list}, {"POS Opening Shift", "Sales Invoice"})


class TestManagerClosingRights(unittest.TestCase):
    def run_with(self, existing):
        with (
            patch("pos_next.install.frappe.db", Mock(exists=Mock(return_value=existing))),
            patch("pos_next.install.frappe.clear_cache"),
            patch("frappe.permissions.add_permission") as add,
            patch("frappe.permissions.update_permission_property") as update,
        ):
            install.ensure_manager_closing_rights()
        return add, update

    def test_the_role_alerted_about_a_failed_closing_can_act_on_it(self):
        add, update = self.run_with(existing=False)

        add.assert_called_once_with("POS Closing Entry", install.MANAGER_ROLE)
        update.assert_any_call("POS Closing Entry", install.MANAGER_ROLE, 0, "write", 1)
        update.assert_any_call("POS Closing Entry", install.MANAGER_ROLE, 0, "cancel", 1)

    def test_running_again_changes_nothing(self):
        add, _update = self.run_with(existing=True)

        add.assert_not_called()


class TestAmendedInvoice(unittest.TestCase):
    def test_an_amendment_leaves_the_id_with_the_original(self):
        doc = SimpleNamespace(amended_from="SINV-1", offline_id="pos_offline_1")

        free_offline_id_on_amend(doc)

        self.assertIsNone(doc.offline_id)

    def test_a_new_invoice_keeps_its_id(self):
        doc = SimpleNamespace(amended_from=None, offline_id="pos_offline_1")

        free_offline_id_on_amend(doc)

        self.assertEqual(doc.offline_id, "pos_offline_1")
