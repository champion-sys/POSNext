# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Fault scenario 18: a shift closed with a sale that never reached the server."""

import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import frappe

from pos_next.api import sync as sync_api
from pos_next.pos_next.doctype.offline_invoice_sync import offline_invoice_sync
from pos_next.services import sync_reconciliation
from pos_next.services.sync_entities import DOCTYPE

SHIFT = "POS-OPE-0001"


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


def _record(offline_id, status="Synced", invoice=None, shift=None, entity="invoice", doctype="Sales Invoice"):
    return frappe._dict(
        name=f"record-{offline_id}",
        offline_id=offline_id,
        status=status,
        sales_invoice=invoice,
        invoice_doctype=doctype if invoice else None,
        shift=shift,
        entity=entity,
    )


def _invoice(name, offline_id=None, shift=SHIFT, docstatus=1):
    return frappe._dict(name=name, offline_id=offline_id, posa_pos_opening_shift=shift, docstatus=docstatus)


class FakeTables:
    """Answers the reads of a reconciliation, and counts them."""

    def __init__(self, records=(), sales_invoices=(), pos_invoices=()):
        self.tables = {
            DOCTYPE: list(records),
            "Sales Invoice": list(sales_invoices),
            "POS Invoice": list(pos_invoices),
        }
        self.queries = []

    @staticmethod
    def _matches(row, filters):
        for fieldname, expected in filters.items():
            value = row.get(fieldname)
            if isinstance(expected, list):
                if value not in expected[1]:
                    return False
            elif value != expected:
                return False
        return True

    def get_all(self, doctype, filters=None, fields=None, **_kwargs):
        self.queries.append((doctype, filters))
        return [row for row in self.tables[doctype] if self._matches(row, filters)]


