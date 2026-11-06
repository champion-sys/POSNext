# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import re
import sqlite3
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from pos_next.api import sync_pull
from pos_next.api.pos_profile import get_taxes
from pos_next.api.sync_pull import _decode_cursor, get_manifest, pull, record_rename

NOW = datetime(2026, 11, 6, 12, 0, 0)
LONG_AGO = "2026-01-01 10:00:00.000000"
MAX_WALK_PAGES = 50

SCHEMA = """
CREATE TABLE `tabItem` (
    name TEXT PRIMARY KEY, item_name TEXT, description TEXT, stock_uom TEXT DEFAULT 'Nos', image TEXT,
    is_stock_item INT DEFAULT 1, has_batch_no INT DEFAULT 0, has_serial_no INT DEFAULT 0,
    item_group TEXT DEFAULT 'Food', brand TEXT, has_variants INT DEFAULT 0, variant_of TEXT,
    custom_company TEXT, disabled INT DEFAULT 0, is_sales_item INT DEFAULT 1, modified TEXT
);
CREATE TABLE `tabItem Barcode` (parent TEXT, barcode TEXT, uom TEXT);
CREATE TABLE `tabItem Price` (name TEXT PRIMARY KEY, item_code TEXT, price_list TEXT, modified TEXT);
CREATE TABLE `tabCustomer` (
    name TEXT PRIMARY KEY, customer_name TEXT, mobile_no TEXT, email_id TEXT,
    disabled INT DEFAULT 0, customer_group TEXT, modified TEXT
);
CREATE TABLE `tabDeleted Document` (
    name TEXT PRIMARY KEY, deleted_doctype TEXT, deleted_name TEXT, creation TEXT, data TEXT
);
CREATE TABLE `tabSales Taxes and Charges Template` (name TEXT, modified TEXT);
CREATE TABLE `tabMode of Payment` (name TEXT, modified TEXT);
CREATE TABLE `tabPOS Settings` (name TEXT, modified TEXT);
CREATE TABLE `tabCompany` (name TEXT, modified TEXT);
CREATE TABLE `tabItem Group` (name TEXT, modified TEXT);
CREATE TABLE `tabPricing Rule` (name TEXT, modified TEXT);
CREATE TABLE `tabPromotional Scheme` (name TEXT, modified TEXT);
"""


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class SqliteDb:
    """Runs the module's real SQL, so the cursor logic is tested against a real engine."""

    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(SCHEMA)
        self.exists = Mock(return_value="row-1")

    def sql(self, query, values=(), as_dict=False, **_kwargs):
        query = re.sub(r"%\((\w+)\)s", r":\1", query).replace("%s", "?")
        # Frappe sends an explicit None to the driver as one parameter, and MariaDB fails on it
        rows = self.connection.execute(query, (None,) if values is None else values).fetchall()
        return [frappe._dict(dict(row)) for row in rows] if as_dict else [tuple(row) for row in rows]

    def insert(self, table, **values):
        columns = ", ".join(values)
        marks = ", ".join("?" * len(values))
        self.connection.execute(f"INSERT INTO `tab{table}` ({columns}) VALUES ({marks})", tuple(values.values()))

    def update(self, table, row, /, **values):
        assignments = ", ".join(f"{column} = ?" for column in values)
        self.connection.execute(
            f"UPDATE `tab{table}` SET {assignments} WHERE name = ?", (*values.values(), row)
        )

    def delete(self, table, name):
        self.connection.execute(f"DELETE FROM `tab{table}` WHERE name = ?", (name,))

    def set_value(self, doctype, name, field, value, update_modified=True):
        self.update(doctype, name, **{field: value})


def _get_all(doctype, filters=None, fields=None, pluck=None, limit=None):
    clauses = []
    values = []
    for field, condition in (filters or {}).items():
        if isinstance(condition, list):
            clauses.append(f"{field} IN ({', '.join('?' * len(condition[1]))})")
            values.extend(condition[1])
        else:
            clauses.append(f"{field} = ?")
            values.append(condition)

    columns = pluck or ", ".join(fields)
    query = f"SELECT {columns} FROM `tab{doctype}` WHERE {' AND '.join(clauses) or '1'}"
    rows = frappe.local.db.connection.execute(query, values).fetchall()
    return [row[pluck] for row in rows] if pluck else [frappe._dict(dict(row)) for row in rows]


