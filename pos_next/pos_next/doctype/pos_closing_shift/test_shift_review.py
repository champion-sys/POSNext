# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Failing proofs from the shift review. Each test states the rule the code should keep."""

import json
import unittest
from unittest.mock import Mock, patch

import frappe

from pos_next.pos_next.doctype.pos_closing_shift import pos_closing_shift

MANAGER = "manager@example.com"
CASHIER = "sara@example.com"
ROLE = "Nexus POS Manager"


class TestOnlineCloseTakesTheServersTotals(unittest.TestCase):
    """The offline close works its totals out on the server. The online one must too."""

    def setUp(self):
        frappe.local.flags = frappe._dict()
        frappe.local.message_log = []
        server = {
            "doctype": "POS Closing Shift",
            "pos_opening_shift": "POS-1",
            "grand_total": 230,
            "pos_transactions": [{"sales_invoice": "SINV-1", "grand_total": 230}],
            "payment_reconciliation": [{"mode_of_payment": "Cash", "opening_amount": 30, "expected_amount": 260}],
        }
        patches = [
            patch.object(pos_closing_shift, "assert_shift_access"),
            patch.object(pos_closing_shift, "build_closing_shift", return_value=server),
            patch("frappe.get_doc", return_value=Mock(as_dict=Mock(return_value={"name": "POS-1"}))),
        ]
        for one in patches:
            one.start()
        self.saved = patch.object(pos_closing_shift, "save_closing_shift", return_value="CLOSE-1").start()
        self.addCleanup(patch.stopall)

    def test_a_sent_expected_amount_and_sales_list_are_not_stored(self):
        sent = {
            "doctype": "POS Closing Shift",
            "pos_opening_shift": "POS-1",
            "grand_total": 0,
            "pos_transactions": [],
            "payment_reconciliation": [
                {"mode_of_payment": "Cash", "opening_amount": 30, "expected_amount": 30, "closing_amount": 30}
            ],
        }

        pos_closing_shift.submit_closing_shift(json.dumps(sent))

        stored = self.saved.call_args.args[0]
        cash = stored["payment_reconciliation"][0]
        self.assertEqual(cash["expected_amount"], 260, "the drawer must expect what the shift sold")
        self.assertEqual(cash["closing_amount"], 30, "only the counted amount comes from the cashier")
        self.assertEqual([row["sales_invoice"] for row in stored["pos_transactions"]], ["SINV-1"])
        self.assertEqual(stored["grand_total"], 230)


class TestTheClosingRoleIsTheClosers(unittest.TestCase):
    """role_allowed_to_closing_shift says who may close. A manager closing a cashier's shift
    has the role, and the cashier who held the shift does not need it."""

    def setUp(self):
        frappe.local.flags = frappe._dict()
        frappe.local.message_log = []
        frappe.local.session = frappe._dict(user=MANAGER)
        self.addCleanup(setattr, frappe.local, "session", None)

        values = {"role_allowed_to_closing_shift": ROLE, "status": "Open", "pos_profile": "Main", "company": "Co"}

        def get_value(doctype, name, field, *args, **kwargs):
            if isinstance(field, list | tuple):
                return frappe._dict({one: values.get(one) for one in field})
            return values.get(field)

        roles = {MANAGER: [ROLE, "Desk User"], CASHIER: ["POSNext Cashier", "Desk User"]}
        patch("frappe.db", Mock(get_value=Mock(side_effect=get_value))).start()
        patch("frappe.get_all", return_value=[]).start()
        patch("frappe.get_roles", side_effect=lambda user=None: roles[user or MANAGER]).start()
        self.addCleanup(patch.stopall)

    def _closing(self):
        doc = Mock(spec=pos_closing_shift.POSClosingShift)
        doc.pos_profile = "Main"
        doc.pos_opening_shift = "POS-1"
        doc.user = CASHIER  # fetched from the shift: its holder
        doc.name = "new-closing"
        doc.closing_to_mode_of_payment = "Cash"
        doc.difference_mode_of_payment_account = "Write Off"
        return doc

    def test_a_manager_with_the_role_closes_a_cashiers_shift(self):
        pos_closing_shift.POSClosingShift.validate(self._closing())
