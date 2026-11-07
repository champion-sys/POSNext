# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Who may reach the settings that send mail out and erase records for good."""

import json
import unittest
from unittest.mock import MagicMock, Mock, patch

import frappe

from pos_next.pos_next.doctype.pos_settings import pos_settings
from pos_next.pos_next.doctype.pos_settings.pos_settings import POSSettings

CASHIER = ["POSNext Cashier"]
MANAGER = ["Nexus POS Manager"]


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class FakeSettings(frappe._dict):
    def get_doc_before_save(self):
        return self.get("before")

    def set(self, fieldname, value):
        self[fieldname] = value


def _validate(roles, before=None, **values):
    doc = FakeSettings(values)
    doc.before = None if before is None else frappe._dict(before)
    with (
        patch("frappe.get_roles", return_value=roles),
        patch("frappe.throw", _raise),
        patch("frappe._", lambda text: text),
    ):
        POSSettings.validate_sync_housekeeping(doc)
    return doc


class TestWhoMayChangeThem(unittest.TestCase):
    def test_a_cashier_cannot_start_erasing_records(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(CASHIER, before={"sync_payload_retention_days": 0}, sync_payload_retention_days=1)

    def test_a_cashier_cannot_send_the_alerts_elsewhere(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(
                CASHIER,
                before={"sync_alert_recipients": "boss@example.com"},
                sync_alert_recipients="me@example.com",
            )

    def test_a_cashier_cannot_set_them_on_a_new_record(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(CASHIER, sync_payload_retention_days=1)

    def test_a_cashier_saves_everything_else_as_before(self):
        _validate(
            CASHIER,
            before={"sync_alert_recipients": "boss@example.com", "sync_payload_retention_days": 90},
            sync_alert_recipients="boss@example.com",
            sync_payload_retention_days=90,
        )

    def test_a_new_record_for_the_pos_needs_no_manager(self):
        _validate(CASHIER)

    def test_a_manager_can_change_them(self):
        _validate(MANAGER, before={}, sync_payload_retention_days=90, sync_alert_recipients="boss@example.com")

    def test_a_system_manager_can_change_them(self):
        _validate(["System Manager"], before={}, sync_payload_retention_days=90)


class TestValues(unittest.TestCase):
    def test_a_bad_address_is_refused(self):
        with self.assertRaises(frappe.InvalidEmailAddressError):
            _validate(MANAGER, before={}, sync_alert_recipients="boss@example.com, nonsense")

    def test_addresses_one_per_line_are_accepted(self):
        _validate(MANAGER, before={}, sync_alert_recipients="a@example.com\nb@example.com")

    def test_a_form_opened_before_the_job_ran_cannot_move_its_time(self):
        doc = _validate(
            MANAGER,
            before={"sync_alert_last_sent_at": "2026-11-07 10:00:00"},
            sync_alert_last_sent_at="2026-11-01 10:00:00",
        )
        self.assertEqual(doc.sync_alert_last_sent_at, "2026-11-07 10:00:00")

    def test_no_one_can_set_the_time_on_a_new_record(self):
        self.assertIsNone(_validate(MANAGER, sync_alert_last_sent_at="2026-11-01 10:00:00").sync_alert_last_sent_at)


class TestThePos(unittest.TestCase):
    """The POS screen loads every field it is given and sends them all back on save."""

    SERVER_FIELDS = {
        "sync_alert_recipients": "boss@example.com",
        "sync_payload_retention_days": 90,
        "sync_alert_last_sent_at": "2026-11-07 10:00:00",
    }

    def setUp(self):
        self.addCleanup(setattr, frappe.local, "session", getattr(frappe.local, "session", None))
        self.addCleanup(setattr, frappe.local, "db", getattr(frappe.local, "db", None))
        frappe.local.session = Mock(user="cashier@example.com")
        frappe.local.db = MagicMock()

    def test_it_is_not_given_them(self):
        stored = frappe._dict({"pos_profile": "Main", "sync_mode": "Realtime", **self.SERVER_FIELDS})
        frappe.local.db.get_value.return_value = stored

        settings = pos_settings.get_pos_settings("Main")

        self.assertEqual(settings.sync_mode, "Realtime")
        self.assertFalse(set(self.SERVER_FIELDS) & set(settings))

    def test_a_save_from_the_pos_cannot_write_them(self):
        doc = MagicMock()
        doc.as_dict.return_value = frappe._dict(sync_mode="Periodic", **self.SERVER_FIELDS)

        with patch("frappe.get_doc", return_value=doc):
            answer = pos_settings.update_pos_settings("Main", json.dumps({"sync_mode": "Periodic", **self.SERVER_FIELDS}))

        doc.update.assert_called_once_with({"sync_mode": "Periodic"})
        self.assertFalse(set(self.SERVER_FIELDS) & set(answer))