def _enrich(items, _profile, exclude_variants):
    for item in items:
        item["rate"] = 10


class NoSiteTestCase(unittest.TestCase):
    """Replace the helpers that need a site, so these run without a database."""

    def setUp(self):
        self.db = SqliteDb()
        self.profile = frappe._dict(
            name="Main",
            modified=LONG_AGO,
            company="Co",
            warehouse="Stores",
            selling_price_list="Retail",
            taxes_and_charges="VAT",
            ignore_pricing_rule=0,
            hide_unavailable_items=0,
            item_groups=[frappe._dict(item_group="Food")],
        )
        self.groups = {"Food": ["Food", "Snacks"], "Drinks": ["Drinks"]}

        for target, replacement in (
            ("frappe.throw", _raise),
            ("pos_next.api.sync_pull._", lambda text: text),
            ("pos_next.api.sync._", lambda text: text),
            ("frappe.has_permission", Mock(return_value=False)),
            ("frappe.get_all", _get_all),
            ("frappe.get_cached_doc", lambda *_args: self.profile),
            ("pos_next.api.sync_pull._enrich_items_bulk", _enrich),
            ("pos_next.api.sync_pull._get_allowed_profile_brands", lambda _name: []),
            ("pos_next.api.items._get_allowed_profile_brands", lambda _name: []),
            ("pos_next.api.sync_pull._get_item_group_with_descendants", lambda group: self.groups[group]),
            ("pos_next.api.sync_pull.now_datetime", lambda: NOW),
            ("pos_next.api.sync_pull.now", lambda: str(NOW)),
            ("pos_next.api.sync_pull.nowdate", lambda: self.today),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.today = "2026-11-06"
        frappe.local.session = Mock(user="cashier@example.com")
        frappe.local.db = self.db
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)

    def add_item(self, name, modified=LONG_AGO, **values):
        self.db.insert("Item", name=name, item_name=name, modified=modified, **values)

    def add_tombstone(self, doctype, deleted_name, creation=LONG_AGO, data=None):
        self.db.insert(
            "Deleted Document",
            name=f"tomb-{deleted_name}",
            deleted_doctype=doctype,
            deleted_name=deleted_name,
            creation=creation,
            data=json.dumps(data) if data else None,
        )

    def walk(self, entity, cursor=None, limit=500):
        """Follow next_cursor to the end, as the device does."""
        pages = []
        for _ in range(MAX_WALK_PAGES):
            page = pull(entity, "Main", cursor, limit)
            pages.append(page)
            cursor = page["next_cursor"]
            if not page["has_more"]:
                return pages, cursor
        self.fail(f"The walk of {entity} never finished: its cursor is not advancing")

    @staticmethod
    def codes(pages):
        return [row["item_code"] for page in pages for row in page["rows"]]

    @staticmethod
    def deleted(pages):
        return [name for page in pages for name in page["deleted"]]


class TestAccess(NoSiteTestCase):
    def outside_the_profile(self):
        """Assigned to another profile: passes the POS user check, not the profile check."""
        self.db.exists = Mock(side_effect=lambda _doctype, filters: None if "parent" in filters else "row-1")

    def test_guest_is_rejected(self):
        frappe.local.session.user = "Guest"
        with self.assertRaises(frappe.AuthenticationError):
            pull("items", "Main")
        with self.assertRaises(frappe.AuthenticationError):
            get_manifest("Main")

    def test_user_without_any_profile_is_rejected(self):
        self.db.exists = Mock(return_value=None)
        with self.assertRaises(frappe.PermissionError):
            pull("items", "Main")

    def test_user_of_another_profile_is_rejected(self):
        self.outside_the_profile()
        with self.assertRaises(frappe.PermissionError):
            pull("items", "Main")
        with self.assertRaises(frappe.PermissionError):
            get_manifest("Main")

    def test_missing_profile_is_rejected(self):
        with self.assertRaises(frappe.PermissionError):
            pull("items", None)

    def test_no_data_is_read_before_the_check(self):
        self.outside_the_profile()
        with patch("frappe.get_cached_doc") as mock_get_cached_doc:
            with self.assertRaises(frappe.PermissionError):
                pull("taxes", "Main")
        mock_get_cached_doc.assert_not_called()

    def test_assigned_user_is_allowed(self):
        self.assertEqual(pull("items", "Main")["rows"], [])

    def test_profile_manager_is_allowed(self):
        self.outside_the_profile()
        with patch("frappe.has_permission", return_value=True):
            self.assertEqual(pull("items", "Main")["rows"], [])

    def test_unknown_entity_is_rejected(self):
        with self.assertRaises(frappe.ValidationError):
            pull("Sales Invoice", "Main")


