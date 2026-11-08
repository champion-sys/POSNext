# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Whole journeys through the inbox, on an in-memory stand-in for its table."""

import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import frappe
from rq.job import JobStatus
from rq.timeouts import JobTimeoutException

from pos_next.api import sync as sync_api
from pos_next.pos_next.doctype.offline_invoice_sync import offline_invoice_sync
from pos_next.services import sync_classifier, sync_inbox
from pos_next.services.sync_classifier import ReplacedByEditError
from pos_next.services.sync_entities import DOCTYPE

LOCAL_CUSTOMER = "pos_offline_customer-1"
SALE = "pos_offline_sale-1"
LATE_SALE = "pos_offline_sale-2"
CLOSE = "pos_offline_close-1"
PAYMENT = "pos_offline_payment-1"


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class FakeInbox:
    """Answers the queries the inbox makes, and stands in for the rest of the database."""

    def __init__(self):
        self.rows = {}
        self.disabled_users = set()
        # sara is a colleague on the profile, who may have a sale uploaded from a shared device
        self.assigned = {"Main": {"cashier@example.com", "sara@example.com"}}
        self.device_profiles = ["Main"]
        self.shifts = {}
        self.closings = {}
        self.savepoints = {}

    @staticmethod
    def _matches(row, filters):
        for fieldname, expected in filters.items():
            value = row.get(fieldname)
            if isinstance(expected, list):
                operator, operand = expected
                if operator == "in" and value not in operand:
                    return False
                if operator == "!=" and value == operand:
                    return False
                if operator == "not in" and value in operand:
                    return False
                if operator == "like" and operand.strip("%") not in (value or ""):
                    return False
                if operator == "is" and operand == "not set" and value:
                    return False
                if operator in ("<", "<=") and (value is None or value > operand):
                    return False
            elif value != expected:
                return False
        return True

    def _find(self, filters):
        if isinstance(filters, str):
            return [self.rows[filters]] if filters in self.rows else []
        return [row for row in self.rows.values() if self._matches(row, filters)]

    def get_value(self, doctype, filters=None, fieldname="name", as_dict=False, **_kwargs):
        if doctype == "User":
            return 0 if filters in self.disabled_users else 1
        if doctype == "POS Opening Shift":
            shift = self.shifts.get(filters)
            if isinstance(shift, str):
                shift = {"status": shift, "docstatus": 2 if shift == "Cancelled" else 1, "pos_profile": "Main",
                         "user": "cashier@example.com"}
            if not shift:
                return None
            if isinstance(fieldname, str):
                return shift.get(fieldname)
            return frappe._dict({field: shift.get(field) for field in fieldname})
        if doctype == "POS Closing Shift":
            return self.closings.get(filters)
        if doctype != DOCTYPE:
            return None

        found = self._find(filters)
        if not found:
            return None
        row = found[0]

        if fieldname == "*":
            return frappe._dict(row)
        if isinstance(fieldname, str):
            return row.get(fieldname)
        return frappe._dict({field: row.get(field) for field in fieldname})

    def get_all(self, doctype, filters=None, fields=None, pluck=None, as_list=False, **_kwargs):
        if doctype == "POS Device Profile":
            return list(self.device_profiles)

        rows = self._find(filters or {})
        if pluck:
            return [row.get(pluck) for row in rows]
        if as_list:
            return [tuple(row.get(field) for field in fields) for row in rows]
        return [frappe._dict({field: row.get(field) for field in fields}) for row in rows]

    def set_value(self, doctype, name, field, value=None, **_kwargs):
        """As in Frappe, a dict is a filter, and a row it no longer matches is left alone."""
        values = field if isinstance(field, dict) else {field: value}
        for row in self._find(name):
            row.update(values)

    def exists(self, doctype, name=None):
        if doctype == "POS Profile User":
            profiles = [name["parent"]] if "parent" in name else self.assigned
            return any(name["user"] in self.assigned.get(profile, ()) for profile in profiles)
        return name

    def commit(self):
        self.savepoints.clear()

    def savepoint(self, name):
        self.savepoints[name] = {key: frappe._dict(row) for key, row in self.rows.items()}

    def release_savepoint(self, name):
        del self.savepoints[name]

    def close(self):
        """A closed connection loses what it had not committed."""
        self.rollback()

    def connect(self):
        pass

    def rollback(self, save_point=None, **_kwargs):
        """As on MariaDB, a savepoint does not outlive its transaction."""
        if save_point:
            self.rows = self.savepoints[save_point]
        else:
            self.savepoints.clear()

    def count(self, *_args, **_kwargs):
        return 0

    def insert(self, values):
        name = f"row-{len(self.rows) + 1}"
        self.rows[name] = frappe._dict({"attempts": 0, **values, "name": name})
        return name


