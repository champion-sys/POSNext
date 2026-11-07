# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

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