class TestCursor(NoSiteTestCase):
    def test_empty_cursor_starts_at_the_beginning(self):
        self.assertEqual(_decode_cursor(None)["name"], "")

    def test_rejects_malformed_cursors(self):
        for cursor in ("not json", "[]", '{"modified": "2026-01-01"}', '{"modified": "x", "deleted_at": "y"}'):
            with self.assertRaises(frappe.ValidationError):
                _decode_cursor(cursor)

    def test_accepts_the_cursor_it_issued(self):
        self.add_item("A")
        page = pull("items", "Main")
        self.assertIn("modified", _decode_cursor(page["next_cursor"]))

    def test_keeps_microseconds(self):
        self.add_item("A", modified="2026-01-01 10:00:00.123456")
        self.add_item("B", modified="2026-01-01 10:00:00.123457")

        page = pull("items", "Main", limit=1)

        self.assertEqual(json.loads(page["next_cursor"])["modified"], "2026-01-01 10:00:00.123456")
        self.assertEqual(self.codes([pull("items", "Main", page["next_cursor"])]), ["B"])

    def test_limit_stays_within_bounds(self):
        with patch.dict(sync_pull._WALKED, {"items": Mock(return_value={})}):
            for asked, used in (("100000", 2000), (0, 500), (-5, 1), ("20", 20), (None, 500)):
                pull("items", "Main", None, asked)
                self.assertEqual(sync_pull._WALKED["items"].call_args.args[2], used)


class TestItems(NoSiteTestCase):
    def test_rows_sharing_a_modified_value_survive_page_boundaries(self):
        for code in "ABCDE":
            self.add_item(code)

        pages, _ = self.walk("items", limit=2)

        self.assertEqual(self.codes(pages), list("ABCDE"))
        self.assertEqual([page["has_more"] for page in pages], [True, True, False])

    def test_walks_in_modified_order(self):
        self.add_item("LATER", modified="2026-02-01 10:00:00.000000")
        self.add_item("EARLIER", modified="2026-01-01 10:00:00.000000")

        pages, _ = self.walk("items", limit=1)

        self.assertEqual(self.codes(pages), ["EARLIER", "LATER"])

    def test_nothing_new_returns_nothing(self):
        self.add_item("A")
        _, cursor = self.walk("items")

        page = pull("items", "Main", cursor)

        self.assertEqual((page["rows"], page["deleted"], page["has_more"]), ([], [], False))

    def test_an_edit_during_the_walk_is_not_lost(self):
        for code in "ABC":
            self.add_item(code)

        first = pull("items", "Main", limit=2)
        self.db.update("Item", "A", modified="2026-02-01 10:00:00.000000")
        pages, _ = self.walk("items", first["next_cursor"], limit=2)

        self.assertEqual(sorted(self.codes(pages)), ["A", "C"])

    def test_finds_only_what_changed_since_the_last_walk(self):
        for code in "ABC":
            self.add_item(code)
        _, cursor = self.walk("items")

        self.db.update("Item", "B", modified="2026-02-01 10:00:00.000000", item_name="Renamed")
        page = pull("items", "Main", cursor)

        self.assertEqual(self.codes([page]), ["B"])
        self.assertEqual(page["rows"][0]["rate"], 10)

    def test_row_matches_the_cached_shape(self):
        self.add_item("A", brand="Acme")
        self.db.insert("Item Barcode", parent="A", barcode="123", uom="Nos")

        row = pull("items", "Main")["rows"][0]

        self.assertEqual((row["item_code"], row["brand"], row["barcode"]), ("A", "Acme", "123"))

    def test_disabled_item_is_reported_as_deleted(self):
        self.add_item("A")
        self.add_item("OFF", disabled=1)

        page = pull("items", "Main")

        self.assertEqual(self.codes([page]), ["A"])
        self.assertEqual(page["deleted"], ["OFF"])

    def test_item_that_left_the_profile_groups_is_reported_as_deleted(self):
        self.add_item("KEPT", item_group="Food")
        self.add_item("CHILD", item_group="Snacks")
        self.add_item("MOVED", item_group="Drinks")

        page = pull("items", "Main")

        self.assertEqual(sorted(self.codes([page])), ["CHILD", "KEPT"])
        self.assertEqual(page["deleted"], ["MOVED"])

    def test_profile_without_groups_keeps_every_group(self):
        self.profile.item_groups = []
        self.add_item("A", item_group="Drinks")

        self.assertEqual(self.codes([pull("items", "Main")]), ["A"])

    def test_item_outside_the_catalog_rules_is_reported_as_deleted(self):
        self.add_item("OTHER-CO", custom_company="Other")
        self.add_item("NOT-FOR-SALE", is_sales_item=0)

        page = pull("items", "Main")

        self.assertEqual(page["rows"], [])
        self.assertEqual(sorted(page["deleted"]), ["NOT-FOR-SALE", "OTHER-CO"])

    def test_variants_and_templates_both_stay_for_barcode_scans(self):
        self.add_item("TEMPLATE", has_variants=1)
        self.add_item("VARIANT", variant_of="TEMPLATE")

        self.assertEqual(sorted(self.codes([pull("items", "Main")])), ["TEMPLATE", "VARIANT"])

    def test_out_of_stock_item_stays_so_it_can_come_back(self):
        self.profile.hide_unavailable_items = 1
        self.add_item("EMPTY")

        page = pull("items", "Main")

        self.assertEqual(page["deleted"], [])
        self.assertEqual(page["rows"][0]["hide_when_unavailable"], 1)

    def test_rows_are_only_flagged_for_a_profile_that_hides(self):
        self.add_item("A")

        self.assertNotIn("hide_when_unavailable", pull("items", "Main")["rows"][0])