class Flow(unittest.TestCase):
    inbox_class = FakeInbox

    def setUp(self):
        self.inbox = self.inbox_class()
        frappe.local.db = self.inbox
        frappe.local.session = Mock(user="cashier@example.com")
        frappe.local.form_dict = frappe._dict()
        self.addCleanup(setattr, frappe.local, "db", None)
        self.addCleanup(setattr, frappe.local, "session", None)

        for target, replacement in (
            ("pos_next.services.sync_inbox.frappe.get_doc", self._new_document),
            ("pos_next.services.sync_inbox.frappe.get_all", self.inbox.get_all),
            ("pos_next.services.sync_inbox.now_datetime", datetime.now),
            ("pos_next.services.sync_inbox._", lambda text: text),
            ("pos_next.services.sync_entities._", lambda text: text),
            ("pos_next.services.sync_inbox._log_attempt", Mock()),
            ("pos_next.services.sync_inbox._notify_uploader", Mock()),
            ("pos_next.services.sync_inbox._notify_managers", Mock()),
            ("pos_next.services.sync_inbox.enqueue_processing", Mock()),
            ("pos_next.services.sync_inbox.get_system_timezone", lambda: "UTC"),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _new_document(self, values):
        document = Mock()

        def insert():
            document.name = self.inbox.insert(values)

        document.insert.side_effect = insert
        return document

    def _send(self, offline_id, payload, entity="invoice", depends_on=None):
        item = {
            "offline_id": offline_id,
            "entity": entity,
            "pos_profile": "Main",
            "cashier": "cashier@example.com",
            "depends_on": depends_on or [],
            "payload": payload,
        }
        name, conflict = sync_inbox.ingest(item, "cashier@example.com")
        self.assertFalse(conflict)
        return name

    def _row(self, name):
        return self.inbox.rows[name]

    def _age(self, name, hours=2):
        self._row(name)["received_at"] = datetime.now() - timedelta(hours=hours)


class TestCashierSession(Flow):
    """What a queued record creates belongs to its cashier, not to whoever runs the job."""

    finished = {"name": "SINV-1", "doctype": "Sales Invoice", "grand_total": 0}

    def _process(self, name, create):
        handler = sync_inbox._Entity(create, Mock(return_value=None), ())
        with patch.dict(sync_inbox._ENTITIES, {"invoice": handler}):
            return sync_inbox.process(name)

    def _stored_sale(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        self._row(name)["cashier"] = "sara@example.com"
        frappe.local.session.user = "Administrator"
        return name

    def test_every_entity_runs_as_the_cashier(self):
        users = []

        def create(row):
            users.append(frappe.session.user)
            return self.finished

        for entity in ("invoice", "customer", "payment", "shift_close"):
            name = self._send(f"pos_offline_{entity}", {"pos_profile": "Main"}, entity)
            self._row(name)["cashier"] = "sara@example.com"
            handler = sync_inbox._Entity(create, Mock(return_value=None), ())
            frappe.local.session.user = "Administrator"
            with patch.dict(sync_inbox._ENTITIES, {entity: handler}):
                sync_inbox.process(name)

        self.assertEqual(users, ["sara@example.com"] * 4)

    def test_the_user_comes_back_after_success(self):
        self._process(self._stored_sale(), Mock(return_value=self.finished))
        self.assertEqual(frappe.session.user, "Administrator")

    def test_the_user_comes_back_after_a_failure(self):
        name = self._stored_sale()
        self._process(name, Mock(side_effect=frappe.ValidationError("Closed period")))

        self.assertEqual(frappe.session.user, "Administrator")
        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)

    def test_the_record_is_written_outside_the_cashiers_session(self):
        name = self._stored_sale()
        writers = []
        sync_inbox._log_attempt.side_effect = lambda *_args, **_kwargs: writers.append(frappe.session.user)

        self._process(name, Mock(return_value=self.finished))

        self.assertEqual(writers, ["Administrator"])

    def test_a_request_keeps_its_session_and_arguments(self):
        name = self._stored_sale()
        data = frappe._dict(csrf_token="token", last_updated="2026-11-06 12:00:00")
        frappe.local.session = frappe._dict(user="manager@example.com", sid="abc123", data=data)
        form_dict = frappe._dict(cmd="pos_next.api.sync.push")
        frappe.local.form_dict = form_dict

        self._process(name, Mock(return_value=self.finished))

        self.assertEqual(frappe.session.user, "manager@example.com")
        self.assertEqual(frappe.session.sid, "abc123")
        self.assertIs(frappe.session.data, data)
        self.assertIs(frappe.local.form_dict, form_dict)

    def test_a_disabled_cashier_needs_a_person(self):
        name = self._stored_sale()
        self.inbox.disabled_users.add("sara@example.com")
        create = Mock(return_value=self.finished)

        self._process(name, create)

        create.assert_not_called()
        row = self._row(name)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "CashierUnavailableError")
        self.assertEqual(row.error_class, "business")
        self.assertIn("sara@example.com", row.error_message)
        self.assertEqual(frappe.session.user, "Administrator")

    def test_a_record_without_a_cashier_needs_a_person(self):
        name = self._stored_sale()
        self._row(name)["cashier"] = None

        self._process(name, Mock(return_value=self.finished))

        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)
        self.assertEqual(self._row(name).error_code, "CashierUnavailableError")

    def test_the_sale_does_not_try_to_set_its_own_owner(self):
        name = self._stored_sale()
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.invoices.assert_shift_takes_sale"),
            patch("pos_next.services.invoice_processor.process_invoice") as process_invoice,
        ):
            process_invoice.return_value = {"name": "SINV-1", "grand_total": 0}
            sync_inbox.process(name)

        self.assertNotIn("owner", process_invoice.call_args.args[0])
        self.assertEqual(process_invoice.call_args.kwargs, {"offline_id": SALE, "queued": True})


class TestRecordWithoutPayload(Flow):
    """Records migrated from before the inbox kept payloads."""

    def setUp(self):
        super().setUp()
        self.name = self.inbox.insert(
            {
                "offline_id": SALE,
                "status": sync_inbox.REVIEW,
                "error_class": "contract",
                "error_code": None,
                "error_message": "Recorded before the sync log kept payloads",
                "customer": "CUST-1",
                "payload": None,
                "payload_hash": None,
            }
        )

    def _resend(self, offline_id=SALE, payload=None, pos_profile="Main"):
        item = {
            "offline_id": offline_id,
            "pos_profile": pos_profile,
            "cashier": "cashier@example.com",
            "payload": payload or {"pos_profile": pos_profile, "grand_total": 25},
        }
        return sync_inbox.ingest(item, "cashier@example.com")

    def test_a_resend_gives_it_its_payload(self):
        name, conflict = self._resend()

        self.assertEqual(name, self.name)
        self.assertFalse(conflict)
        row = self._row(name)
        self.assertEqual(json.loads(row.payload)["grand_total"], 25)
        self.assertEqual(row.original_payload, row.payload)
        self.assertTrue(row.payload_hash)

    def test_a_record_under_review_goes_back_to_the_queue_with_no_old_error(self):
        name, _conflict = self._resend()

        row = self._row(name)
        self.assertEqual(row.status, "Received")
        self.assertIsNone(row.error_class)
        self.assertIsNone(row.error_message)

    def test_it_learns_what_it_needs_to_be_processed(self):
        name, _conflict = self._resend()

        row = self._row(name)
        self.assertEqual(row.cashier, "cashier@example.com")
        self.assertEqual(row.uploaded_by, "cashier@example.com")
        self.assertEqual(row.client_grand_total, 25)

    def test_what_it_already_held_stays(self):
        name, _conflict = self._resend()
        self.assertEqual(self._row(name).customer, "CUST-1")

    def test_a_record_that_had_finished_stays_finished(self):
        self._row(self.name).update({"status": "Synced", "sales_invoice": "SINV-1"})

        self._resend()

        row = self._row(self.name)
        self.assertEqual(row.status, "Synced")
        self.assertEqual(row.sales_invoice, "SINV-1")
        self.assertTrue(row.payload)

    def test_it_posts_like_any_other_sale_afterwards(self):
        name, _conflict = self._resend()

        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.invoices.assert_shift_takes_sale"),
            patch("pos_next.services.invoice_processor.process_invoice") as process_invoice,
        ):
            process_invoice.return_value = {"name": "SINV-1", "grand_total": 25}
            sync_inbox.process(name)

        self.assertEqual(self._row(name).status, "Synced")

    def test_a_second_resend_of_the_same_sale_is_a_plain_retry(self):
        self._resend()
        self.assertEqual(self._resend(), (self.name, False))

    def test_a_different_sale_afterwards_is_a_conflict(self):
        self._resend()

        _name, conflict = self._resend(payload={"pos_profile": "Main", "grand_total": 99})

        self.assertTrue(conflict)
        self.assertEqual(json.loads(self._row(self.name).payload)["grand_total"], 25)

    def test_a_resend_for_another_profile_cannot_take_it_over(self):
        self._row(self.name)["pos_profile"] = "Other"

        _name, conflict = self._resend()

        self.assertTrue(conflict)
        row = self._row(self.name)
        self.assertIsNone(row.payload)
        self.assertEqual(row.status, sync_inbox.REVIEW)


