# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Payload retention, on an in-memory stand-in for the table."""

import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import frappe

from pos_next import hooks
from pos_next.pos_next.doctype.pos_settings import pos_settings
from pos_next.services import sync_inbox, sync_reconciliation, sync_retention
from pos_next.services.sync_entities import DOCTYPE
from pos_next.tasks import sync as sync_tasks

NOW = datetime(2026, 11, 7, 12, 0)
PAYLOAD = '{"customer": "Sara"}'
HASH = sync_inbox.compute_payload_hash({"customer": "Sara"})

UNFINISHED = ("Needs Review", "Blocked", "Received", "Processing", "Retry Scheduled")


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


def _record(name, days_old=120, status="Synced", pos_profile="Main", **values):
    stamp = NOW - timedelta(days=days_old)
    row = {
        "name": name,
        "offline_id": f"pos_offline_{name}",
        "status": status,
        "pos_profile": pos_profile,
        "creation": stamp,
        "modified": stamp,
        "payload": PAYLOAD,
        "original_payload": PAYLOAD,
        "payload_hash": HASH,
        "client_grand_total": 25.0,
        "server_grand_total": 25.0,
        "depends_on": "",
    }
    return frappe._dict({**row, **values})


def _operator_matches(value, operator, operand):
    if operator == "=":
        return value == operand
    if operator == "in":
        return value in operand
    if operator == ">":
        return value is not None and value > operand
    if operator == "<":
        return value is not None and value < operand
    if operator == ">=":
        return value is not None and value >= operand
    raise AssertionError(f"The fake does not know {operator}")


class FakeTable:
    def __init__(self, rows=(), settings=None, attempts=None):
        self.rows = {row.name: row for row in rows}
        self.settings = {"Main": 90} if settings is None else settings
        self.attempts = dict(attempts or {})
        self.lines = []
        self.commits = 0
        self.rollbacks = 0
        self.batches = []
        self.reads = []
        self.updates = []

    @staticmethod
    def _as_conditions(filters):
        if isinstance(filters, dict):
            return [
                [field, *(expected if isinstance(expected, list) else ["=", expected])]
                for field, expected in filters.items()
            ]
        return filters

    def _matching(self, filters):
        conditions = self._as_conditions(filters)
        return [
            row
            for row in self.rows.values()
            if all(_operator_matches(row.get(field), operator, operand) for field, operator, operand in conditions)
        ]

    def get_all(self, doctype, filters=None, fields=None, or_filters=None, limit=None, **kwargs):
        if doctype == "POS Settings":
            return [
                frappe._dict(pos_profile=profile, sync_payload_retention_days=days)
                for profile, days in self.settings.items()
                if _operator_matches(days, *filters["sync_payload_retention_days"])
            ]

        if doctype == sync_retention.ATTEMPT_DOCTYPE:
            return [
                frappe._dict(parent=parent, idx=idx)
                for parent, idx in self.attempts.items()
                if parent in filters["parent"][1]
            ]

        self.reads.append(filters)
        rows = self._matching(filters)
        if or_filters:
            rows = [row for row in rows if any(row.get(condition[0]) for condition in or_filters)]
        rows.sort(key=lambda row: row.creation)
        return [frappe._dict(name=row.name, creation=row.creation) for row in rows[:limit]]

    def set_value(self, doctype, filters, values, update_modified=True, **_kwargs):
        names = filters["name"][1]
        self.batches.append(list(names))
        self.updates.append({"filters": filters, "update_modified": update_modified})
        for row in self._matching(filters):
            row.update(values)
            if update_modified:
                row.modified = NOW

    def bulk_insert(self, doctype, fields, values):
        for value in values:
            self.lines.append(dict(zip(fields, value)))

    def commit(self):
        self.commits += 1

    def rollback(self, **_kwargs):
        self.rollbacks += 1


