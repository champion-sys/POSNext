# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Who may change what in POS Settings, whichever way the save arrives."""

import json
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import frappe

from pos_next.pos_next.doctype.pos_settings import pos_settings
from pos_next.pos_next.doctype.pos_settings.pos_settings import (
    ALERT_STATE_FIELD,
    MANAGER_ONLY_FIELDS,
    POSSettings,
)

CASHIER = ["POSNext Cashier"]
SUPERVISOR = ["POSNext Cashier", "Shift Supervisor"]
MANAGER = ["Nexus POS Manager"]

#: Display and device preferences. Nothing on the server depends on them and none holds a
#: cashier back. A new field goes here or in MANAGER_ONLY_FIELDS, or a test below fails.
PREFERENCES = (
    "allowed_locales",
    "default_card_view",
    "display_barcode",
    "display_discount_amount",
    "display_discount_percentage",
    "display_item_code",
    "input_qty",
    "realtime_timeout_seconds",
    "search_limit",
    "show_customer_balance",
    "show_variants_as_items",
    "silent_print",
    "sync_interval_minutes",
    "sync_mode",
    "use_limit_search",
    "use_percentage_discount",
)

SERVER_FIELDS = {
    "sync_alert_recipients": "boss@example.com",
    "sync_payload_retention_days": 90,
    "sync_alert_last_sent_at": "2026-11-07 10:00:00",
}


def _read_fields():
    folder = Path(pos_settings.__file__).parent
    fields = json.loads((folder / "pos_settings.json").read_text())["fields"]
    customized = json.loads((folder.parents[1] / "custom" / "pos_settings.json").read_text())["custom_fields"]
    return [frappe._dict(field) for field in (*fields, *customized)]


FIELDS = _read_fields()
LAYOUT = ("Section Break", "Column Break", "Tab Break")


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class FakeSettings(frappe._dict):
    meta = frappe._dict(fields=FIELDS)
    _get_changed_fields = POSSettings._get_changed_fields

    def get_doc_before_save(self):
        return self.get("before")

    def set(self, fieldname, value):
        self[fieldname] = value


def _validate(roles, before=None, **values):
    if before is None:
        values = {**{field.fieldname: field.default for field in FIELDS if field.default}, **values}

    doc = FakeSettings(values)
    doc.before = None if before is None else frappe._dict(before)
    with (
        patch("frappe.get_roles", return_value=roles),
        patch("frappe.throw", _raise),
        patch("frappe._", lambda text: text),
    ):
        POSSettings.validate_sync_housekeeping(doc)
        POSSettings.validate_who_may_change(doc)
    return doc