class TestEditOfASaleOnTheServer(Flow):
    def _edit(self):
        return self._send(LATE_SALE, {"pos_profile": "Main", "edited_from": SALE})

    def test_it_waits_for_a_manager_and_is_not_processed(self):
        self._send(SALE, {"pos_profile": "Main"})

        name = self._edit()

        row = self._row(name)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "EditConflictError")
        self.assertEqual(row.error_class, "business")
        self.assertIn(SALE, row.error_message)
        self.assertNotIn(name, sync_inbox._due_rows())
        sync_inbox._notify_managers.assert_called_once()

        create = Mock()
        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(create, Mock(return_value=None), ())}):
            sync_inbox.process(name)
        create.assert_not_called()
        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)

    def test_the_original_counts_whatever_became_of_it(self):
        for status in ("Received", "Processing", "Needs Review", "Synced", "Resolved"):
            self.inbox.rows.clear()
            original = self._send(SALE, {"pos_profile": "Main"})
            self._row(original)["status"] = status

            self.assertEqual(self._row(self._edit()).status, sync_inbox.REVIEW, status)

    def test_an_invoice_counts_without_a_record(self):
        with patch.object(sync_inbox, "find_invoice_by_offline_id", return_value={"name": "SINV-1"}):
            name = self._edit()

        self.assertEqual(self._row(name).error_code, "EditConflictError")

    def test_an_invoice_counts_even_if_its_record_was_voided(self):
        self._row(self._send(SALE, {"pos_profile": "Main"}))["status"] = "Voided"

        with patch.object(sync_inbox, "find_invoice_by_offline_id", return_value={"name": "SINV-1"}):
            name = self._edit()

        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)

    def test_an_edit_of_a_voided_record_goes_ahead(self):
        self._row(self._send(SALE, {"pos_profile": "Main"}))["status"] = "Voided"
        self.assertEqual(self._row(self._edit()).status, "Received")

    def test_an_edit_of_a_sale_that_never_arrived_goes_ahead(self):
        self.assertEqual(self._row(self._edit()).status, "Received")

    def test_an_edit_that_kept_its_id_does_not_conflict_with_itself(self):
        name = self._send(SALE, {"pos_profile": "Main", "edited_from": SALE})
        self.assertEqual(self._row(name).status, "Received")

    def test_a_sale_that_is_not_an_edit_goes_ahead(self):
        name = self._send(LATE_SALE, {"pos_profile": "Main", "edited_from": None})
        self.assertEqual(self._row(name).status, "Received")

    def test_it_keeps_the_link_in_a_column_that_outlives_the_payload(self):
        self.assertEqual(self._row(self._edit()).edited_from, SALE)

    def test_an_edit_that_kept_its_id_links_to_nothing(self):
        name = self._send(SALE, {"pos_profile": "Main", "edited_from": SALE})
        self.assertIsNone(self._row(name).edited_from)

    def test_a_link_that_is_not_a_name_links_to_nothing(self):
        name = self._send(SALE, {"pos_profile": "Main", "edited_from": ["pos_offline_sale-9"]})
        self.assertIsNone(self._row(name).edited_from)

    def test_the_original_arriving_after_its_edit_is_refused_and_not_stored(self):
        edit = self._edit()

        with self.assertRaises(ReplacedByEditError) as refused:
            self._send(SALE, {"pos_profile": "Main"})

        self.assertIn(LATE_SALE, str(refused.exception))
        self.assertEqual(list(self.inbox.rows), [edit])

    def test_whatever_became_of_the_edit_the_original_stays_out(self):
        for status in ("Received", "Needs Review", "Synced", "Resolved", "Voided"):
            self.inbox.rows.clear()
            self._row(self._edit())["status"] = status

            with self.assertRaises(ReplacedByEditError):
                self._send(SALE, {"pos_profile": "Main"})

    def test_a_resend_of_an_original_already_held_is_still_the_same_record(self):
        original = self._send(SALE, {"pos_profile": "Main"})
        self._edit()

        self.assertEqual(self._send(SALE, {"pos_profile": "Main"}), original)

    def _arrives_with(self, other, offline_id, payload):
        """Store a record while another request stores `other`, unseen until this one commits."""
        real = self.inbox.commit
        arrived = []

        def commit():
            real()
            if not arrived:
                arrived.append(other())

        with patch.object(self.inbox, "commit", side_effect=commit):
            name = self._send(offline_id, payload)
        return name, arrived[0]

    def _insert_unseen(self, offline_id, payload):
        return lambda: self.inbox.insert(
            {"offline_id": offline_id, "status": "Received", "edited_from": payload.get("edited_from")}
        )

    def test_a_sale_and_its_edit_stored_at_once_cannot_both_post(self):
        name, _edit = self._arrives_with(
            self._insert_unseen(LATE_SALE, {"edited_from": SALE}), SALE, {"pos_profile": "Main"}
        )

        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)
        self.assertEqual(self._row(name).error_code, "EditConflictError")
        self.assertIn(LATE_SALE, self._row(name).error_message)

    def test_an_edit_and_its_sale_stored_at_once_cannot_both_post(self):
        name, _sale = self._arrives_with(
            self._insert_unseen(SALE, {}), LATE_SALE, {"pos_profile": "Main", "edited_from": SALE}
        )

        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)
        self.assertEqual(self._row(name).error_code, "EditConflictError")

    def test_a_record_a_worker_already_took_is_left_to_it(self):
        def take():
            self._row("row-1")["status"] = "Processing"
            return self.inbox.insert({"offline_id": LATE_SALE, "status": "Received", "edited_from": SALE})

        name, _edit = self._arrives_with(take, SALE, {"pos_profile": "Main"})

        self.assertEqual(self._row(name).status, "Processing")

    def test_a_resend_of_the_edit_stays_where_it_is(self):
        self._send(SALE, {"pos_profile": "Main"})
        name = self._edit()

        self.assertEqual(self._edit(), name)
        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)

    def test_a_manager_who_keeps_the_edit_can_post_it(self):
        self._send(SALE, {"pos_profile": "Main"})
        name = self._edit()
        self._row(name)["status"] = "Received"

        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.invoices.assert_shift_takes_sale"),
            patch("pos_next.services.invoice_processor.process_invoice") as process_invoice,
        ):
            process_invoice.return_value = {"name": "SINV-2", "grand_total": 0}
            sync_inbox.process(name)

        self.assertEqual(self._row(name).status, "Synced")