class ReconciliationCase(unittest.TestCase):
    def setUp(self):
        for target, replacement in (
            ("frappe.throw", _raise),
            ("pos_next.services.sync_reconciliation._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.addCleanup(setattr, frappe.local, "db", getattr(frappe.local, "db", None))
        frappe.local.db = Mock()

    def _read(self, manifest, entity="shift_close", shift=SHIFT, **tables):
        self.fake = FakeTables(**tables)
        frappe.local.db.get_value.return_value = frappe._dict(
            entity=entity, shift=shift, depends_on="\n".join(manifest)
        )
        with patch("pos_next.services.sync_reconciliation.frappe.get_all", self.fake.get_all):
            return sync_reconciliation.get_shift_reconciliation("close-1")

    def _extra_ids(self, result):
        return sorted(entry["offline_id"] or entry["invoice"] for entry in result["extras"])


class TestManifestEntries(ReconciliationCase):
    def test_scenario_18_names_the_sale_that_never_arrived(self):
        result = self._read(
            ["sale-1", "sale-2", "sale-3"],
            records=[_record("sale-1", invoice="SINV-1"), _record("sale-2", status="Needs Review")],
        )

        missing = [entry for entry in result["entries"] if entry["state"] == "missing"]
        self.assertEqual([entry["offline_id"] for entry in missing], ["sale-3"])
        self.assertIsNone(missing[0]["status"])
        self.assertIsNone(missing[0]["invoice"])
        self.assertEqual(result["counts"]["missing"], 1)

    def test_each_entry_carries_its_status_and_invoice(self):
        result = self._read(["sale-1"], records=[_record("sale-1", invoice="ACC-PSINV-1", doctype="POS Invoice")])

        self.assertEqual(
            result["entries"],
            [
                {
                    "offline_id": "sale-1",
                    "state": "finished",
                    "status": "Synced",
                    "record": "record-sale-1",
                    "invoice": "ACC-PSINV-1",
                    "invoice_doctype": "POS Invoice",
                }
            ],
        )

    def test_entries_keep_the_order_of_the_manifest_without_repeats(self):
        result = self._read(["b", "a", "b"], records=[_record("a"), _record("b")])
        self.assertEqual([entry["offline_id"] for entry in result["entries"]], ["b", "a"])

    def test_counts_cover_every_state(self):
        result = self._read(
            ["done", "linked", "review", "waiting", "retry", "gone", "never"],
            records=[
                _record("done", invoice="SINV-1"),
                _record("linked", status="Resolved", invoice="SINV-2"),
                _record("review", status="Needs Review"),
                _record("waiting", status="Blocked"),
                _record("retry", status="Retry Scheduled"),
                _record("gone", status="Voided"),
            ],
        )

        self.assertEqual(
            result["counts"],
            {
                "finished": 2,
                "review": 1,
                "processing": 2,
                "voided": 1,
                "missing": 1,
                "manifest": 7,
                "extra": 0,
            },
        )

    def test_a_sale_whose_record_is_gone_but_whose_invoice_exists_arrived(self):
        result = self._read(["sale-1"], pos_invoices=[_invoice("ACC-PSINV-1", "sale-1", shift="other")])

        entry = result["entries"][0]
        self.assertEqual(entry["state"], "finished")
        self.assertEqual((entry["invoice_doctype"], entry["invoice"]), ("POS Invoice", "ACC-PSINV-1"))

    def test_a_cancelled_invoice_does_not_count_as_arrived(self):
        result = self._read(["sale-1"], sales_invoices=[_invoice("SINV-1", "sale-1", docstatus=2)])
        self.assertEqual(result["entries"][0]["state"], "missing")

    def test_only_a_shift_close_has_a_manifest(self):
        with self.assertRaises(frappe.ValidationError):
            self._read(["sale-1"], entity="invoice")

    def test_a_missing_record_is_refused(self):
        frappe.local.db.get_value.return_value = None
        with self.assertRaises(frappe.ValidationError):
            sync_reconciliation.get_shift_reconciliation("nope")


class TestExtras(ReconciliationCase):
    def test_a_sale_made_online_has_no_shift_on_its_record_but_is_found_by_its_invoice(self):
        result = self._read(
            ["sale-1"],
            records=[_record("sale-1", invoice="SINV-1"), _record("online-1", invoice="SINV-2", shift=None)],
            sales_invoices=[_invoice("SINV-1", "sale-1"), _invoice("SINV-2", "online-1")],
        )

        self.assertEqual(self._extra_ids(result), ["online-1"])
        self.assertEqual(result["extras"][0]["invoice"], "SINV-2")
        self.assertEqual(result["counts"]["extra"], 1)

    def test_a_pos_invoice_counts_too(self):
        result = self._read([], pos_invoices=[_invoice("ACC-PSINV-1", "online-1")])
        self.assertEqual(result["extras"][0]["invoice_doctype"], "POS Invoice")

    def test_an_invoice_without_an_offline_id_is_listed_by_name(self):
        result = self._read([], sales_invoices=[_invoice("SINV-9")])
        self.assertEqual(self._extra_ids(result), ["SINV-9"])

    def test_a_record_on_the_shift_is_listed_with_its_status(self):
        result = self._read(
            [],
            records=[
                _record("sale-1", status="Needs Review", shift=SHIFT),
                _record("sale-2", status="Voided", shift=SHIFT),
            ],
        )

        self.assertEqual(self._extra_ids(result), ["sale-1", "sale-2"])
        self.assertEqual({entry["status"] for entry in result["extras"]}, {"Needs Review", "Voided"})

    def test_a_record_and_its_invoice_are_one_extra(self):
        result = self._read(
            [],
            records=[_record("sale-1", invoice="SINV-1", shift=SHIFT)],
            sales_invoices=[_invoice("SINV-1", "sale-1")],
        )

        self.assertEqual(len(result["extras"]), 1)
        self.assertEqual(result["extras"][0]["status"], "Synced")

    def test_a_hand_entered_invoice_linked_to_a_record_on_the_shift_is_one_extra(self):
        result = self._read(
            [],
            records=[_record("sale-1", status="Resolved", invoice="SINV-7", shift=SHIFT)],
            sales_invoices=[_invoice("SINV-7")],
        )
        self.assertEqual(len(result["extras"]), 1)

    def test_a_hand_entered_invoice_linked_to_a_manifest_entry_is_not_an_extra(self):
        result = self._read(
            ["sale-1"],
            records=[_record("sale-1", status="Resolved", invoice="SINV-7")],
            sales_invoices=[_invoice("SINV-7")],
        )
        self.assertEqual(result["extras"], [])

    def test_the_close_and_other_records_on_the_shift_are_not_invoices(self):
        result = self._read(
            [],
            records=[
                _record("close-1", status="Blocked", shift=SHIFT, entity="shift_close"),
                _record("payment-1", shift=SHIFT, entity="payment"),
            ],
        )
        self.assertEqual(result["extras"], [])

    def test_another_shift_stays_out(self):
        result = self._read(
            [],
            records=[_record("sale-1", shift="other")],
            sales_invoices=[_invoice("SINV-1", shift="other")],
        )
        self.assertEqual(result["extras"], [])

    def test_a_draft_or_cancelled_invoice_is_not_held(self):
        result = self._read([], sales_invoices=[_invoice("SINV-1", docstatus=0), _invoice("SINV-2", docstatus=2)])
        self.assertEqual(result["extras"], [])

    def test_a_close_without_a_shift_never_searches_for_an_empty_shift(self):
        result = self._read(["sale-1"], shift=None, records=[_record("sale-1"), _record("other", shift=None)])

        self.assertEqual(result["extras"], [])
        self.assertFalse([filters for _doctype, filters in self.fake.queries if "shift" in filters])


class TestLongManifest(ReconciliationCase):
    def test_reads_stay_in_bulk(self):
        manifest = [f"sale-{index}" for index in range(2500)]
        result = self._read(manifest, records=[_record(offline_id) for offline_id in manifest[:2400]])

        self.assertEqual(result["counts"]["manifest"], 2500)
        self.assertEqual(result["counts"]["missing"], 100)
        # 3 for the records, 1 per invoice table for the 100 lost ids, then the extras
        self.assertLessEqual(len(self.fake.queries), 8)

    def test_each_query_stays_within_a_chunk(self):
        manifest = [f"sale-{index}" for index in range(2500)]
        self._read(manifest)

        sizes = [len(filters["offline_id"][1]) for _doctype, filters in self.fake.queries if "offline_id" in filters]
        self.assertLessEqual(max(sizes), sync_reconciliation.MANIFEST_CHUNK)


class TestAccess(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, frappe.local, "session", getattr(frappe.local, "session", None))
        frappe.local.session = Mock(user="someone@example.com")
        patcher = patch("pos_next.api.sync.sync_reconciliation.get_shift_reconciliation", return_value={"counts": {}})
        self.reader = patcher.start()
        self.addCleanup(patcher.stop)

    def _read(self, roles, allowed=True):
        side_effect = None if allowed else frappe.PermissionError
        with (
            patch("pos_next.api.sync.frappe.get_roles", return_value=roles),
            patch("frappe.throw", _raise),
            patch("pos_next.api.sync._", lambda text: text),
            patch("pos_next.api.sync.frappe.has_permission", side_effect=side_effect) as self.has_permission,
        ):
            return sync_api.get_shift_reconciliation("close-1")

    def test_a_cashier_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            self._read(["POSNext Cashier"])
        self.reader.assert_not_called()

    def test_a_manager_without_access_to_this_record_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            self._read(["Nexus POS Manager"], allowed=False)
        self.reader.assert_not_called()

    def test_a_manager_reads_it(self):
        self.assertEqual(self._read(["Nexus POS Manager"]), {"counts": {}})
        self.has_permission.assert_called_once_with(DOCTYPE, "read", doc="close-1", throw=True)

    def test_it_is_open_to_the_desk(self):
        self.assertIn(sync_api.get_shift_reconciliation, frappe.whitelisted)


class TestForm(unittest.TestCase):
    def setUp(self):
        path = Path(offline_invoice_sync.__file__).with_suffix(".json")
        self.fields = {field["fieldname"]: field for field in json.loads(path.read_text())["fields"]}

    def test_the_table_shows_on_a_shift_close_only(self):
        self.assertEqual(self.fields["section_reconciliation"]["depends_on"], "eval:doc.entity=='shift_close'")
        self.assertEqual(self.fields["reconciliation_html"]["fieldtype"], "HTML")

    def test_the_shift_is_indexed_for_the_read_by_shift(self):
        self.assertEqual(self.fields["shift"]["search_index"], 1)
