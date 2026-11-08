# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Returns and stock checks: what a return refunds, what it may return, and what stock counts.

These run without a site. The real runs on MariaDB cover the same paths end to end.
"""

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import frappe
from frappe.query_builder.utils import get_query_builder

from pos_next.api import invoices
from pos_next.services import invoice_processor, pos_reserved_stock


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class NoSiteTestCase(unittest.TestCase):
    def setUp(self):
        for target, replacement in (
            ("frappe.throw", _raise),
            ("frappe._", lambda text, *_args, **_kwargs: text),
            ("pos_next.api.invoices._", lambda text, *_args, **_kwargs: text),
            ("frappe.get_system_settings", {"rounding_method": "Banker's Rounding"}.get),
            ("pos_next.services.pos_reserved_stock.now", lambda: "2026-11-08 12:00:00"),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        frappe.local.db = Mock()
        frappe.local.qb = get_query_builder("mariadb")
        frappe.local.flags = frappe._dict()
        self.addCleanup(setattr, frappe.local, "db", None)
        self.addCleanup(setattr, frappe.local, "qb", None)
        self.addCleanup(setattr, frappe.local, "flags", None)


class TestReturnPrice(NoSiteTestCase):
    """2 x 100 with 20 off the invoice: the customer paid 180 (VAT included) or 210 (VAT added)."""

    def test_an_inclusive_return_refunds_the_price_after_the_invoice_discount(self):
        source = {"qty": 2, "net_amount": 156.52}
        priced = invoices._price_return_row(source, {"amount": 23.48, "rate": 15}, True, 100, 2)

        self.assertEqual(priced["rate"], 90)
        self.assertEqual(priced["rate_with_tax"], 90)
        self.assertEqual(priced["tax_fraction"], 0)
        self.assertEqual(priced["discount_per_unit"], 10)
        self.assertEqual(2 * priced["rate"], 180)

    def test_an_exclusive_return_adds_the_tax_of_its_own_row(self):
        source = {"qty": 2, "net_amount": 182.61}
        priced = invoices._price_return_row(source, {"amount": 27.39, "rate": 15}, False, 100, 2)

        self.assertEqual(priced["rate"], 91.3)
        self.assertAlmostEqual(priced["tax_fraction"], 0.15)
        self.assertGreater(priced["tax_per_unit"], 13)
        # What ERPNext totals the return at: net rounded per row, tax once on the sum
        net = round(2 * priced["rate"], 2)
        self.assertAlmostEqual(net + round(net * priced["tax_fraction"], 2), 209.99, places=2)

    def test_a_fixed_tax_counts_by_its_share_of_the_row(self):
        source = {"qty": 4, "net_amount": 100}
        priced = invoices._price_return_row(source, {"amount": 10, "rate": 0}, False, 25, 2)

        self.assertEqual(priced["rate"], 25)
        self.assertAlmostEqual(priced["tax_fraction"], 0.1)


class TestItemTaxMap(NoSiteTestCase):
    def test_reads_the_item_wise_tax_detail_table_of_erpnext_16_by_item_row(self):
        rows = [
            {"name": "row-1", "item_code": "A", "net_amount": 100},
            {"name": "row-2", "item_code": "A", "net_amount": 50},
        ]
        details = [
            {"item_row": "row-1", "rate": 15, "amount": 15},
            {"item_row": "row-2", "rate": 15, "amount": 7.5},
            {"item_row": "row-2", "rate": 5, "amount": 2.5},
        ]
        tax_map = invoices._build_item_tax_map([], rows, details)

        self.assertEqual(tax_map["row-1"], {"amount": 15, "rate": 15})
        self.assertEqual(tax_map["row-2"], {"amount": 10, "rate": 20})

    def test_turns_the_company_currency_of_the_table_into_the_invoices(self):
        details = [{"item_row": "row-1", "rate": 15, "amount": 60}]
        tax_map = invoices._build_item_tax_map([], [{"name": "row-1"}], details, conversion_rate=4)

        self.assertEqual(tax_map["row-1"]["amount"], 15)

    def test_a_tax_that_is_not_a_percentage_leaves_the_rate_unknown(self):
        details = [
            {"item_row": "row-1", "rate": 15, "amount": 15},
            {"item_row": "row-1", "rate": 0, "amount": 5},
        ]
        tax_map = invoices._build_item_tax_map([], [{"name": "row-1"}], details)

        self.assertEqual(tax_map["row-1"], {"amount": 20, "rate": 0})

    def test_older_versions_share_the_tax_of_an_item_code_between_its_rows(self):
        rows = [
            {"name": "row-1", "item_code": "A", "net_amount": 100},
            {"name": "row-2", "item_code": "A", "net_amount": 50},
        ]
        taxes = [{"item_wise_tax_detail": '{"A": [15, 22.5]}'}]
        tax_map = invoices._build_item_tax_map(taxes, rows)

        self.assertAlmostEqual(tax_map["row-1"]["amount"], 15)
        self.assertAlmostEqual(tax_map["row-2"]["amount"], 7.5)


class TestRefundRounding(NoSiteTestCase):
    def _return(self, grand_total, *amounts):
        doc = frappe._dict(
            grand_total=grand_total,
            rounded_total=0,
            conversion_rate=1,
            payments=[frappe._dict(amount=amount, base_amount=amount) for amount in amounts],
        )
        doc.precision = lambda _field: 2
        return doc

    def test_a_refund_a_cent_over_the_return_is_brought_back_to_it(self):
        doc = self._return(-209.99, -10, -200)
        invoices._trim_refund_rounding(doc)

        self.assertEqual([p.amount for p in doc.payments], [-10, -199.99])
        self.assertEqual(doc.payments[1].base_amount, -199.99)

    def test_a_real_difference_is_left_for_erpnext_to_refuse(self):
        doc = self._return(-180, -200)
        invoices._trim_refund_rounding(doc)

        self.assertEqual(doc.payments[0].amount, -200)

    def test_a_refund_under_the_return_is_left_alone(self):
        doc = self._return(-210, -209.99)
        invoices._trim_refund_rounding(doc)

        self.assertEqual(doc.payments[0].amount, -209.99)


class TestShouldBlock(NoSiteTestCase):
    def _block(self, profile_value):
        frappe.local.db.get_single_value.return_value = 0

        def get_value(doctype, *_args, **_kwargs):
            return 0 if doctype == "POS Settings" else profile_value

        frappe.local.db.get_value.side_effect = get_value
        return invoices._should_block("Main")

    def test_an_explicit_zero_turns_blocking_off(self):
        self.assertFalse(self._block(0))

    def test_an_unset_value_keeps_blocking(self):
        self.assertTrue(self._block(None))

    def test_one_blocks(self):
        self.assertTrue(self._block(1))


class TestReturnLock(NoSiteTestCase):
    """Two returns of one invoice: the second must see the first, which committed while it waited."""

    def setUp(self):
        super().setUp()
        self.queries = []

        def sql(query, *_args, **_kwargs):
            self.queries.append(str(query))
            if "returned_qty" in str(query):
                return [frappe._dict(item_code="A", returned_qty=3)]
            if "total_qty" in str(query):
                return [frappe._dict(item_code="A", total_qty=3)]
            return [frappe._dict(pos_profile=None, posting_date=date(2026, 11, 8))]

        frappe.local.db.sql.side_effect = sql

    def test_a_return_being_saved_locks_its_invoice_and_reads_the_latest_returns(self):
        result = invoices._validate_return_items("SINV-1", [{"item_code": "A", "qty": -3}], lock=True)

        self.assertFalse(result["valid"])
        invoice_read, _items_read, returned_read = self.queries
        self.assertIn("FOR UPDATE", invoice_read)
        self.assertIn("FOR UPDATE", returned_read)

    def test_the_whitelisted_check_takes_no_lock(self):
        invoices.validate_return_items("SINV-1", [{"item_code": "A", "qty": -1}])

        self.assertFalse(any("FOR UPDATE" in query for query in self.queries))

    def test_saving_a_return_checks_it_under_the_lock(self):
        doc = SimpleNamespace(return_against="SINV-1", doctype="Sales Invoice", items=[], get=lambda *_args: None)
        with patch.object(invoices, "_validate_return_items", return_value={"valid": True}) as check:
            invoices.assert_return_quantities(doc)

        self.assertTrue(check.call_args.kwargs["lock"])

    def test_submitting_an_existing_return_draft_checks_it_under_the_lock(self):
        draft = MagicMock()
        draft.get.side_effect = lambda field, default=None: {"is_return": 1, "return_against": "SINV-1"}.get(field, default)
        stop = RuntimeError("stop after the check")
        with (
            patch("frappe.get_doc", return_value=draft),
            patch.object(invoice_processor, "_assert_invoice_write_access"),
            patch.object(invoice_processor, "assert_return_quantities", side_effect=stop) as check,
        ):
            frappe.local.db.exists.return_value = True
            with self.assertRaises(RuntimeError):
                invoice_processor.process_invoice({"name": "SINV-RET-1"}, {}, "Sales Invoice", "Main")

        check.assert_called_once_with(draft, False)


class TestPosReservedStock(NoSiteTestCase):
    def test_counts_unconsolidated_pos_invoices_and_their_packed_items(self):
        queries = []

        def sql(query, *_args, **_kwargs):
            queries.append(str(query))
            if "tabPacked Item" in str(query):
                return [frappe._dict(item_code="A", qty=1)]
            return [frappe._dict(item_code="A", qty=4), frappe._dict(item_code="B", qty=-2)]

        frappe.local.db.sql.side_effect = sql
        reserved = pos_reserved_stock.get_reserved_qty_map(["A", "B", "A"], ["Stores"])

        self.assertEqual(reserved, {"A": 5, "B": -2})
        self.assertIn("IFNULL(`tabPOS Invoice`.`consolidated_invoice`,", queries[0])
        self.assertIn("`stock_qty`", queries[0])
        self.assertIn("`tabPacked Item`.`parenttype`=", queries[1])

    def test_takes_what_pos_invoices_hold_out_of_bin_quantities(self):
        with patch.object(pos_reserved_stock, "get_reserved_qty_map", return_value={"A": 4}):
            self.assertEqual(pos_reserved_stock.subtract_reserved({"A": 5, "B": 2}, ["Stores"]), {"A": 1, "B": 2})

    def test_the_server_check_leaves_out_what_pos_invoices_hold(self):
        frappe.local.db.get_value.return_value = 5
        with patch("erpnext.accounts.doctype.pos_invoice.pos_invoice.get_pos_reserved_qty", return_value=4):
            self.assertEqual(invoices._get_available_stock({"item_code": "A", "warehouse": "Stores"}), 1)

    def test_a_submitted_pos_invoice_stamps_its_bins_for_the_stock_pull(self):
        doc = frappe._dict(
            items=[frappe._dict(item_code="B", warehouse="Stores"), frappe._dict(item_code="A", warehouse="Stores")],
            packed_items=[frappe._dict(item_code="C", warehouse="Back")],
        )
        pos_reserved_stock.touch_reserving_bins(doc)

        calls = frappe.local.db.sql.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertIn("UPDATE `tabBin` SET modified", calls[0].args[0])
        self.assertEqual(calls[0].args[1][1:], ["Stores", "A", "B"])
        self.assertEqual(calls[1].args[1][1:], ["Back", "C"])


if __name__ == "__main__":
    unittest.main()