class TestSweepWritesOnlyWhatItRead(Flow):
    """A manager can act between the sweep's read and its write."""

    def _change_after_the_sweep_reads(self, name, read, status):
        read_rows = self.inbox.get_all

        def get_all(doctype, filters=None, **kwargs):
            rows = read_rows(doctype, filters=filters, **kwargs)
            if (filters or {}).get("status") == read:
                self._row(name)["status"] = status
            return rows

        patcher = patch("pos_next.services.sync_inbox.frappe.get_all", get_all)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _stale_row(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        self._row(name).update({"status": "Processing", "modified": datetime.now() - timedelta(hours=1)})
        return name

    def _waiting_row(self, status):
        name = self._send(SALE, {"pos_profile": "Main"}, depends_on=[LOCAL_CUSTOMER])
        self._row(name).update({"status": status, "error_code": "WaitingForDependencyError"})
        customer = self._send(LOCAL_CUSTOMER, {"pos_profile": "Main"}, "customer")
        self._row(customer)["status"] = "Synced"
        return name

    def test_a_crashed_row_goes_back_to_the_queue(self):
        name = self._stale_row()
        sync_inbox.sweep()
        self.assertEqual(self._row(name).status, "Received")

    def test_a_row_finished_after_the_read_stays_finished(self):
        name = self._stale_row()
        self._change_after_the_sweep_reads(name, "Processing", "Synced")

        sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Synced")

    def test_a_row_picked_up_again_after_the_read_is_left_to_its_worker(self):
        name = self._stale_row()
        real_get_all = self.inbox.get_all

        def get_all(doctype, filters=None, **kwargs):
            rows = real_get_all(doctype, filters=filters, **kwargs)
            if (filters or {}).get("status") == "Processing":
                self._row(name)["modified"] = datetime.now()
            return rows

        with patch("pos_next.services.sync_inbox.frappe.get_all", get_all):
            sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Processing")

    def test_a_blocked_row_goes_on_once_it_is_free(self):
        name = self._waiting_row("Blocked")
        sync_inbox.sweep()
        self.assertEqual(self._row(name).status, "Received")

    def test_a_blocked_row_voided_after_the_read_stays_voided(self):
        name = self._waiting_row("Blocked")
        self._change_after_the_sweep_reads(name, "Blocked", "Voided")

        sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Voided")

    def test_a_row_voided_between_the_sweeps_two_reads_stays_voided(self):
        name = self._waiting_row("Blocked")

        def free_and_void(_row):
            self._row(name)["status"] = "Voided"
            return False

        with patch.object(sync_inbox, "_is_blocked", side_effect=free_and_void):
            sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Voided")

    def test_a_voided_row_still_waiting_is_not_blocked_again(self):
        name = self._send(SALE, {"pos_profile": "Main"}, depends_on=[LOCAL_CUSTOMER])
        self._row(name)["status"] = "Blocked"
        self._change_after_the_sweep_reads(name, "Blocked", "Voided")

        sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Voided")

    def test_a_row_held_for_a_dependency_goes_on_once_it_arrives(self):
        name = self._waiting_row(sync_inbox.REVIEW)
        sync_inbox.sweep()
        self.assertEqual(self._row(name).status, "Received")

    def test_a_review_resolved_after_the_read_stays_resolved(self):
        name = self._waiting_row(sync_inbox.REVIEW)
        self._change_after_the_sweep_reads(name, sync_inbox.REVIEW, "Resolved")

        sync_inbox.sweep()

        self.assertEqual(self._row(name).status, "Resolved")


class RowDocument:
    """A stored record, as the review actions load and save it."""

    def __init__(self, row):
        self.__dict__.update(row)
        self.flags = frappe._dict()
        self._row = row

    def set(self, fieldname, value):
        setattr(self, fieldname, value)

    def save(self, **_kwargs):
        self._row.update({key: value for key, value in vars(self).items() if key not in ("flags", "_row")})


class TestDeviceClock(Flow):
    HOUR = 3600

    def _clock(self, seconds, accepted=0):
        return frappe._dict(clock_skew_seconds=seconds, accept_device_date=accepted)

    def test_a_clock_that_only_drifts_stops_nothing(self):
        sync_inbox._assert_device_clock(self._clock(11 * self.HOUR))

    def test_a_clock_half_a_day_ahead_is_held(self):
        with self.assertRaises(sync_classifier.ClockSkewError):
            sync_inbox._assert_device_clock(self._clock(12 * self.HOUR))

    def test_a_clock_half_a_day_behind_is_held(self):
        with self.assertRaises(sync_classifier.ClockSkewError):
            sync_inbox._assert_device_clock(self._clock(-12 * self.HOUR))

    def test_a_managers_acceptance_lets_it_through(self):
        sync_inbox._assert_device_clock(self._clock(48 * self.HOUR, accepted=1))

    def _payment(self):
        payload = {"invoice_name": "SINV-1", "pos_profile": "Main", "posting_date": "2027-11-07", "payments": [{"amount": 40}]}
        item = {
            "offline_id": PAYMENT,
            "entity": "payment",
            "pos_profile": "Main",
            "cashier": "cashier@example.com",
            "payload": payload,
            "clock_skew_seconds": 365 * 24 * self.HOUR,
        }
        name, _conflict = sync_inbox.ingest(item, "cashier@example.com")
        return name

    def _process_payment(self, name, reprocess=False):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=[]),
            patch("pos_next.api.partial_payments.post_queued_payments", return_value=["PE-1"]) as post,
            patch("pos_next.services.sync_inbox.frappe.get_doc", lambda _doctype, _name: RowDocument(self._row(name))),
        ):
            (sync_inbox.reprocess if reprocess else sync_inbox.process)(name)
        return post

    def test_a_payment_from_a_wrong_clock_waits_for_a_person_and_does_not_post(self):
        name = self._payment()

        post = self._process_payment(name)

        post.assert_not_called()
        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)
        self.assertEqual(self._row(name).error_code, "ClockSkewError")

    def test_change_posting_date_releases_that_payment_on_the_new_date(self):
        name = self._payment()
        self._process_payment(name)

        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", lambda _doctype, _name: RowDocument(self._row(name))),
        ):
            sync_inbox.apply_fix(name, "posting_date", {"posting_date": "2026-11-07"})
        post = self._process_payment(name, reprocess=True)

        self.assertEqual(post.call_args.args[2], "2026-11-07")
        self.assertEqual(self._row(name).status, "Synced")

    def test_accept_device_date_releases_that_payment_on_its_own_date(self):
        name = self._payment()
        self._process_payment(name)

        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", lambda _doctype, _name: RowDocument(self._row(name))),
        ):
            sync_inbox.apply_fix(name, "accept_device_date", {})
        post = self._process_payment(name, reprocess=True)

        self.assertEqual(post.call_args.args[2], "2027-11-07")

    def test_the_form_offers_a_payment_the_same_way_out(self):
        form = Path(offline_invoice_sync.__file__).with_suffix(".js").read_text()
        button = form.index("DEVICE_DATE_CODES.includes(frm.doc.error_code)")

        self.assertLess(form.rindex('if (entity === "invoice") {'), button)
        self.assertIn("}\n\n\tif (DEVICE_DATE_CODES.includes(frm.doc.error_code))", form)
        self.assertIn('const DEVICE_DATE_CODES = ["ClockSkewError", "SaleOutsideShiftError"];', form)

    def test_the_form_says_when_there_was_no_reading(self):
        form = Path(offline_invoice_sync.__file__).with_suffix(".js").read_text()
        self.assertIn("frm.doc.clock_not_measured", form)

    def test_it_goes_to_a_person_not_to_a_retry(self):
        result = sync_classifier.classify(sync_classifier.ClockSkewError("Off"))

        self.assertEqual(result.error_class, sync_classifier.BUSINESS)
        self.assertEqual(result.error_code, "ClockSkewError")