class TestTombstones(NoSiteTestCase):
    def test_deleted_item_is_reported(self):
        self.add_tombstone("Item", "GONE")

        self.assertEqual(pull("items", "Main")["deleted"], ["GONE"])

    def test_tombstone_of_a_recreated_item_is_ignored(self):
        self.add_item("BACK")
        self.add_tombstone("Item", "BACK")

        page = pull("items", "Main")

        self.assertEqual(self.codes([page]), ["BACK"])
        self.assertEqual(page["deleted"], [])

    def test_other_doctypes_are_ignored(self):
        self.add_tombstone("Sales Invoice", "SINV-1")

        self.assertEqual(pull("items", "Main")["deleted"], [])

    def test_tombstones_share_a_stamp_across_pages(self):
        for code in "ABC":
            self.add_tombstone("Item", code)

        pages, _ = self.walk("items", limit=2)

        self.assertEqual(self.deleted(pages), list("ABC"))

    def test_tombstones_page_independently_of_rows(self):
        self.add_item("A")
        for code in "XYZ":
            self.add_tombstone("Item", code)

        pages, _ = self.walk("items", limit=1)

        self.assertEqual(self.codes(pages), ["A"])
        self.assertEqual(self.deleted(pages), list("XYZ"))

    def test_deletion_after_a_walk_arrives_on_the_next(self):
        self.add_item("A")
        _, cursor = self.walk("items")

        self.db.delete("Item", "A")
        self.add_tombstone("Item", "A", creation="2026-02-01 10:00:00.000000")

        self.assertEqual(pull("items", "Main", cursor)["deleted"], ["A"])


class TestCommitLag(NoSiteTestCase):
    def test_finished_walk_steps_back_from_fresh_rows(self):
        fresh = str(NOW - timedelta(minutes=1))
        self.add_item("A", modified=fresh)

        page = pull("items", "Main")

        self.assertEqual(json.loads(page["next_cursor"])["modified"], str(NOW - sync_pull.COMMIT_LAG))

    def test_late_commit_behind_the_cursor_is_read_next_time(self):
        self.add_item("A", modified=str(NOW - timedelta(minutes=1)))
        _, cursor = self.walk("items")

        self.add_item("LATE", modified=str(NOW - timedelta(minutes=2)))
        pages, _ = self.walk("items", cursor)

        self.assertIn("LATE", self.codes(pages))

    def test_old_rows_are_not_read_again(self):
        self.add_item("A")
        _, cursor = self.walk("items")

        self.assertEqual(pull("items", "Main", cursor)["rows"], [])

    def test_unfinished_walk_never_steps_back(self):
        fresh = str(NOW - timedelta(minutes=1))
        for code in "ABC":
            self.add_item(code, modified=fresh)

        page = pull("items", "Main", limit=1)

        self.assertEqual(json.loads(page["next_cursor"]), {
            "modified": fresh, "name": "A", "deleted_at": sync_pull._BEGINNING, "deleted": "",
        })


