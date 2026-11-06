# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe

from pos_next.api import sync

CASHIER = "cashier@example.com"
THIS_DEVICE = "device-this-one"
OTHER_DEVICE = "device-another-one"
BROWSER = "browser-own-uuid"


class NoSiteTestCase(unittest.TestCase):
    """Runs push on the real inbox code, with the database and document replaced."""

    def setUp(self):
        self.enrolled = {THIS_DEVICE, OTHER_DEVICE}
        self.stored = []

        frappe.local.session = frappe._dict(user=CASHIER)
        frappe.local.message_log = []
        frappe.local.db = Mock()
        frappe.local.db.exists = Mock(side_effect=self._exists)
        frappe.local.db.get_value = Mock(side_effect=self._get_value)
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)
        self.addCleanup(setattr, frappe.local, "pos_device", None)

        for target, replacement in (
            ("pos_next.api.sync.assert_device_allows_profile", Mock()),
            ("pos_next.api.sync._assert_invoice_write_access", Mock()),
            ("pos_next.services.sync_inbox.frappe.get_doc", self._new_document),
            ("pos_next.services.sync_inbox.enqueue_processing", Mock()),
            ("pos_next.services.sync_inbox.now_datetime", datetime.now),
            ("pos_next.api.sync.frappe.utils.now", lambda: "2026-11-06 12:00:00"),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _exists(self, doctype, name=None):
        if doctype == "POS Device":
            return name if name in self.enrolled else None
        return "row-1"

    def _get_value(self, _doctype, filters=None, fieldname="name", as_dict=False, **_kwargs):
        if isinstance(filters, dict):
            return None
        if fieldname == "pos_profile":
            return "Main"
        return frappe._dict(offline_id="sale-1", status="Received", sales_invoice=None)

    def _new_document(self, values):
        self.stored.append(values)
        document = Mock()
        document.name = f"inbox-{len(self.stored)}"
        return document

    def _push(self, **arguments):
        item = {"offline_id": "sale-1", "pos_profile": "Main", "payload": {"customer": "Walk-in"}}
        return sync.push(items=[item], **arguments)

    def _recorded_device(self):
        self.assertEqual(len(self.stored), 1)
        return self.stored[0]["device_id"]


class TestDeviceWithGrant(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        frappe.local.pos_device = THIS_DEVICE

    def test_records_the_device_the_grant_belongs_to(self):
        self._push(device_id=THIS_DEVICE)
        self.assertEqual(self._recorded_device(), THIS_DEVICE)

    def test_cannot_record_under_another_device(self):
        self._push(device_id=OTHER_DEVICE)
        self.assertEqual(self._recorded_device(), THIS_DEVICE)

    def test_cannot_record_under_a_made_up_id(self):
        self._push(device_id="made-up")
        self.assertEqual(self._recorded_device(), THIS_DEVICE)

    def test_naming_no_device_changes_nothing(self):
        self._push()
        self.assertEqual(self._recorded_device(), THIS_DEVICE)

    def test_the_sale_is_still_stored_when_the_id_was_wrong(self):
        result = self._push(device_id=OTHER_DEVICE)
        self.assertEqual(result["results"][0]["status"], "received")


class TestBrowserWithoutGrant(NoSiteTestCase):
    def test_keeps_the_id_the_browser_chose(self):
        self._push(device_id=BROWSER)
        self.assertEqual(self._recorded_device(), BROWSER)

    def test_works_without_an_id(self):
        result = self._push()
        self.assertIsNone(self._recorded_device())
        self.assertEqual(result["results"][0]["status"], "received")

    def test_cannot_borrow_an_enrolled_device_by_logging_in_with_a_cookie(self):
        result = self._push(device_id=OTHER_DEVICE)
        self.assertIsNone(self._recorded_device())
        self.assertEqual(result["results"][0]["status"], "received")