class RetentionCase(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, frappe.local, "session", getattr(frappe.local, "session", None))
        self.addCleanup(setattr, frappe.local, "db", getattr(frappe.local, "db", None))
        frappe.local.session = Mock(user="Administrator")
        self.log_error = Mock()

        for target, replacement in (
            ("frappe.throw", _raise),
            ("frappe.log_error", self.log_error),
            ("pos_next.services.sync_retention._", lambda text: text),
            ("pos_next.services.sync_inbox._", lambda text: text),
            ("pos_next.services.sync_retention.now_datetime", lambda: NOW),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, *rows, **kwargs):
        self.table = FakeTable(rows, **kwargs)
        frappe.local.db = self.table
        with patch("frappe.get_all", self.table.get_all):
            sync_tasks.clear_old_payloads()
        return self.table

    def assertCleared(self, row):
        self.assertFalse(row.payload)
        self.assertFalse(row.original_payload)

    def assertKept(self, row):
        self.assertEqual((row.payload, row.original_payload), (PAYLOAD, PAYLOAD))


class TestWhatIsCleared(RetentionCase):
    def test_finished_records_past_the_period_are_cleared(self):
        table = self._run(
            _record("synced"),
            _record("resolved", status="Resolved"),
            _record("voided", status="Voided"),
        )

        for row in table.rows.values():
            self.assertCleared(row)

    def test_an_unfinished_record_is_never_touched(self):
        table = self._run(*(_record(status.lower(), status=status) for status in UNFINISHED))

        for row in table.rows.values():
            self.assertKept(row)
        self.assertEqual(table.lines, [])

    def test_a_record_inside_the_period_stays(self):
        table = self._run(_record("recent", days_old=89))
        self.assertKept(table.rows["recent"])

    def test_the_period_counts_from_when_it_finished_not_from_the_sale(self):
        row = _record("waited")
        row.modified = NOW - timedelta(days=1)
        table = self._run(row)
        self.assertKept(table.rows["waited"])

    def test_zero_keeps_forever(self):
        table = self._run(_record("kept"), settings={"Main": 0})
        self.assertKept(table.rows["kept"])

    def test_a_negative_period_clears_nothing(self):
        table = self._run(_record("kept"), settings={"Main": -5})
        self.assertKept(table.rows["kept"])

    def test_no_settings_means_nothing_goes(self):
        table = self._run(_record("kept"), settings={})
        self.assertKept(table.rows["kept"])

    def test_each_profile_has_its_own_period(self):
        table = self._run(
            _record("short", days_old=40, pos_profile="Short"),
            _record("long", days_old=40, pos_profile="Long"),
            settings={"Short": 30, "Long": 90},
        )

        self.assertCleared(table.rows["short"])
        self.assertKept(table.rows["long"])

    def test_a_record_without_a_profile_has_no_period(self):
        table = self._run(_record("orphan", pos_profile=None))
        self.assertKept(table.rows["orphan"])

    def test_a_record_with_only_its_original_payload_left_is_cleared(self):
        table = self._run(_record("blanked", payload=None))
        self.assertCleared(table.rows["blanked"])

    def test_the_status_is_checked_again_when_writing(self):
        table = self._run(_record("synced"))
        self.assertEqual(table.updates[0]["filters"]["status"][1], sync_inbox.FINAL_STATES)


class TestWhatStays(RetentionCase):
    def test_the_row_the_hash_and_the_amounts_stay(self):
        table = self._run(_record("synced", depends_on="sale-1"))

        row = table.rows["synced"]
        self.assertEqual(row.payload_hash, HASH)
        self.assertEqual((row.client_grand_total, row.server_grand_total), (25.0, 25.0))
        self.assertEqual(row.depends_on, "sale-1")

    def test_clearing_does_not_restart_the_record_s_clock(self):
        table = self._run(_record("synced"))

        self.assertIs(table.updates[0]["update_modified"], False)
        self.assertEqual(table.rows["synced"].modified, NOW - timedelta(days=120))

    def test_the_clearing_is_logged_after_the_attempts_already_there(self):
        table = self._run(_record("synced"), attempts={"synced": 3})

        line = table.lines[0]
        self.assertEqual((line["parent"], line["idx"]), ("synced", 4))
        self.assertEqual(line["outcome"], sync_retention.OUTCOME_CLEARED)
        self.assertEqual((line["parenttype"], line["parentfield"]), (DOCTYPE, "attempt_log"))

    def test_a_first_attempt_line_starts_at_one(self):
        self.assertEqual(self._run(_record("synced")).lines[0]["idx"], 1)

    def test_a_shift_close_can_still_be_reconciled(self):
        table = self._run(_record("close", entity="shift_close", shift=None, depends_on="sale-1"))
        close = table.rows["close"]
        self.assertCleared(close)

        frappe.local.db = Mock()
        frappe.local.db.get_value.return_value = close
        with patch("frappe.get_all", return_value=[]):
            result = sync_reconciliation.get_shift_reconciliation("close")

        self.assertEqual([entry["offline_id"] for entry in result["entries"]], ["sale-1"])