class TestItemPrices(NoSiteTestCase):
    def started(self):
        return pull("item_prices", "Main")["next_cursor"]

    def add_price(self, name, item_code, price_list="Retail", modified=None):
        self.db.insert(
            "Item Price", name=name, item_code=item_code, price_list=price_list,
            modified=modified or str(NOW + timedelta(minutes=1)),
        )

    def test_first_pull_downloads_nothing_because_item_rows_carry_prices(self):
        self.add_item("A")
        self.add_price("P1", "A", modified=LONG_AGO)

        page = pull("item_prices", "Main")

        self.assertEqual((page["rows"], page["has_more"]), ([], False))
        self.assertTrue(page["next_cursor"])

    def test_first_pull_position_covers_commits_still_landing(self):
        cursor = json.loads(self.started())

        self.assertEqual(cursor["modified"], str(NOW - sync_pull.COMMIT_LAG))

    def test_changed_price_returns_the_whole_item_row(self):
        self.add_item("A")
        cursor = self.started()
        self.add_price("P1", "A")

        page = pull("item_prices", "Main", cursor)

        self.assertEqual(self.codes([page]), ["A"])
        self.assertEqual(page["rows"][0]["rate"], 10)

    def test_many_prices_of_one_item_return_one_row(self):
        self.add_item("A")
        cursor = self.started()
        self.add_price("P1", "A")
        self.add_price("P2", "A")

        self.assertEqual(self.codes([pull("item_prices", "Main", cursor)]), ["A"])

    def test_another_price_list_is_ignored(self):
        self.add_item("A")
        cursor = self.started()
        self.add_price("P1", "A", price_list="Wholesale")

        self.assertEqual(pull("item_prices", "Main", cursor)["rows"], [])

    def test_deleted_price_refreshes_the_item(self):
        self.add_item("A")
        cursor = self.started()
        self.add_tombstone(
            "Item Price", "P1", str(NOW + timedelta(minutes=1)), {"item_code": "A", "price_list": "Retail"}
        )

        self.assertEqual(self.codes([pull("item_prices", "Main", cursor)]), ["A"])

    def test_deleted_price_of_another_list_is_ignored(self):
        self.add_item("A")
        cursor = self.started()
        self.add_tombstone(
            "Item Price", "P1", str(NOW + timedelta(minutes=1)), {"item_code": "A", "price_list": "Wholesale"}
        )

        self.assertEqual(pull("item_prices", "Main", cursor)["rows"], [])

    def test_price_of_an_item_outside_the_profile_is_dropped(self):
        self.add_item("OFF", disabled=1)
        cursor = self.started()
        self.add_price("P1", "OFF")

        page = pull("item_prices", "Main", cursor)

        self.assertEqual((page["rows"], page["deleted"]), ([], []))


class TestCustomers(NoSiteTestCase):
    def add_customer(self, name, **values):
        self.db.insert("Customer", name=name, customer_name=name, modified=LONG_AGO, **values)

    def test_returns_the_cached_fields(self):
        self.add_customer("C1", mobile_no="0500")

        row = pull("customers", "Main")["rows"][0]

        self.assertEqual(set(row), {"name", "customer_name", "mobile_no", "email_id", "disabled"})

    def test_disabled_customer_is_reported_as_deleted(self):
        self.add_customer("OFF", disabled=1)

        page = pull("customers", "Main")

        self.assertEqual((page["rows"], page["deleted"]), ([], ["OFF"]))

    def test_customer_outside_the_profile_group_is_reported_as_deleted(self):
        self.profile.customer_group = "Retail"
        self.add_customer("IN", customer_group="Retail")
        self.add_customer("OUT", customer_group="Wholesale")

        page = pull("customers", "Main")

        self.assertEqual([row["name"] for row in page["rows"]], ["IN"])
        self.assertEqual(page["deleted"], ["OUT"])

    def test_deleted_customer_is_reported(self):
        self.add_tombstone("Customer", "GONE")

        self.assertEqual(pull("customers", "Main")["deleted"], ["GONE"])

    def test_rows_sharing_a_modified_value_survive_page_boundaries(self):
        for name in ("C1", "C2", "C3"):
            self.add_customer(name)

        pages, _ = self.walk("customers", limit=1)

        self.assertEqual([row["name"] for page in pages for row in page["rows"]], ["C1", "C2", "C3"])