class TestCashierLeftTheProfile(Flow):
    """A colleague's record whose cashier is no longer on the POS Profile goes to a person."""

    finished = {"name": "SINV-1", "doctype": "Sales Invoice", "grand_total": 0}

    def _store(self, cashier, uploaded_by="manager@example.com"):
        item = {
            "offline_id": SALE,
            "entity": "invoice",
            "pos_profile": "Main",
            "cashier": cashier,
            "payload": {"pos_profile": "Main"},
        }
        name, _conflict = sync_inbox.ingest(item, uploaded_by)
        return name

    def _process(self, name):
        users = []

        def create(_row):
            users.append(frappe.session.user)
            return self.finished

        handler = sync_inbox._Entity(create, Mock(return_value=None), ())
        with patch.dict(sync_inbox._ENTITIES, {"invoice": handler}):
            sync_inbox.process(name)
        return users

    def test_it_keeps_their_name_and_waits_for_a_person(self):
        self.inbox.assigned["Main"].discard("sara@example.com")
        name = self._store("sara@example.com")

        self.assertEqual(self._process(name), [])

        row = self._row(name)
        self.assertEqual(row.cashier, "sara@example.com")
        self.assertEqual(row.uploaded_by, "manager@example.com")
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "CashierNotOnProfileError")
        self.assertEqual(row.error_class, "business")
        self.assertIn("no longer on POS Profile Main", row.error_message)
        sync_inbox._notify_managers.assert_called_once()

    def test_back_on_the_profile_it_posts_as_theirs(self):
        self.inbox.assigned["Main"].discard("sara@example.com")
        name = self._store("sara@example.com")
        self._process(name)

        self.inbox.assigned["Main"].add("sara@example.com")
        self._row(name)["status"] = "Received"

        self.assertEqual(self._process(name), ["sara@example.com"])
        self.assertEqual(self._row(name).status, "Synced")

    def test_a_colleague_still_on_the_profile_posts_as_before(self):
        name = self._store("sara@example.com", uploaded_by="cashier@example.com")

        self.assertEqual(self._process(name), ["sara@example.com"])
        self.assertEqual(self._row(name).status, "Synced")

    def test_the_uploaders_own_record_is_not_held(self):
        # A manager who may write the profile without being on it, uploading their own sale
        name = self._store("manager@example.com")

        self.assertEqual(self._process(name), ["manager@example.com"])
        self.assertEqual(self._row(name).status, "Synced")

    def test_no_claim_is_the_uploaders(self):
        name = self._store(None, uploaded_by="cashier@example.com")
        self.assertEqual(self._row(name).cashier, "cashier@example.com")


class TestSaleOutsideItsShift(Flow):
    """The clock is read when a batch is sent, so the sale's date is checked against its shift."""

    OPENED = datetime(2026, 11, 8, 9, 0)

    def setUp(self):
        super().setUp()
        self.inbox.shifts["SHIFT-1"] = frappe._dict(
            period_start_date=self.OPENED,
            status="Open",
            pos_closing_shift=None,
            docstatus=1,
            pos_profile="Main",
            user="cashier@example.com",
        )
        now = patch("pos_next.services.sync_inbox.now_datetime", return_value=datetime(2026, 11, 8, 18, 0))
        now.start()
        self.addCleanup(now.stop)

    def _post(self, **payload):
        name = self._send(
            SALE,
            {"pos_profile": "Main", "doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1", **payload},
        )
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.services.invoice_processor.process_invoice") as self.process_invoice,
        ):
            self.process_invoice.return_value = {"name": "ACC-1", "grand_total": 0}
            sync_inbox.process(name)
        return self._row(name)

    def _close(self, at):
        self.inbox.shifts["SHIFT-1"].update(status="Closed", pos_closing_shift="CLOSE-1")
        self.inbox.closings["CLOSE-1"] = at

    def test_a_sale_dated_weeks_before_its_shift_opened_goes_to_a_person(self):
        row = self._post(posting_date="2026-09-29", posting_time="10:00:00", set_posting_time=1)

        self.process_invoice.assert_not_called()
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "SaleOutsideShiftError")
        self.assertEqual(row.error_class, "business")
        self.assertIn("SHIFT-1", row.error_message)

    def test_a_sale_dated_after_its_shift_closed_goes_to_a_person(self):
        self._close(datetime(2026, 11, 8, 12, 0))

        row = self._post(posting_date="2026-11-08", posting_time="14:00:00")

        self.assertEqual(row.error_code, "SaleOutsideShiftError")

    def test_a_sale_dated_ahead_of_the_server_in_an_open_shift_goes_to_a_person(self):
        row = self._post(posting_date="2026-11-08", posting_time="23:00:00")
        self.assertEqual(row.error_code, "SaleOutsideShiftError")

    def test_a_date_without_a_time_is_checked_by_day(self):
        self.assertEqual(self._post(posting_date="2026-11-07").error_code, "SaleOutsideShiftError")

    def test_a_sale_made_offline_in_its_open_shift_posts(self):
        row = self._post(posting_date="2026-11-08", posting_time="11:30:00", set_posting_time=1)

        self.process_invoice.assert_called_once()
        self.assertEqual(row.status, "Synced")

    def test_a_clock_a_few_minutes_off_is_tolerated(self):
        self.assertEqual(self._post(posting_date="2026-11-08", posting_time="08:45:00").status, "Synced")

    def test_a_sale_the_server_dates_is_not_checked(self):
        self.assertEqual(self._post().status, "Synced")

    def test_a_managers_acceptance_lets_it_through(self):
        name = self._send(SALE, {"pos_profile": "Main", "posa_pos_opening_shift": "SHIFT-1", "posting_date": "2026-09-29"})
        self._row(name)["accept_device_date"] = 1

        sync_inbox._assert_device_clock(self._row(name))

    def test_a_sale_a_manager_moved_to_another_shift_is_not_held_again(self):
        self.inbox.shifts["SHIFT-2"] = frappe._dict(
            period_start_date=self.OPENED, status="Open", pos_closing_shift=None
        )
        name = self._send(SALE, {"pos_profile": "Main", "posa_pos_opening_shift": "SHIFT-1", "posting_date": "2026-09-29"})
        self._row(name)["payload"] = json.dumps({"pos_profile": "Main", "posa_pos_opening_shift": "SHIFT-2", "posting_date": "2026-09-29"})

        sync_inbox._assert_device_clock(self._row(name))

    def test_a_shift_opened_on_the_device_is_found_by_the_name_it_gave_it(self):
        payload = json.dumps({"posa_pos_opening_shift": "pos_offline_shift-1", "posting_date": "2026-09-29"})
        row = frappe._dict(entity="invoice", payload=payload, original_payload=payload)
        self.inbox.get_value = Mock(
            return_value=frappe._dict(name="SHIFT-9", period_start_date=self.OPENED, status="Open")
        )

        with self.assertRaises(sync_classifier.SaleOutsideShiftError):
            sync_inbox._assert_device_clock(row)

        self.assertEqual(
            self.inbox.get_value.call_args.args[:2], ("POS Opening Shift", {"offline_id": "pos_offline_shift-1"})
        )

    def test_a_shift_the_server_does_not_know_yet_is_left_to_the_other_checks(self):
        # TestClosedShift covers the check that refuses it, so only the date check is under test
        self.inbox.shifts.clear()
        with patch("pos_next.api.invoices.assert_shift_takes_sale"):
            self.assertEqual(self._post(posting_date="2026-09-29").status, "Synced")