class TestBatches(RetentionCase):
    def _run_in_batches(self, count, size=2):
        with patch.object(sync_retention, "BATCH_SIZE", size):
            return self._run(*(_record(f"row-{index}", days_old=120 + index) for index in range(count)))

    def test_it_works_in_batches(self):
        table = self._run_in_batches(5)

        self.assertEqual([len(batch) for batch in table.batches], [2, 2, 1])
        for row in table.rows.values():
            self.assertCleared(row)

    def test_it_commits_between_batches(self):
        self.assertEqual(self._run_in_batches(5).commits, 3)

    def test_oldest_first(self):
        self.assertEqual(self._run_in_batches(3).batches[0], ["row-2", "row-1"])

    def test_a_record_with_nothing_to_clear_ends_the_run(self):
        table = self._run(_record("online", payload=None, original_payload=None, payload_hash=None))

        self.assertEqual(table.batches, [])
        self.assertEqual(table.lines, [])

    def test_a_batch_starts_where_the_last_one_ended(self):
        table = self._run_in_batches(3)

        last_read = table.reads[-1]
        self.assertIn(["creation", ">=", NOW - timedelta(days=120)], last_read)

    def test_a_second_run_finds_nothing(self):
        table = self._run(_record("synced"))
        lines = len(table.lines)

        with patch("frappe.get_all", table.get_all):
            sync_tasks.clear_old_payloads()

        self.assertEqual(len(table.lines), lines)


class TestFailure(RetentionCase):
    def test_one_profile_failing_leaves_the_next_one_its_turn(self):
        real_clear = sync_retention._clear_profile

        def clear(pos_profile, days):
            if pos_profile == "Bad":
                raise RuntimeError("Lock wait timeout")
            real_clear(pos_profile, days)

        with patch.object(sync_retention, "_clear_profile", clear):
            table = self._run(_record("next", pos_profile="Next"), settings={"Bad": 30, "Next": 30})

        self.assertCleared(table.rows["next"])
        self.log_error.assert_called_once()
        self.assertEqual(table.rollbacks, 1)


class TestClearedRecord(RetentionCase):
    def _cleared(self, status="Synced", **values):
        row = MagicMock(status=status, payload=None, original_payload=None, payload_hash=HASH, **values)
        return patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row), row

    def _assert_refused(self, action, *args, status="Synced"):
        getter, row = self._cleared(status)
        with getter, patch.object(sync_inbox, "process") as process:
            with self.assertRaises(frappe.ValidationError) as caught:
                action("row-1", *args)

        self.assertIn("erased", str(caught.exception))
        process.assert_not_called()
        row.save.assert_not_called()

    def test_it_cannot_be_reprocessed(self):
        self._assert_refused(sync_inbox.reprocess, "note")

    def test_it_cannot_be_fixed(self):
        self._assert_refused(sync_inbox.apply_fix, "posting_date", {"posting_date": "2026-11-01"})

    def test_an_approval_that_never_reads_the_payload_is_refused_too(self):
        self._assert_refused(sync_inbox.apply_fix, "accept_total_difference", {})

    def test_status_set_back_by_hand_does_not_reopen_it(self):
        self._assert_refused(sync_inbox.reprocess, "note", status=sync_inbox.REVIEW)
        self._assert_refused(sync_inbox.apply_fix, "accept_total_difference", {}, status=sync_inbox.REVIEW)

    def test_a_record_with_no_payload_of_its_own_is_not_cleared(self):
        self.assertFalse(sync_retention.is_cleared(frappe._dict(payload_hash=None, original_payload=None)))

    def test_a_record_that_still_holds_its_payload_is_not_cleared(self):
        self.assertFalse(sync_retention.is_cleared(frappe._dict(payload_hash=HASH, original_payload=PAYLOAD)))