class TestWholeSets(NoSiteTestCase):
    def test_taxes_come_as_one_page(self):
        with patch("pos_next.api.sync_pull._get_tax_rows", return_value=[{"rate": 15}]):
            page = pull("taxes", "Main")

        self.assertEqual(page, {"rows": [{"rate": 15}], "deleted": [], "next_cursor": None, "has_more": False})

    def test_payment_methods_come_as_one_page(self):
        with patch("pos_next.api.sync_pull.get_payment_methods", return_value=[{"mode_of_payment": "Cash"}]):
            self.assertEqual(pull("payment_methods", "Main")["rows"], [{"mode_of_payment": "Cash"}])

    def test_profile_data_comes_as_one_row(self):
        with patch("pos_next.api.sync_pull.get_pos_profile_data", return_value={"pos_profile": {}}):
            self.assertEqual(pull("pos_profile", "Main")["rows"], [{"pos_profile": {}}])

    def test_offers_come_as_one_page(self):
        with patch("pos_next.api.sync_pull._get_offers", return_value=[{"name": "O1"}]):
            self.assertEqual(pull("offers", "Main")["rows"], [{"name": "O1"}])

    def test_failed_taxes_raise_instead_of_erasing_the_device_copy(self):
        with patch("frappe.get_cached_doc", side_effect=[self.profile, RuntimeError("cache down")]):
            with self.assertRaises(RuntimeError):
                pull("taxes", "Main")

    def test_failed_offers_raise_instead_of_erasing_the_device_copy(self):
        with patch("frappe.get_doc", side_effect=RuntimeError("db down")):
            with self.assertRaises(RuntimeError):
                pull("offers", "Main")

    def test_public_get_taxes_still_answers_empty_on_failure(self):
        with patch("frappe.get_cached_doc", side_effect=RuntimeError("cache down")), patch("frappe.log_error"):
            with patch("frappe.get_traceback", return_value=""):
                self.assertEqual(get_taxes("Main"), [])