class TestJobTimeout(Flow):
    def _time_out(self, name, create=None):
        create = create or Mock(side_effect=JobTimeoutException("Task exceeded maximum timeout value"))
        handler = sync_inbox._Entity(create, Mock(return_value=None), ())
        with patch.dict(sync_inbox._ENTITIES, {"invoice": handler}):
            with self.assertRaises(JobTimeoutException):
                sync_inbox.process(name)

    def test_a_healthy_sale_goes_back_to_the_queue(self):
        name = self._send(SALE, {"pos_profile": "Main"})

        self._time_out(name)

        row = self._row(name)
        self.assertEqual(row.status, "Received")
        self.assertIsNone(row.get("error_class"))
        self.assertIn(name, sync_inbox._due_rows())
        sync_inbox._notify_managers.assert_not_called()

    def test_it_is_not_counted_against_the_sale(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        self._row(name)["attempts"] = 2

        self._time_out(name)

        self.assertEqual(self._row(name).attempts, 2)

    def test_a_new_connection_carries_the_write_a_cut_query_would_break(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        statuses = []
        self.inbox.close = lambda: statuses.append(self._row(name).status)

        self._time_out(name)

        self.assertEqual(statuses, ["Processing"])
        self.assertEqual(self._row(name).status, "Received")

    def test_a_sale_that_committed_just_before_the_limit_stays_synced(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        finished = {"name": "SINV-1", "doctype": "Sales Invoice"}

        def commit():
            if self._row(name).status == "Synced":
                self.inbox.commit = lambda: None
                raise JobTimeoutException("Task exceeded maximum timeout value")

        self.inbox.commit = commit

        self._time_out(name, Mock(return_value=finished))

        self.assertEqual(self._row(name).status, "Synced")

    def test_the_session_comes_back_before_the_job_ends(self):
        name = self._send(SALE, {"pos_profile": "Main"})
        self._row(name)["cashier"] = "sara@example.com"

        self._time_out(name)

        self.assertEqual(frappe.session.user, "cashier@example.com")


class TestQueueJob(Flow):
    def _run(self, due, clock):
        readings = due if isinstance(due[0], list) else [due]
        with (
            patch.object(sync_inbox, "_due_rows", side_effect=[*readings, readings[-1]]),
            patch.object(sync_inbox, "process") as process,
            patch.object(sync_inbox, "_queue_next_turn") as self.next_turn,
            patch("pos_next.services.sync_inbox.time.monotonic", side_effect=clock),
        ):
            sync_inbox.process_profile_queue("Main")
        return [call.args[0] for call in process.call_args_list]

    def test_a_short_queue_is_finished(self):
        self.assertEqual(self._run(["row-1", "row-2"], [0, 1, 2]), ["row-1", "row-2"])

    def test_it_takes_no_new_row_near_the_limit(self):
        limit = sync_inbox.QUEUE_JOB_SECONDS - sync_inbox.QUEUE_JOB_MARGIN_SECONDS

        taken = self._run(["row-1", "row-2", "row-3"], [0, 1, limit - 1, limit])

        self.assertEqual(taken, ["row-1", "row-2"])

    def test_the_next_job_is_queued_at_the_limit_rather_than_left_to_the_sweep(self):
        limit = sync_inbox.QUEUE_JOB_SECONDS - sync_inbox.QUEUE_JOB_MARGIN_SECONDS

        self._run(["row-1", "row-2"], [0, 1, limit])

        self.next_turn.assert_called_once_with("Main")

    def test_a_finished_queue_asks_for_no_next_job(self):
        self._run(["row-1"], [0, 1])

        self.next_turn.assert_not_called()

    def test_a_row_pushed_during_the_job_is_taken_by_it(self):
        taken = self._run([["row-1"], ["row-1", "row-2"]], [0, 1, 2])

        self.assertEqual(taken, ["row-1", "row-2"])

    def test_a_row_that_stays_due_is_tried_once(self):
        self.assertEqual(self._run([["row-1"], ["row-1"]], [0, 1]), ["row-1"])

    def _take_next_turn(self, statuses):
        with (
            patch.object(sync_inbox, "_queue_job_id", return_value="job-1"),
            patch.object(sync_inbox, "get_job_status", side_effect=statuses) as self.job_status,
            patch.object(sync_inbox, "enqueue_processing") as queue,
            patch("pos_next.services.sync_inbox.time.sleep"),
        ):
            sync_inbox.take_next_turn("Main")
        return queue

    def test_the_next_turn_waits_for_the_last_job_to_end(self):
        queue = self._take_next_turn([JobStatus.STARTED, JobStatus.STARTED, JobStatus.FINISHED])

        self.assertEqual(self.job_status.call_count, 3)
        queue.assert_called_once_with("Main")

    def test_a_job_the_sweep_queued_is_not_waited_for(self):
        queue = self._take_next_turn([JobStatus.QUEUED])

        self.assertEqual(self.job_status.call_count, 1)
        queue.assert_called_once_with("Main")

    def test_the_next_turn_does_not_wait_forever(self):
        queue = self._take_next_turn([JobStatus.STARTED] * sync_inbox.NEXT_TURN_WAIT_SECONDS)

        queue.assert_called_once_with("Main")


class TestClosedShift(Flow):
    def setUp(self):
        super().setUp()
        for target in ("frappe.throw", "pos_next.api.invoices._"):
            patcher = patch(target, _raise if target == "frappe.throw" else (lambda text: text))
            patcher.start()
            self.addCleanup(patcher.stop)

    def _post(self, payload):
        name = self._send(SALE, {"pos_profile": "Main", **payload})
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.services.invoice_processor.process_invoice") as self.process_invoice,
        ):
            self.process_invoice.return_value = {"name": "ACC-1", "grand_total": 0}
            sync_inbox.process(name)
        return self._row(name)

    def _pos_invoice(self, **payload):
        return {"doctype": "POS Invoice", "posa_pos_opening_shift": "SHIFT-1", **payload}

    def test_a_pos_invoice_of_a_closed_shift_goes_to_a_person(self):
        self.inbox.shifts["SHIFT-1"] = "Closed"

        row = self._post(self._pos_invoice())

        self.process_invoice.assert_not_called()
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "ShiftClosedError")
        self.assertEqual(row.error_class, "business")
        self.assertIn("Change Shift", row.error_message)

    def test_a_cancelled_shift_counts_as_closed(self):
        self.inbox.shifts["SHIFT-1"] = "Cancelled"
        self.assertEqual(self._post(self._pos_invoice()).error_code, "ShiftClosedError")

    def test_a_shift_that_is_gone_counts_as_closed(self):
        self.assertEqual(self._post(self._pos_invoice()).error_code, "ShiftClosedError")

    def test_a_pos_invoice_without_a_shift_cannot_be_collected_either(self):
        row = self._post({"doctype": "POS Invoice"})

        self.process_invoice.assert_not_called()
        self.assertEqual(row.error_code, "ShiftClosedError")

    def test_a_pos_invoice_of_an_open_shift_posts(self):
        self.inbox.shifts["SHIFT-1"] = "Open"

        row = self._post(self._pos_invoice())

        self.process_invoice.assert_called_once()
        self.assertEqual(row.status, "Synced")

    def test_a_sales_invoice_of_a_closed_shift_goes_to_a_person_too(self):
        """Its drawer was counted without it, so it must not land there unseen."""
        self.inbox.shifts["SHIFT-1"] = "Closed"

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_not_called()
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "ShiftClosedError")
        self.assertIn("Change Shift", row.error_message)

    def test_a_sales_invoice_of_an_open_shift_posts(self):
        self.inbox.shifts["SHIFT-1"] = "Open"

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_called_once()
        self.assertEqual(row.status, "Synced")

    def test_a_sale_into_another_profiles_shift_goes_to_a_person(self):
        self.inbox.shifts["SHIFT-1"] = {"status": "Open", "docstatus": 1, "pos_profile": "Other", "user": "omar@example.com"}

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_not_called()
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "WrongShiftError")
        self.assertEqual(row.error_class, "business")

    def test_a_colleagues_sale_into_the_devices_shift_on_its_profile_posts(self):
        """A shared device sells into the shift it has open, whoever is signed in."""
        self.inbox.shifts["SHIFT-1"] = {"status": "Open", "docstatus": 1, "pos_profile": "Main", "user": "sara@example.com"}

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_called_once()
        self.assertEqual(row.status, "Synced")

    def test_a_sale_into_a_shift_closed_on_a_device_goes_to_a_person(self):
        self.inbox.shifts["SHIFT-1"] = "Open"
        self.inbox.insert({"offline_id": CLOSE, "entity": "shift_close", "shift": "SHIFT-1", "status": "Blocked", "depends_on": ""})

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_not_called()
        self.assertEqual(row.error_code, "ShiftClosedError")

    def test_a_sale_the_pending_close_waits_for_still_posts(self):
        self.inbox.shifts["SHIFT-1"] = "Open"
        self.inbox.insert({"offline_id": CLOSE, "entity": "shift_close", "shift": "SHIFT-1", "status": "Blocked", "depends_on": SALE})

        row = self._post({"doctype": "Sales Invoice", "posa_pos_opening_shift": "SHIFT-1"})

        self.process_invoice.assert_called_once()
        self.assertEqual(row.status, "Synced")


