# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""A POS Invoice shift through to the books, on real ERPNext documents.

Unlike the tests beside it, nothing here is replaced: a POS Invoice writes no ledgers until
its shift closes, and everything that can go wrong sits in ERPNext between the two.
"""

import json
from unittest.mock import patch

import frappe
from erpnext.accounts.doctype.pos_closing_entry.pos_closing_entry import POSClosingEntry
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, flt, now_datetime

from pos_next.api.shifts import insert_opening_shift
from pos_next.install import CASHIER_ROLE, ensure_cashier_permissions
from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import (
    build_closing_shift,
    save_closing_shift,
)
from pos_next.services import closing_alerts
from pos_next.services.invoice_processor import process_invoice

PROFILE = "Books Test"
ITEM = "BOOKS-TEST-ITEM"
LINA = "books-lina@example.com"
SARA = "books-sara@example.com"
MANAGER = "books-manager@example.com"
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


def _set_up_site():
    """A site straight from new-site has no company, and ERPNext v16 has no before_tests."""
    from erpnext.setup.setup_wizard.setup_wizard import setup_complete

    year = now_datetime().year
    setup_complete(
        frappe._dict(
            country="United States",
            currency="USD",
            company_name="POS Test Company",
            company_abbr="PTC",
            chart_of_accounts="Standard",
            fy_start_date=f"{year}-01-01",
            fy_end_date=f"{year}-12-31",
        )
    )
    frappe.db.commit()


class TestPOSInvoiceBooks(IntegrationTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not frappe.get_all("Company", limit=1):
            _set_up_site()

        frappe.set_user("Administrator")
        cls.company = frappe.get_all("Company", pluck="name", limit=1)[0]
        cls.warehouse = frappe.get_all("Warehouse", {"company": cls.company, "is_group": 0}, pluck="name", limit=1)[0]
        cls.customer = cls._customer()
        cls.cash = cls._cash_mode()
        _cashier(LINA)
        _cashier(SARA)
        ensure_cashier_permissions()
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

    def test_the_pos_role_can_list_what_the_screens_list(self):
        frappe.set_user(LINA)

        frappe.get_list("Customer Group", fields=["name"], limit=1)
        frappe.get_list("Sales Person", fields=["name", "sales_person_name"], limit=1)

    def test_the_pos_role_can_pick_an_account_but_not_read_one(self):
        self.assertTrue(frappe.has_permission("Account", "select", user=LINA))
        self.assertFalse(frappe.has_permission("Account", "read", user=LINA))

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

    def _reconciliation(self, doctype, name):
        rows = frappe.get_all(
            doctype,
            {"parent": name},
            ["mode_of_payment", "opening_amount", "expected_amount", "closing_amount", "difference"],
            order_by="mode_of_payment",
        )
        return [{key: flt(value) if key != "mode_of_payment" else value for key, value in row.items()} for row in rows]

    def test_the_closing_entry_expects_the_payments_the_shift_took(self):
        from pos_next.api.partial_payments import create_payment_entry

        frappe.set_user("Administrator")
        owed = frappe.get_doc(
            {
                "doctype": "Sales Invoice",
                "company": self.company,
                "customer": self.customer,
                "items": [{"item_code": ITEM, "qty": 1, "rate": RATE, "warehouse": self.warehouse}],
            }
        )
        owed.insert(ignore_permissions=True)
        owed.submit()

        shift = self._open_shift()
        self._sell(LINA, shift)
        frappe.set_user("Administrator")
        create_payment_entry(owed.name, 40, self.cash, reference_no=shift)

        closing = self._close(shift)

        shift_rows = self._reconciliation("POS Closing Shift Detail", closing)
        self.assertEqual(shift_rows[0]["expected_amount"], 10 + RATE + 40)
        entry = self._entry_of(closing)
        self.assertEqual(self._reconciliation("POS Closing Entry Detail", entry), shift_rows)

    def _owed_invoice(self):
        frappe.set_user("Administrator")
        owed = frappe.get_doc(
            {
                "doctype": "Sales Invoice",
                "company": self.company,
                "customer": self.customer,
                "items": [{"item_code": ITEM, "qty": 1, "rate": RATE, "warehouse": self.warehouse}],
            }
        )
        owed.insert(ignore_permissions=True)
        owed.submit()
        return owed

    def test_a_cashier_takes_a_payment_without_reading_accounts(self):
        """ERPNext 16 reads the cash account with the user's rights, which a cashier lacks."""
        from pos_next.api.partial_payments import create_payment_entry

        owed = self._owed_invoice()
        frappe.set_user(LINA)

        entry = frappe.get_doc("Payment Entry", create_payment_entry(owed.name, 15, self.cash))

        self.assertEqual(frappe.session.user, LINA)
        self.assertEqual(entry.owner, LINA)
        self.assertEqual(entry.docstatus, 1)
        self.assertEqual(flt(entry.paid_amount), 15)
        self.assertEqual(flt(frappe.db.get_value("Sales Invoice", owed.name, "outstanding_amount")), RATE - 15)

    def test_a_cashier_cannot_send_the_money_to_another_account(self):
        from pos_next.api.partial_payments import create_payment_entry

        owed = self._owed_invoice()
        other = frappe.db.get_value("Company", self.company, "default_receivable_account")
        frappe.set_user(LINA)

        with self.assertRaises(frappe.PermissionError):
            create_payment_entry(owed.name, 15, self.cash, payment_account=other)
        self.assertEqual(flt(frappe.db.get_value("Sales Invoice", owed.name, "outstanding_amount")), RATE)

    def _printed_draft(self, shift, amount):
        frappe.set_user(LINA)
        draft = frappe.get_doc(
            {
                "doctype": "POS Invoice",
                "pos_profile": PROFILE,
                "posa_pos_opening_shift": shift,
                "posa_is_printed": 1,
                "company": self.company,
                "customer": self.customer,
                "is_pos": 1,
                "update_stock": 1,
                "items": [{"item_code": ITEM, "qty": 1, "rate": amount, "warehouse": self.warehouse}],
                "payments": [{"mode_of_payment": self.cash, "amount": amount}],
            }
        )
        draft.insert(ignore_permissions=True)
        return draft.name

    def test_reading_a_closing_leaves_a_printed_draft_alone(self):
        shift = self._open_shift()
        draft = self._printed_draft(shift, RATE)

        frappe.set_user(LINA)
        opening = frappe.get_doc("POS Opening Shift", shift)
        preview = build_closing_shift(json.dumps(opening.as_dict(), default=str))

        self.assertEqual(frappe.db.get_value("POS Invoice", draft, "docstatus"), 0)
        self.assertEqual(preview["payment_reconciliation"][0]["expected_amount"], 10 + RATE)

    def test_closing_the_shift_submits_its_printed_draft(self):
        shift = self._open_shift()
        draft = self._printed_draft(shift, RATE)

        entry = self._entry_of(self._close(shift))

        self.assertEqual(frappe.db.get_value("POS Invoice", draft, "docstatus"), 1)
        self.assertIn(draft, frappe.get_all("POS Invoice Reference", {"parent": entry}, pluck="pos_invoice"))
        self.assertTrue(frappe.db.get_value("POS Invoice", draft, "consolidated_invoice"))

    def test_a_closing_in_another_company_than_its_shifts_is_refused(self):
        shift = self._open_shift()
        frappe.set_user("Administrator")
        if not frappe.db.exists("Company", "Books Other Co"):
            frappe.get_doc(
                {"doctype": "Company", "company_name": "Books Other Co", "abbr": "BOC", "default_currency": "USD"}
            ).db_insert()
        opening = frappe.get_doc("POS Opening Shift", shift)
        closing = json.loads(json.dumps(build_closing_shift(json.dumps(opening.as_dict(), default=str)), default=str))
        closing["company"] = "Books Other Co"

        frappe.set_user(LINA)
        with self.assertRaises(frappe.ValidationError):
            save_closing_shift(closing)

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

    def _closed_entry(self):
        shift = self._open_shift()
        self._sell(LINA, shift)
        return frappe.get_doc("POS Closing Entry", self._entry_of(self._close(shift)))

    def test_a_failed_entry_tells_the_managers_at_once(self):
        entry = self._closed_entry()

        with patch.object(closing_alerts, "notify") as notify:
            entry.set_status(update=True, status="Failed")

        notify.assert_called_once_with(entry.name, PROFILE)

    def test_a_failed_entry_is_raised_again_every_hour(self):
        entry = self._closed_entry()
        entry.db_set("status", "Failed")

        with patch.object(closing_alerts, "notify") as notify:
            closing_alerts.remind_about_closings()

        notify.assert_any_call(entry.name, PROFILE)

    def test_only_a_stuck_entry_counts_as_lost_in_the_queue(self):
        entry = self._closed_entry()
        entry.db_set("status", "Queued")

        with patch.object(closing_alerts, "notify") as notify:
            closing_alerts.remind_about_closings()
        self.assertNotIn(entry.name, [call.args[0] for call in notify.call_args_list])

        frappe.db.set_value(
            "POS Closing Entry", entry.name, "modified", add_to_date(now_datetime(), hours=-2), update_modified=False
        )
        with patch.object(closing_alerts, "notify") as notify:
            closing_alerts.remind_about_closings()
        notify.assert_any_call(entry.name, PROFILE)

    def test_a_system_manager_can_undo_a_closed_shift(self):
        if not frappe.db.exists("User", MANAGER):
            user = frappe.get_doc({"doctype": "User", "email": MANAGER, "first_name": "books", "send_welcome_email": 0})
            user.flags.ignore_password_policy = True
            user.insert(ignore_permissions=True)
            user.add_roles("System Manager")

        shift = self._open_shift()
        invoice = self._sell(LINA, shift)
        closing = frappe.get_doc("POS Closing Shift", self._close(shift))
        merged = frappe.db.get_value("POS Invoice", invoice, "consolidated_invoice")

        frappe.set_user(MANAGER)
        self.assertFalse(frappe.has_permission("POS Invoice", "write"))
        closing.reload()
        closing.cancel()

        self.assertEqual(frappe.db.get_value("POS Opening Shift", shift, "status"), "Open")
        self.assertEqual(frappe.db.get_value("Sales Invoice", merged, "docstatus"), 2)
        self.assertFalse(frappe.db.get_value("POS Invoice", invoice, "consolidated_invoice"))
        self.assertEqual(frappe.db.get_value("POS Closing Entry", closing.pos_closing_entry, "docstatus"), 2)

    def test_retry_has_the_access_the_first_attempt_had(self):
        entry = self._closed_entry()
        seen = []

        frappe.set_user(LINA)
        with patch.object(POSClosingEntry, "retry", lambda _self: seen.append(frappe.session.user)):
            entry.retry()

        self.assertEqual(seen, ["Administrator"])
        self.assertEqual(frappe.session.user, LINA)