class FakeStoredRow:
    """What ingest and _adopt_payload see of one stored record."""

    def __init__(self, row):
        self.row = row
        self.writes = []

    def get_value(self, doctype, filters, fieldname="name", **_kwargs):
        if fieldname == "*":
            return self.row
        return frappe._dict({field: self.row.get(field) for field in fieldname})

    def set_value(self, doctype, name, values, **_kwargs):
        self.writes.append(values)
        self.row.update(values)

    def exists(self, doctype, name=None):
        return name

    def commit(self):
        pass


class TestDeviceSendsItAgain(RetentionCase):
    def _ingest(self, row, payload):
        store = FakeStoredRow(row)
        frappe.local.db = store
        item = {"offline_id": row.offline_id, "pos_profile": "Main", "payload": payload}
        with patch("pos_next.services.sync_inbox.now_datetime", lambda: NOW):
            return sync_inbox.ingest(item, "cashier@example.com"), store

    def _cleared_row(self):
        return _record("row-1", payload=None, original_payload=None)

    def test_the_same_sale_is_no_conflict(self):
        (name, conflict), _store = self._ingest(self._cleared_row(), {"customer": "Sara"})
        self.assertEqual((name, conflict), ("row-1", False))

    def test_the_customer_data_does_not_come_back(self):
        _result, store = self._ingest(self._cleared_row(), {"customer": "Sara"})

        self.assertEqual(store.writes, [])
        self.assertIsNone(store.row.payload)

    def test_a_different_sale_is_a_conflict_not_a_new_payload(self):
        (_name, conflict), store = self._ingest(self._cleared_row(), {"customer": "Someone Else"})

        self.assertTrue(conflict)
        self.assertEqual(store.writes, [])

    def test_a_record_stored_without_a_payload_still_takes_one(self):
        row = _record("row-1", status="Needs Review", payload=None, original_payload=None, payload_hash=None)

        (_name, conflict), store = self._ingest(row, {"customer": "Sara"})

        self.assertFalse(conflict)
        self.assertTrue(store.row.payload)
        self.assertEqual(store.row.status, "Received")


class TestSetup(unittest.TestCase):
    def setUp(self):
        path = Path(pos_settings.__file__).with_suffix(".json")
        doctype = json.loads(path.read_text())
        self.fields = {field["fieldname"]: field for field in doctype["fields"]}
        self.order = doctype["field_order"]

    def test_the_period_defaults_to_keeping_forever(self):
        field = self.fields["sync_payload_retention_days"]
        self.assertEqual((field["fieldtype"], field["default"]), ("Int", "0"))

    def test_its_description_warns_that_it_cannot_be_undone(self):
        self.assertIn("cannot be undone", self.fields["sync_payload_retention_days"]["description"])

    def test_frappe_refuses_a_negative_period(self):
        self.assertEqual(self.fields["sync_payload_retention_days"]["non_negative"], 1)

    def test_the_recipients_default_to_empty(self):
        field = self.fields["sync_alert_recipients"]
        self.assertEqual(field["fieldtype"], "Small Text")
        self.assertNotIn("default", field)

    def test_the_new_fields_are_in_the_form_order(self):
        for fieldname in ("sync_alert_recipients", "sync_alert_last_sent_at", "sync_payload_retention_days"):
            self.assertIn(fieldname, self.order)

    def test_the_job_runs_daily_outside_the_short_queues(self):
        self.assertIn("pos_next.tasks.sync.clear_old_payloads", hooks.scheduler_events["daily_long"])