class TestWhoMayChangeThem(unittest.TestCase):
    ALLOWED = {"role_allowed_to_access_settings_in_pos": "Shift Supervisor"}

    @staticmethod
    def _changed(field):
        """A value this field does not hold yet, as the form would send it."""
        if field.fieldtype in ("Table", "Table MultiSelect"):
            return [Mock(get_valid_dict=Mock(return_value={"barcode_rule": "Weighed"}))]
        if field.fieldtype in ("Check", "Int", "Float"):
            return 1
        return "changed@example.com"

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

    def test_a_cashier_with_the_role_cannot_change_a_single_control(self):
        for fieldname in MANAGER_ONLY_FIELDS:
            if fieldname == "role_allowed_to_access_settings_in_pos":
                continue
            field = next(field for field in FIELDS if field.fieldname == fieldname)
            with self.subTest(fieldname), self.assertRaises(frappe.PermissionError):
                _validate(SUPERVISOR, before=self.ALLOWED, **self.ALLOWED, **{fieldname: self._changed(field)})

    def test_the_refusal_says_which_fields(self):
        with self.assertRaises(frappe.PermissionError) as refused:
            _validate(SUPERVISOR, before=self.ALLOWED, **self.ALLOWED, allow_delete_offline_invoice=1, silent_print=1)

        self.assertIn("Allow Delete Offline Invoice", str(refused.exception))
        self.assertNotIn("Silent Print", str(refused.exception))

    def test_a_control_cannot_ride_in_with_a_change_a_cashier_may_make(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(SUPERVISOR, before=self.ALLOWED, **self.ALLOWED, sync_mode="Periodic", allow_credit_sale=1)

    def test_a_cashier_cannot_name_their_own_role_on_the_way_in(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(CASHIER, before={}, role_allowed_to_access_settings_in_pos="POSNext Cashier", sync_mode="Periodic")

    def test_a_cashier_with_the_role_saves_what_is_theirs(self):
        before = {**self.ALLOWED, "sync_alert_recipients": "boss@example.com", "sync_payload_retention_days": 90}
        _validate(SUPERVISOR, before=before, **before, sync_mode="Periodic", silent_print=1)

    def test_a_cashier_without_the_role_changes_nothing(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(CASHIER, before=self.ALLOWED, **self.ALLOWED, sync_mode="Periodic")

    def test_with_no_role_named_only_a_manager_may(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(SUPERVISOR, before={}, sync_mode="Periodic")
        _validate(MANAGER, before={}, sync_mode="Periodic")

    def test_a_save_that_changes_nothing_needs_no_role_at_all(self):
        before = {"allow_credit_sale": 1, "sync_total_tolerance": 0.05}
        _validate(CASHIER, before=before, **before)

    def test_a_value_comes_back_in_whatever_form_the_screen_holds_it(self):
        for before, sent in (
            ({"sync_total_tolerance": 0.05}, {"sync_total_tolerance": "0.05"}),
            ({"max_discount_allowed": 10.0}, {"max_discount_allowed": "10"}),
            ({"allow_credit_sale": 1}, {"allow_credit_sale": True}),
            ({"allow_return": 0}, {"allow_return": False}),
            ({"allow_return": None}, {"allow_return": 0}),
            ({"return_validity_days": 7}, {"return_validity_days": 7.0}),
            ({"decimal_precision": "2"}, {"decimal_precision": 2}),
            ({"wallet_account": None}, {"wallet_account": ""}),
        ):
            with self.subTest(sent):
                _validate(CASHIER, before=before, **sent)

    def test_a_table_read_back_is_no_change(self):
        rule = {"barcode_rule": "Weighed", "disable": "0"}
        stored = Mock(get_valid_dict=Mock(return_value={"name": "x", "parent": "Main", "modified": "today", **rule}))
        sent = Mock(get_valid_dict=Mock(return_value={"name": "y", "parent": "Main", "modified": "now", **rule}))

        _validate(CASHIER, before={"barcode_rules": [stored]}, barcode_rules=[sent])

    def test_a_new_record_for_the_pos_needs_no_manager(self):
        _validate(CASHIER, pos_profile="Main")

    def test_a_new_record_away_from_the_defaults_does(self):
        with self.assertRaises(frappe.PermissionError):
            _validate(CASHIER, pos_profile="Main", allow_credit_sale=1)

    def test_a_manager_can_change_them(self):
        _validate(MANAGER, before={}, sync_payload_retention_days=90, sync_alert_recipients="boss@example.com")

    def test_a_system_manager_can_change_them(self):
        _validate(["System Manager"], before={}, sync_payload_retention_days=90)

    def test_a_manager_needs_no_role_named(self):
        _validate(MANAGER, before=self.ALLOWED, **self.ALLOWED, allow_credit_sale=1)


class TestEveryFieldIsClassed(unittest.TestCase):
    def test_every_field_is_classed(self):
        fields = {field.fieldname for field in FIELDS if field.fieldtype not in LAYOUT and field.fieldname}
        classed = {*MANAGER_ONLY_FIELDS, *PREFERENCES, ALERT_STATE_FIELD}

        self.assertEqual(fields - classed, set(), "new fields need a side")
        self.assertEqual(classed - fields, set(), "these are not fields")

    def test_nothing_is_on_both_sides(self):
        self.assertEqual(set(MANAGER_ONLY_FIELDS) & set(PREFERENCES), set())


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

    def setUp(self):
        self.addCleanup(setattr, frappe.local, "session", getattr(frappe.local, "session", None))
        self.addCleanup(setattr, frappe.local, "db", getattr(frappe.local, "db", None))
        frappe.local.session = Mock(user="cashier@example.com")
        frappe.local.db = MagicMock()

        self.roles = CASHIER
        self.meta = Mock(has_field=lambda fieldname: any(field.fieldname == fieldname for field in FIELDS))
        for target, replacement in (
            ("frappe.get_roles", lambda: self.roles),
            ("frappe.get_meta", lambda _doctype: self.meta),
            ("frappe.throw", _raise),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _load(self):
        stored = frappe._dict({"pos_profile": "Main", "sync_mode": "Realtime", **SERVER_FIELDS})
        frappe.local.db.get_value.return_value = stored
        return pos_settings.get_pos_settings("Main")

    def _save(self, settings):
        self.doc = MagicMock()
        self.doc.as_dict.return_value = frappe._dict(sync_mode="Periodic", **SERVER_FIELDS)
        with patch("frappe.get_doc", return_value=self.doc):
            return pos_settings.update_pos_settings("Main", json.dumps(settings))

    def test_it_is_not_given_them(self):
        settings = self._load()

        self.assertEqual(settings.sync_mode, "Realtime")
        self.assertFalse(set(SERVER_FIELDS) & set(settings))

    def test_it_is_told_what_this_user_may_only_look_at(self):
        self.assertEqual(self._load()._manager_only_fields, list(MANAGER_ONLY_FIELDS))

    def test_a_manager_may_only_look_at_nothing(self):
        self.roles = MANAGER
        self.assertEqual(self._load()._manager_only_fields, [])

    def test_a_save_from_the_pos_cannot_write_them(self):
        answer = self._save({"sync_mode": "Periodic", **SERVER_FIELDS})

        self.doc.update.assert_called_once_with({"sync_mode": "Periodic"})
        self.assertFalse(set(SERVER_FIELDS) & set(answer))

    def test_what_the_load_added_does_not_go_back_in(self):
        self._save({"sync_mode": "Periodic", "_manager_only_fields": ["x"], "_global_allow_negative_stock": 0})
        self.doc.update.assert_called_once_with({"sync_mode": "Periodic"})

    def test_a_request_cannot_point_the_save_at_another_record(self):
        self._save({"name": "Other", "pos_profile": "Other", "doctype": "User", "owner": "x", "sync_mode": "Periodic"})
        self.doc.update.assert_called_once_with({"sync_mode": "Periodic"})

    def test_a_stale_screen_is_still_caught(self):
        self._save({"modified": "2026-11-07 10:00:00", "sync_mode": "Periodic"})
        self.doc.update.assert_called_once_with({"modified": "2026-11-07 10:00:00", "sync_mode": "Periodic"})

    def test_writing_the_doctype_is_not_access_to_every_profile(self):
        frappe.local.db.exists.return_value = None
        with (
            patch("frappe.has_permission", side_effect=lambda doctype, _ptype: doctype == "POS Settings"),
            self.assertRaises(frappe.ValidationError),
        ):
            self._save({"sync_mode": "Periodic"})
        self.doc.save.assert_not_called()


class TestTheScreen(unittest.TestCase):
    def test_every_control_on_the_screen_that_is_manager_only_is_locked_there(self):
        screen = Path(pos_settings.__file__).parents[4] / "POS/src/components/settings/POSSettings.vue"
        text = screen.read_text()

        for fieldname in MANAGER_ONLY_FIELDS:
            if f'v-model="settings.{fieldname}"' in text:
                self.assertIn(f":disabled=\"isManagerOnly('{fieldname}')\"", text, fieldname)
