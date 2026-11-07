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
        ):
            install.ensure_cashier_permissions()
        return add

    def test_the_role_gets_what_selling_needs(self):
        add = self.run_with(existing=False)

        add.assert_any_call("Account", install.CASHIER_ROLE, ptype="select")
        add.assert_any_call("Address", install.CASHIER_ROLE, ptype="read")

    def test_running_again_changes_nothing(self):
        self.run_with(existing=True).assert_not_called()


class TestAmendedInvoice(unittest.TestCase):
    def test_an_amendment_leaves_the_id_with_the_original(self):
        doc = SimpleNamespace(amended_from="SINV-1", offline_id="pos_offline_1")

        free_offline_id_on_amend(doc)

        self.assertIsNone(doc.offline_id)

    def test_a_new_invoice_keeps_its_id(self):
        doc = SimpleNamespace(amended_from=None, offline_id="pos_offline_1")

        free_offline_id_on_amend(doc)

        self.assertEqual(doc.offline_id, "pos_offline_1")
