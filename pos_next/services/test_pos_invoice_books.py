# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""A POS Invoice shift through to the books, on real ERPNext documents.

Unlike the tests beside it, nothing here is replaced: a POS Invoice writes no ledgers until
its shift closes, and everything that can go wrong sits in ERPNext between the two.
"""

import json

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt

from pos_next.api.shifts import insert_opening_shift
from pos_next.install import CASHIER_ROLE, allow_cashier_to_select_accounts
from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import build_closing_shift, save_closing_shift
from pos_next.services.invoice_processor import process_invoice

PROFILE = "Books Test"
ITEM = "BOOKS-TEST-ITEM"
LINA = "books-lina@example.com"
SARA = "books-sara@example.com"
RATE = 100
VALUATION = 60


def _cashier(email):
    if not frappe.db.exists("User", email):
        user = frappe.get_doc(
            {"doctype": "User", "email": email, "first_name": email.split("@")[0], "send_welcome_email": 0}
        )
        user.flags.ignore_password_policy = True
        user.insert(ignore_permissions=True)
        user.add_roles(CASHIER_ROLE)


class TestPOSInvoiceBooks(IntegrationTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not frappe.get_all("Company", limit=1):
            from erpnext.setup.utils import before_tests

            before_tests()

        frappe.set_user("Administrator")
        cls.company = frappe.get_all("Company", pluck="name", limit=1)[0]
        cls.warehouse = frappe.get_all("Warehouse", {"company": cls.company, "is_group": 0}, pluck="name", limit=1)[0]
        cls.customer = cls._customer()
        cls.cash = cls._cash_mode()
        _cashier(LINA)
        _cashier(SARA)
        allow_cashier_to_select_accounts()
        cls._item()
        cls._profile()

    @classmethod
    def _customer(cls):
        if not frappe.db.exists("Customer", "Books Customer"):
            frappe.get_doc(
                {"doctype": "Customer", "customer_name": "Books Customer", "customer_type": "Individual"}
            ).insert(ignore_permissions=True)
        return "Books Customer"

    @classmethod
    def _cash_mode(cls):
        if not frappe.db.exists("Mode of Payment", "Books Cash"):
            frappe.get_doc(
                {"doctype": "Mode of Payment", "mode_of_payment": "Books Cash", "type": "Cash"}
            ).insert(ignore_permissions=True)

        mode = frappe.get_doc("Mode of Payment", "Books Cash")
        if not [row for row in mode.accounts if row.company == cls.company]:
            account = frappe.get_cached_value("Company", cls.company, "default_cash_account") or frappe.get_all(
                "Account", {"company": cls.company, "account_type": "Cash", "is_group": 0}, pluck="name"
            )[0]
            mode.append("accounts", {"company": cls.company, "default_account": account})
            mode.save(ignore_permissions=True)
        return mode.name

    @classmethod
    def _item(cls):
        from erpnext.stock.doctype.stock_entry.stock_entry_utils import make_stock_entry

        if not frappe.db.exists("Item", ITEM):
            frappe.get_doc(
                {
                    "doctype": "Item",
                    "item_code": ITEM,
                    "item_name": ITEM,
                    "item_group": frappe.get_all("Item Group", {"is_group": 0}, pluck="name", limit=1)[0],
                    "stock_uom": frappe.get_all("UOM", pluck="name", limit=1)[0],
                    "is_stock_item": 1,
                }
            ).insert(ignore_permissions=True)
        make_stock_entry(
            item_code=ITEM, qty=50, to_warehouse=cls.warehouse, rate=VALUATION, company=cls.company
        )

    @classmethod
    def _profile(cls):
        if frappe.db.exists("POS Profile", PROFILE):
            return

        cost_center = frappe.get_cached_value("Company", cls.company, "cost_center")
        profile = frappe.get_doc(
            {
                "doctype": "POS Profile",
                "__newname": PROFILE,
                "company": cls.company,
                "warehouse": cls.warehouse,
                "selling_price_list": frappe.get_all("Price List", {"selling": 1}, pluck="name", limit=1)[0],
                "currency": frappe.get_cached_value("Company", cls.company, "default_currency"),
                "write_off_account": frappe.get_all(
                    "Account", {"company": cls.company, "is_group": 0, "root_type": "Expense"}, pluck="name", limit=1
                )[0],
                "write_off_cost_center": cost_center,
                "cost_center": cost_center,
                "payments": [{"mode_of_payment": cls.cash, "default": 1}],
                "applicable_for_users": [{"user": LINA}, {"user": SARA}],
            }
        )
        profile.insert(ignore_permissions=True)

        settings = frappe.new_doc("POS Settings")
        settings.pos_profile = PROFILE
        settings.enabled = 1
        settings.invoice_type = "POS Invoice"
        settings.insert(ignore_permissions=True)

    def setUp(self):
        frappe.db.savepoint("books_test")

    def tearDown(self):
        frappe.set_user("Administrator")
        frappe.db.rollback(save_point="books_test")

    def _open_shift(self):
        frappe.set_user(LINA)
        return insert_opening_shift(
            PROFILE, self.company, [{"mode_of_payment": self.cash, "opening_amount": 10}]
        ).name

    def _sell(self, user, shift, qty=1):
        frappe.set_user(user)
        total = qty * RATE
        invoice = {
            "doctype": "POS Invoice",
            "pos_profile": PROFILE,
            "posa_pos_opening_shift": shift,
            "company": self.company,
            "customer": self.customer,
            "is_pos": 1,
            "update_stock": 1,
            "items": [{"item_code": ITEM, "qty": qty, "rate": RATE, "warehouse": self.warehouse}],
            "payments": [{"mode_of_payment": self.cash, "amount": total}],
        }
        return process_invoice(invoice, {}, "POS Invoice", PROFILE)["name"]

    def _close(self, shift, user=LINA):
        frappe.set_user(user)
        opening = frappe.get_doc("POS Opening Shift", shift)
        closing = json.loads(json.dumps(build_closing_shift(json.dumps(opening.as_dict(), default=str)), default=str))
        for row in closing["payment_reconciliation"]:
            row["closing_amount"] = row["expected_amount"]
        return save_closing_shift(closing)

    def _entry_of(self, closing):
        return frappe.db.get_value("POS Closing Shift", closing, "pos_closing_entry")

    def test_a_cashier_with_only_the_pos_role_sells_and_closes(self):
        shift = self._open_shift()
        invoice = self._sell(LINA, shift, 2)

        self.assertFalse(frappe.get_all("GL Entry", {"voucher_no": invoice}))

        closing = self._close(shift)

        self.assertEqual(frappe.db.get_value("POS Closing Entry", self._entry_of(closing), "status"), "Submitted")
        merged = frappe.db.get_value("POS Invoice", invoice, "consolidated_invoice")
        self.assertTrue(merged)
        self.assertEqual(frappe.db.get_value("Sales Invoice", merged, "docstatus"), 1)

        moved = frappe.get_all(
            "Stock Ledger Entry", {"voucher_no": merged, "is_cancelled": 0}, ["actual_qty", "stock_value_difference"]
        )
        self.assertEqual(sum(row.actual_qty for row in moved), -2)
        self.assertEqual(flt(sum(row.stock_value_difference for row in moved)), -2 * VALUATION)

    def test_the_closing_entry_carries_the_shifts_figures(self):
        shift = self._open_shift()
        self._sell(LINA, shift, 3)
        closing = frappe.get_doc("POS Closing Shift", self._close(shift))

        entry = frappe.get_doc("POS Closing Entry", closing.pos_closing_entry)

        self.assertEqual(entry.grand_total, 3 * RATE)
        self.assertEqual(entry.net_total, 3 * RATE)
        self.assertEqual(entry.total_quantity, 3)
        self.assertEqual(entry.period_end_date, closing.period_end_date)
        self.assertGreater(entry.period_end_date, entry.period_start_date)

    def test_a_colleagues_sale_does_not_stop_the_shift_from_closing(self):
        shift = self._open_shift()
        hers = self._sell(SARA, shift)
        self._sell(LINA, shift)

        closing = self._close(shift)

        self.assertEqual(frappe.db.get_value("POS Closing Entry", self._entry_of(closing), "status"), "Submitted")
        self.assertTrue(frappe.db.get_value("POS Invoice", hers, "consolidated_invoice"))
        self.assertEqual(frappe.db.get_value("POS Invoice", hers, "owner"), SARA)

    def test_a_closing_made_by_hand_keeps_erpnexts_rule_on_owners(self):
        shift = self._open_shift()
        invoice = self._sell(SARA, shift)

        frappe.set_user("Administrator")
        entry = frappe.new_doc("POS Closing Entry")
        entry.pos_profile, entry.user, entry.company = PROFILE, LINA, self.company
        entry.append("pos_invoices", {"pos_invoice": invoice})

        with self.assertRaises(frappe.ValidationError):
            entry.validate_pos_invoices()