class TestManifest(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.add_item("A")
        self.db.insert("Sales Taxes and Charges Template", name="VAT", modified=LONG_AGO)

    def moved(self, change):
        """Entities whose version differs after a change."""
        before = get_manifest("Main")
        change()
        after = get_manifest("Main")
        return {
            entity for entity in sync_pull._WALKED.keys() | sync_pull._WHOLE_SETS.keys()
            if before[entity] != after[entity]
        }

    def test_reports_every_entity(self):
        manifest = get_manifest("Main")

        for entity in sync_pull._WALKED.keys() | sync_pull._WHOLE_SETS.keys():
            self.assertIsInstance(manifest[entity], str)

    def test_nothing_changed_means_nothing_moves(self):
        self.assertEqual(self.moved(lambda: None), set())

    def test_edited_item_moves_only_items(self):
        self.assertEqual(
            self.moved(lambda: self.db.update("Item", "A", modified="2026-02-01 10:00:00.000000")), {"items"}
        )

    def test_new_item_moves_items_even_with_an_old_stamp(self):
        self.assertEqual(self.moved(lambda: self.add_item("B")), {"items"})

    def test_tombstone_moves_items(self):
        self.assertEqual(self.moved(lambda: self.add_tombstone("Item", "GONE")), {"items"})

    def test_price_moves_only_item_prices(self):
        self.assertEqual(
            self.moved(lambda: self.db.insert(
                "Item Price", name="P1", item_code="A", price_list="Retail", modified=LONG_AGO
            )),
            {"item_prices"},
        )

    def test_price_in_another_list_moves_nothing(self):
        self.assertEqual(
            self.moved(lambda: self.db.insert(
                "Item Price", name="P1", item_code="A", price_list="Wholesale", modified=LONG_AGO
            )),
            set(),
        )

    def test_customer_moves_only_customers(self):
        self.assertEqual(
            self.moved(lambda: self.db.insert("Customer", name="C1", modified=LONG_AGO)), {"customers"}
        )

    def test_tax_template_edit_moves_only_taxes(self):
        self.assertEqual(
            self.moved(lambda: self.db.update(
                "Sales Taxes and Charges Template", "VAT", modified="2026-02-01 10:00:00.000000"
            )),
            {"taxes"},
        )

    def test_changing_the_profile_template_moves_taxes(self):
        self.assertIn("taxes", self.moved(lambda: setattr(self.profile, "taxes_and_charges", "GST")))

    def test_profile_edit_moves_profile_and_payment_methods(self):
        self.assertEqual(
            self.moved(lambda: setattr(self.profile, "modified", "2026-02-01 10:00:00.000000")),
            {"pos_profile", "payment_methods"},
        )

    def test_pos_settings_edit_moves_the_profile(self):
        self.assertEqual(
            self.moved(lambda: self.db.insert("POS Settings", name="S1", modified=LONG_AGO)), {"pos_profile"}
        )

    def test_new_day_moves_only_offers(self):
        self.assertEqual(self.moved(lambda: setattr(self, "today", "2026-11-07")), {"offers"})

    def test_pricing_rule_moves_only_offers(self):
        self.assertEqual(
            self.moved(lambda: self.db.insert("Pricing Rule", name="R1", modified=LONG_AGO)), {"offers"}
        )

    def test_other_profile_gets_other_versions(self):
        before = get_manifest("Main")
        self.profile.name = "Second"
        after = get_manifest("Second")

        self.assertNotEqual(before["taxes"], after["taxes"])
        self.assertNotEqual(before["scopes"]["items"], after["scopes"]["items"])

    def test_removing_a_group_moves_the_item_scope_not_the_version(self):
        before = get_manifest("Main")
        self.profile.item_groups = [frappe._dict(item_group="Drinks")]
        after = get_manifest("Main")

        self.assertNotEqual(before["scopes"]["items"], after["scopes"]["items"])
        self.assertEqual(before["items"], after["items"])

    def test_a_new_child_group_moves_the_item_scope(self):
        before = get_manifest("Main")
        self.groups["Food"].append("Frozen")

        self.assertNotEqual(before["scopes"]["items"], get_manifest("Main")["scopes"]["items"])

    def test_scope_covers_price_list_and_warehouse(self):
        for field, value in (("selling_price_list", "Wholesale"), ("warehouse", "Shop")):
            before = get_manifest("Main")["scopes"]
            setattr(self.profile, field, value)
            after = get_manifest("Main")["scopes"]
            self.assertNotEqual(before["items"], after["items"], field)
            self.assertNotEqual(before["item_prices"], after["item_prices"], field)

    def test_a_scope_walk_reports_stale_rows_without_any_item_changing(self):
        self.add_item("LEFT", item_group="Snacks")
        self.groups["Food"].remove("Snacks")

        page = pull("items", "Main")

        self.assertIn("LEFT", page["deleted"])


class TestRename(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch("frappe.get_doc", side_effect=self.tombstone)
        self.mock_get_doc = patcher.start()
        self.addCleanup(patcher.stop)

    def tombstone(self, **values):
        def db_insert():
            self.add_tombstone(values["deleted_doctype"], values["deleted_name"], str(NOW + timedelta(minutes=1)))

        return Mock(db_insert=db_insert)

    def rename(self, old, new, merge=False):
        self.db.update("Item", old, name=new)
        record_rename(Mock(doctype="Item"), "after_rename", old, new, merge)

    def test_old_name_leaves_and_new_name_arrives(self):
        self.add_item("OLD")
        _, cursor = self.walk("items")

        self.rename("OLD", "NEW")
        page = pull("items", "Main", cursor)

        self.assertEqual(self.codes([page]), ["NEW"])
        self.assertEqual(page["deleted"], ["OLD"])

    def test_tombstone_cannot_be_restored_from_the_desk(self):
        self.add_item("OLD")

        self.rename("OLD", "NEW")

        values = self.mock_get_doc.call_args.kwargs
        self.assertEqual(values["doctype"], "Deleted Document")
        self.assertEqual((values["restored"], values["new_name"]), (1, "NEW"))

    def test_merge_leaves_the_tombstone_to_delete_doc(self):
        self.add_item("OLD")

        record_rename(Mock(doctype="Item"), "after_rename", "OLD", "NEW", True)

        self.mock_get_doc.assert_not_called()

    def test_hooks_register_the_handler(self):
        from pos_next import hooks

        handler = "pos_next.api.sync_pull.record_rename"
        self.assertEqual(hooks.doc_events["Item"]["after_rename"], handler)
        self.assertEqual(hooks.doc_events["Customer"]["after_rename"], handler)


if __name__ == "__main__":
    unittest.main()