class Upload(Flow):
    """Through the real push, with the access rules and only the database faked."""

    def setUp(self):
        super().setUp()
        self.profile_writers = set()
        frappe.local.session.user = "lina@example.com"
        self.inbox.assigned = {"Main": {"lina@example.com", "sara@example.com"}, "Other": {"omar@example.com"}}
        self.addCleanup(setattr, frappe.local, "pos_device", None)

        for target, replacement in (
            ("frappe.throw", _raise),
            ("frappe.has_permission", self._has_permission),
            ("frappe.utils.now", lambda: "2026-11-06 12:00:00"),
            ("pos_next.api.invoices._", lambda text: text),
            ("pos_next.api.sync._", lambda text: text),
            ("pos_next.auth._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _has_permission(self, _doctype, _ptype, user=None):
        return (user or frappe.session.user) in self.profile_writers

    @staticmethod
    def item(offline_id=SALE, pos_profile="Main", cashier="lina@example.com", **values):
        return {
            "offline_id": offline_id,
            "pos_profile": pos_profile,
            "cashier": cashier,
            "payload": {"pos_profile": pos_profile},
            **values,
        }

    def push(self, *items):
        return {result["offline_id"]: result for result in sync_api.push(list(items))["results"]}

    def stored(self, offline_id=SALE):
        return next(row for row in self.inbox.rows.values() if row.offline_id == offline_id)


class TestUploadAccess(Upload):
    def test_a_colleague_on_the_profile_can_upload_a_sale(self):
        self.push(self.item(cashier="sara@example.com"))

        self.assertEqual(self.stored().cashier, "sara@example.com")
        self.assertEqual(self.stored().uploaded_by, "lina@example.com")

    def _process_stored(self):
        create = Mock(return_value={"name": "SINV-1", "doctype": "Sales Invoice"})
        users = []
        create.side_effect = lambda _row: users.append(frappe.session.user) or {"name": "SINV-1", "doctype": "Sales Invoice"}
        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(create, Mock(return_value=None), ())}):
            sync_inbox.process(self.stored().name)
        return users

    def test_a_claim_to_be_someone_outside_the_profile_waits_for_a_person(self):
        self.push(self.item(cashier="omar@example.com"))

        # Not given to the uploader, and not posted as someone the profile does not have
        self.assertEqual(self.stored().cashier, "omar@example.com")
        self.assertEqual(self._process_stored(), [])
        self.assertEqual(self.stored().status, sync_inbox.REVIEW)
        self.assertEqual(self.stored().error_code, "CashierNotOnProfileError")

    def test_high_roles_do_not_make_someone_a_cashier_here(self):
        self.profile_writers.add("Administrator")

        self.push(self.item(cashier="Administrator"))

        self.assertEqual(self._process_stored(), [])
        self.assertEqual(self.stored().error_code, "CashierNotOnProfileError")

    def test_a_colleague_on_the_profile_posts_as_themselves(self):
        self.push(self.item(cashier="sara@example.com"))

        self.assertEqual(self._process_stored(), ["sara@example.com"])
        self.assertEqual(self.stored().status, "Synced")

    def test_a_claim_that_is_not_a_name_cannot_become_a_filter(self):
        self.push(self.item(cashier=["like", "%"]))
        self.assertEqual(self.stored().cashier, "lina@example.com")

    def test_no_claim_means_the_uploader(self):
        self.push(self.item(cashier=None))
        self.assertEqual(self.stored().cashier, "lina@example.com")

    def test_an_uploader_outside_the_profile_is_refused_alone(self):
        results = self.push(
            self.item("pos_offline_theirs", pos_profile="Other", cashier="omar@example.com"),
            self.item("pos_offline_mine"),
        )

        self.assertEqual(results["pos_offline_theirs"]["status"], "rejected")
        self.assertIn("Other", results["pos_offline_theirs"]["message"])
        self.assertEqual(results["pos_offline_mine"]["status"], "received")
        self.assertEqual([row.offline_id for row in self.inbox.rows.values()], ["pos_offline_mine"])

    def test_a_refusal_leaves_no_message_for_the_whole_response(self):
        frappe.local.message_log = ["left by frappe.throw"]
        self.push(self.item(pos_profile="Other"))
        self.assertEqual(frappe.local.message_log, [])

    def test_a_manager_who_can_write_the_profile_may_upload(self):
        self.profile_writers.add("lina@example.com")

        results = self.push(self.item(pos_profile="Other", cashier="omar@example.com"))

        self.assertEqual(results[SALE]["status"], "received")
        self.assertEqual(self.stored().cashier, "omar@example.com")

    def test_the_payload_cannot_name_another_profile_than_the_one_checked(self):
        item = self.item()
        item["payload"]["pos_profile"] = "Other"

        results = self.push(item)

        self.assertEqual(results[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})

    def test_a_profile_that_is_not_a_name_is_refused(self):
        results = self.push(self.item(pos_profile=["like", "%"]))

        self.assertEqual(results[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})

    def test_a_device_cannot_upload_outside_its_profiles(self):
        frappe.local.pos_device = "device-1"
        self.inbox.device_profiles = ["Elsewhere"]

        results = self.push(self.item())

        self.assertEqual(results[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})

    def test_a_device_can_upload_for_its_own_profiles(self):
        frappe.local.pos_device = "device-1"
        self.assertEqual(self.push(self.item())[SALE]["status"], "received")

    def test_a_browser_has_no_device_list(self):
        self.inbox.device_profiles = ["Elsewhere"]
        self.assertEqual(self.push(self.item())[SALE]["status"], "received")


class TestOneBadItem(Upload):
    def setUp(self):
        super().setUp()
        patcher = patch("frappe.log_error")
        self.log_error = patcher.start()
        self.addCleanup(patcher.stop)

    def test_it_does_not_lose_the_others(self):
        results = self.push(
            self.item("pos_offline_first"),
            self.item("pos_offline_bad", depends_on=5),
            self.item("pos_offline_last"),
        )

        self.assertEqual(results["pos_offline_first"]["status"], "received")
        self.assertEqual(results["pos_offline_bad"]["status"], "rejected")
        self.assertEqual(results["pos_offline_bad"]["message"], "The server could not store this record")
        self.assertEqual(results["pos_offline_last"]["status"], "received")
        self.assertEqual(
            [row.offline_id for row in self.inbox.rows.values()], ["pos_offline_first", "pos_offline_last"]
        )

    def test_the_reason_reaches_the_error_log(self):
        self.push(self.item(depends_on=5))
        self.log_error.assert_called_once()

    def test_what_it_wrote_is_undone(self):
        with patch.object(sync_inbox, "_get_edit_conflict", side_effect=RuntimeError("Mid write")):
            results = self.push(self.item())

        self.assertEqual(results[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})

    def test_a_deadlock_that_ended_the_transaction_is_survived(self):
        def deadlock(*_args):
            self.inbox.savepoints.clear()
            raise RuntimeError("Deadlock found when trying to get lock")

        with patch.object(sync_inbox, "ingest", side_effect=deadlock):
            results = self.push(self.item())

        self.assertEqual(results[SALE]["status"], "rejected")

    def test_a_refusal_is_not_an_error_to_log(self):
        self.push(self.item(pos_profile="Other"))
        self.log_error.assert_not_called()

    def test_it_leaves_no_message_for_the_whole_response(self):
        frappe.local.message_log = ["left by frappe.throw"]
        self.push(self.item(depends_on=5))
        self.assertEqual(frappe.local.message_log, [])

    def test_a_shift_manifest_fits_however_long_the_shift_was(self):
        doctype = json.loads(Path(offline_invoice_sync.__file__).with_suffix(".json").read_text())
        field = next(field for field in doctype["fields"] if field["fieldname"] == "depends_on")
        self.assertEqual(field["fieldtype"], "Long Text")


class TestNewCustomerJourney(Flow):
    def _post_customer(self, name):
        customer = Mock()
        customer.name = "CUST-0001"
        with (
            patch("pos_next.services.sync_entities.frappe.has_permission", return_value=True),
            patch("pos_next.api.customers.insert_customer", return_value=customer),
        ):
            sync_inbox.process(name)

    def test_a_sale_that_arrives_first_still_posts_against_the_real_customer(self):
        sale = self._send(SALE, {"customer": LOCAL_CUSTOMER, "customer_name": "Sara", "pos_profile": "Main"})

        sync_inbox.process(sale)
        self.assertEqual(self._row(sale).status, "Blocked")

        customer = self._send(LOCAL_CUSTOMER, {"customer_name": "Sara", "pos_profile": "Main"}, "customer")
        self._post_customer(customer)
        self.assertEqual(self._row(customer).status, "Synced")
        self.assertEqual(self._row(customer).sales_invoice, "CUST-0001")

        sync_inbox.sweep()
        self.assertEqual(self._row(sale).status, "Received")

        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.invoices.assert_shift_takes_sale"),
            patch("pos_next.services.invoice_processor.process_invoice") as process_invoice,
        ):
            process_invoice.return_value = {"name": "SINV-1", "grand_total": 0}
            sync_inbox.process(sale)

        posted = process_invoice.call_args.args[0]
        self.assertEqual(posted["customer"], "CUST-0001")
        self.assertNotIn("customer_name", posted)

        row = self._row(sale)
        self.assertEqual(row.status, "Synced")
        self.assertEqual(row.customer, "CUST-0001")
        self.assertEqual(json.loads(row.payload)["customer"], LOCAL_CUSTOMER)

    def test_a_voided_customer_sends_the_sale_to_a_person_instead_of_inventing_one(self):
        sale = self._send(SALE, {"customer": LOCAL_CUSTOMER, "pos_profile": "Main"})
        customer = self._send(LOCAL_CUSTOMER, {"customer_name": "Sara", "pos_profile": "Main"}, "customer")
        self._row(customer)["status"] = "Voided"

        with patch("pos_next.services.invoice_processor.process_invoice") as process_invoice:
            sync_inbox.process(sale)

        process_invoice.assert_not_called()
        row = self._row(sale)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_class, "dependency")
        self.assertTrue(row.payload)


class TestPaymentJourney(Flow):
    payload = {
        "doctype": "Payment Entry",
        "invoice_name": "SINV-1",
        "pos_profile": "Main",
        "payments": [{"mode_of_payment": "Cash", "amount": 40}],
    }

    def test_a_resend_never_takes_the_money_twice(self):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=[]),
            patch("pos_next.api.partial_payments.post_queued_payments", return_value=["PE-1"]) as post,
        ):
            first = self._send(PAYMENT, self.payload, "payment")
            sync_inbox.process(first)

            again = self._send(PAYMENT, self.payload, "payment")
            sync_inbox.process(again)

        self.assertEqual(first, again)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(self._row(first).sales_invoice, "PE-1")

    def test_a_refused_payment_keeps_its_payload_and_reason(self):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=[]),
            patch(
                "pos_next.api.partial_payments.post_queued_payments",
                side_effect=frappe.ValidationError("Total payment amount exceeds outstanding amount"),
            ),
        ):
            name = self._send(PAYMENT, self.payload, "payment")
            sync_inbox.process(name)

        row = self._row(name)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertIn("exceeds outstanding", row.error_message)
        self.assertEqual(json.loads(row.payload)["invoice_name"], "SINV-1")


class TestShiftCloseJourney(Flow):
    payload = {
        "doctype": "POS Closing Shift",
        "pos_opening_shift": "POSA-OS-1",
        "pos_profile": "Main",
        "manifest": [SALE, LATE_SALE],
    }

    def _finish(self, offline_id):
        name = self._send(offline_id, {"pos_profile": "Main"})
        self._row(name).update({"status": "Synced", "sales_invoice": "SINV-1"})
        return name

    def test_finalizes_only_after_a_missing_sale_arrives(self):
        finished = {"name": "POS-CLOSE-1", "doctype": "POS Closing Shift", "grand_total": 100}
        handler = sync_inbox._Entity(Mock(return_value=finished), Mock(return_value=None), ())

        with patch.dict(sync_inbox._ENTITIES, {"shift_close": handler}):
            close = self._send(CLOSE, self.payload, "shift_close", depends_on=[SALE])
            self._finish(SALE)

            sync_inbox.process(close)
            self.assertEqual(self._row(close).status, "Blocked")

            self._age(close)
            sync_inbox.sweep()

            row = self._row(close)
            self.assertEqual(row.status, sync_inbox.REVIEW)
            self.assertIn(LATE_SALE, row.error_message)
            self.assertEqual(row.error_class, "dependency")

            sync_inbox.sweep()
            self.assertEqual(self._row(close).status, sync_inbox.REVIEW)
            handler.create.assert_not_called()

            self._finish(LATE_SALE)
            sync_inbox.sweep()
            self.assertEqual(self._row(close).status, "Received")

            sync_inbox.process(close)

        handler.create.assert_called_once()
        self.assertEqual(self._row(close).status, "Synced")
        self.assertEqual(self._row(close).sales_invoice, "POS-CLOSE-1")

    def test_a_shift_with_nothing_queued_closes_at_once(self):
        close = self._send(CLOSE, {**self.payload, "manifest": []}, "shift_close")

        finished = {"name": "POS-CLOSE-1", "doctype": "POS Closing Shift"}
        handler = sync_inbox._Entity(Mock(return_value=finished), Mock(return_value=None), ())
        with patch.dict(sync_inbox._ENTITIES, {"shift_close": handler}):
            sync_inbox.process(close)

        self.assertEqual(self._row(close).status, "Synced")


if __name__ == "__main__":
    unittest.main()
