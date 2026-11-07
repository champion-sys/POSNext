# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""A shift opened on a device, from its queue record to its sales and its close.

These run on stand-ins for the database, so they prove the logic and nothing about MariaDB
or ERPNext. docs/offline-multiplatform/03-sync-engine.md lists what a real site must show.
"""

import json
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe

from pos_next.api import shifts
from pos_next.pos_next.doctype.pos_opening_shift.pos_opening_shift import POSOpeningShift
from pos_next.services import sync_entities, sync_inbox, test_sync_entities, test_sync_flow
from pos_next.services.sync_classifier import (
    BUSINESS,
    LinkedShiftCloseError,
    OfflineShiftNotAllowedError,
    ShiftConflictError,
    ShiftOutdatedError,
    SyncContractError,
    classify,
    next_retry_minutes,
)
from pos_next.services.sync_entities import DOCTYPE

LOCAL_SHIFT = "pos_offline_shift-1"
LATER_SHIFT = "pos_offline_shift-2"
SALE = test_sync_flow.SALE
LATE_SALE = test_sync_flow.LATE_SALE
CLOSE = test_sync_flow.CLOSE
PAYMENT = test_sync_flow.PAYMENT

CASHIER = "cashier@example.com"

OPENING = {
    "doctype": "POS Opening Shift",
    "offline_id": LOCAL_SHIFT,
    "pos_profile": "Main",
    "company": "Acme",
    "cashier": CASHIER,
    "period_start_date": "2026-11-07 08:30:15",
    "balance_details": [{"mode_of_payment": "Cash", "opening_amount": 150}],
}

SALE_PAYLOAD = {"pos_profile": "Main", "posa_pos_opening_shift": LOCAL_SHIFT}


class ShiftInbox(test_sync_flow.FakeInbox):
    """The inbox, with the POS Opening Shift table and the POS Settings of its profile."""

    def __init__(self):
        super().__init__()
        self.opening_shifts = {}
        self.settings = {"allow_offline_shift_open": 1, "invoice_type": "Sales Invoice"}

    def _find_shift(self, filters):
        if isinstance(filters, str):
            shift = self.opening_shifts.get(filters)
            return [shift] if shift else []
        return [shift for shift in self.opening_shifts.values() if self._matches(shift, filters)]

    def get_value(self, doctype, filters=None, fieldname="name", as_dict=False, **kwargs):
        if doctype == "POS Settings":
            return frappe._dict(self.settings)
        if doctype == "POS Opening Shift":
            found = self._find_shift(filters)
            if not found:
                return None
            if isinstance(fieldname, str):
                return found[0].get(fieldname)
            return frappe._dict({field: found[0].get(field) for field in fieldname})
        return super().get_value(doctype, filters, fieldname, as_dict, **kwargs)

    def get_all(self, doctype, filters=None, fields=None, pluck=None, as_list=False, **kwargs):
        if doctype == "POS Opening Shift":
            return [frappe._dict({field: shift.get(field) for field in fields}) for shift in self._find_shift(filters)]
        return super().get_all(doctype, filters, fields, pluck, as_list, **kwargs)

    def exists(self, doctype, name=None):
        if doctype == DOCTYPE:
            return bool(self._find(name))
        if doctype == "POS Opening Shift":
            return name in self.opening_shifts
        return super().exists(doctype, name)


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


class ShiftFlow(test_sync_flow.Flow):
    inbox_class = ShiftInbox

    def setUp(self):
        super().setUp()
        self.created_shifts = []
        for target, replacement in (
            ("pos_next.api.invoices._assert_invoice_write_access", Mock()),
            ("frappe.throw", test_sync_flow._raise),
            ("pos_next.api.shifts._", lambda text: text),
            ("frappe.utils.data.now_datetime", datetime.now),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _new_document(self, values, name=None):
        if values == DOCTYPE:
            return RowDocument(self._row(name))
        if values == "POS Opening Shift":
            return self.inbox.opening_shifts[name]
        if isinstance(values, str):
            return Mock()
        if values.get("doctype") == "POS Opening Shift":
            return self._new_shift(values)
        return super()._new_document(values)

    def _new_shift(self, values):
        document = Mock()
        document.name = f"POSA-OS-{len(self.inbox.opening_shifts) + 1}"
        stored = {}
        document.set.side_effect = lambda fieldname, value: stored.update({fieldname: value})

        def insert(**_kwargs):
            taken = [
                shift
                for shift in self.inbox.opening_shifts.values()
                if values["offline_id"] and shift.offline_id == values["offline_id"]
            ]
            if taken:
                raise frappe.UniqueValidationError("Offline ID already exists")

        def submit():
            self.created_shifts.append({**values, **stored})
            self._add_shift(document.name, **values)

        document.insert.side_effect = insert
        document.submit.side_effect = submit
        return document

    def _add_shift(self, name, **values):
        self.inbox.opening_shifts[name] = frappe._dict(
            {"name": name, "docstatus": 1, "status": "Open", "pos_profile": "Main", "user": CASHIER, **values}
        )

    def _open(self, payload=None, offline_id=LOCAL_SHIFT):
        return self._send(offline_id, payload or OPENING, "shift_open")

    def _post(self, name):
        with patch("pos_next.services.invoice_processor.process_invoice") as self.process_invoice:
            self.process_invoice.return_value = {"name": "SINV-1", "grand_total": 0}
            sync_inbox.process(name)

    def _link(self, name, shift):
        sync_inbox.apply_fix(name, "link_shift", {"shift": shift})
        return sync_inbox.reprocess(name)

    def _refused(self):
        """A record the server would not open, because the cashier has a shift already."""
        self._add_shift("POSA-OS-OPEN")
        name = self._open()
        sync_inbox.process(name)
        return name


class TestTheShiftReachesTheServer(ShiftFlow):
    def test_it_keeps_the_time_and_amounts_of_the_device(self):
        sync_inbox.process(self._open())

        shift = self.created_shifts[0]
        self.assertEqual(shift["period_start_date"], datetime(2026, 11, 7, 8, 30, 15))
        self.assertEqual(str(shift["posting_date"]), "2026-11-07")
        self.assertEqual(shift["balance_details"], [{"mode_of_payment": "Cash", "amount": 150}])
        self.assertEqual(shift["company"], "Acme")

    def test_it_belongs_to_the_cashier_not_to_whoever_runs_the_job(self):
        name = self._open()
        self._row(name)["cashier"] = "sara@example.com"
        frappe.local.session.user = "Administrator"

        sync_inbox.process(name)

        self.assertEqual(self.created_shifts[0]["user"], "sara@example.com")
        self.assertEqual(frappe.session.user, "Administrator")

    def test_it_stores_the_offline_id_and_the_record_stores_the_real_name(self):
        name = self._open()
        sync_inbox.process(name)

        self.assertEqual(self.created_shifts[0]["offline_id"], LOCAL_SHIFT)
        row = self._row(name)
        self.assertEqual(row.status, "Synced")
        self.assertEqual(row.sales_invoice, "POSA-OS-1")
        self.assertEqual(row.invoice_doctype, "POS Opening Shift")

    def test_a_resend_creates_no_second_shift(self):
        first = self._open()
        sync_inbox.process(first)

        again = self._open()
        sync_inbox.process(again)

        self.assertEqual(first, again)
        self.assertEqual(len(self.created_shifts), 1)

    def test_a_record_that_lost_its_status_finds_its_shift(self):
        name = self._open()
        sync_inbox.process(name)
        self._row(name).update({"status": "Received", "sales_invoice": None})

        sync_inbox.process(name)

        self.assertEqual(len(self.created_shifts), 1)
        self.assertEqual(self._row(name).status, "Synced")
        self.assertEqual(self._row(name).sales_invoice, "POSA-OS-1")

    def test_the_unique_index_catching_a_second_worker_counts_as_done(self):
        self._add_shift("POSA-OS-1", offline_id=LOCAL_SHIFT, user="someone@example.com")
        name = self._open()

        handler = sync_inbox._ENTITIES["shift_open"]
        finds = iter([None, handler.find(LOCAL_SHIFT)])
        racing = sync_inbox._Entity(handler.create, lambda _offline_id: next(finds), ())
        with patch.dict(sync_inbox._ENTITIES, {"shift_open": racing}):
            sync_inbox.process(name)

        self.assertEqual(self.created_shifts, [])
        self.assertEqual(self._row(name).status, "Synced")
        self.assertEqual(self._row(name).sales_invoice, "POSA-OS-1")


class TestItsRecords(ShiftFlow):
    def test_a_sale_cannot_process_before_its_shift(self):
        sale = self._send(SALE, SALE_PAYLOAD)

        self._post(sale)

        self.assertEqual(self._row(sale).status, "Blocked")
        self.process_invoice.assert_not_called()

    def test_a_sale_that_named_it_without_saying_so_still_waits(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        self.assertEqual(self._row(sale).depends_on, LOCAL_SHIFT)

    def test_a_sale_posts_under_the_real_name_and_keeps_what_the_device_sent(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        sync_inbox.process(self._open())

        sync_inbox.sweep()
        self._post(sale)

        self.assertEqual(self.process_invoice.call_args.args[0]["posa_pos_opening_shift"], "POSA-OS-1")
        self.assertEqual(self._row(sale).status, "Synced")
        self.assertEqual(json.loads(self._row(sale).payload)["posa_pos_opening_shift"], LOCAL_SHIFT)

    def test_a_pos_invoice_passes_the_open_shift_check(self):
        sale = self._send(SALE, {**SALE_PAYLOAD, "doctype": "POS Invoice"})
        sync_inbox.process(self._open())

        sync_inbox.sweep()
        self._post(sale)

        self.assertEqual(self._row(sale).status, "Synced")

    def test_records_stored_first_join_the_shift_when_it_is_created(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        close = self._send(CLOSE, {"pos_opening_shift": LOCAL_SHIFT, "pos_profile": "Main"}, "shift_close")
        self.assertIsNone(self._row(sale).shift)

        sync_inbox.process(self._open())

        self.assertEqual(self._row(sale).shift, "POSA-OS-1")
        self.assertEqual(self._row(close).shift, "POSA-OS-1")

    def test_a_record_stored_afterwards_is_on_the_shift_from_the_start(self):
        sync_inbox.process(self._open())

        sale = self._send(SALE, SALE_PAYLOAD)

        self.assertEqual(self._row(sale).shift, "POSA-OS-1")

    def test_a_record_a_manager_moved_stays_where_it_went(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        self._row(sale)["shift"] = "POSA-OS-ELSEWHERE"

        sync_inbox.process(self._open())

        self.assertEqual(self._row(sale).shift, "POSA-OS-ELSEWHERE")

    def test_a_queued_close_is_seen_as_pending_on_the_real_shift(self):
        self._send(CLOSE, {"pos_opening_shift": LOCAL_SHIFT, "pos_profile": "Main"}, "shift_close")
        sync_inbox.process(self._open())

        self.assertTrue(sync_entities.has_pending_close("POSA-OS-1"))

    def test_a_payment_of_the_shift_waits_and_posts_under_the_real_name(self):
        payload = {
            "invoice_name": "SINV-1",
            "pos_profile": "Main",
            "posa_pos_opening_shift": LOCAL_SHIFT,
            "payments": [{"mode_of_payment": "Cash", "amount": 40}],
        }
        with (
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=[]),
            patch("pos_next.api.partial_payments.post_queued_payments", return_value=["PE-1"]) as post,
        ):
            payment = self._send(PAYMENT, payload, "payment")
            sync_inbox.process(payment)
            self.assertEqual(self._row(payment).status, "Blocked")

            sync_inbox.process(self._open())
            sync_inbox.sweep()
            sync_inbox.process(payment)

        self.assertEqual(post.call_args.args[3], "POSA-OS-1")

    def _close_it(self, name):
        closing = {"pos_opening_shift": "x", "payment_reconciliation": [], "posting_date": "", "period_end_date": ""}
        module = "pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift"
        with (
            patch("pos_next.api.shifts.assert_may_close_shift"),
            patch(f"{module}.build_closing_shift", return_value=closing),
            patch(f"{module}.save_closing_shift", return_value="POS-CLOSE-1") as self.submit_close,
        ):
            sync_inbox.process(name)

    def test_a_close_waits_for_the_shift_and_closes_the_real_one(self):
        close = self._send(CLOSE, {"pos_opening_shift": LOCAL_SHIFT, "pos_profile": "Main"}, "shift_close")
        self._close_it(close)
        self.assertEqual(self._row(close).status, "Blocked")

        sync_inbox.process(self._open())
        self.inbox.opening_shifts["POSA-OS-1"].as_dict = lambda: {"name": "POSA-OS-1"}
        sync_inbox.sweep()
        self._close_it(close)

        self.assertEqual(self._row(close).status, "Synced")
        self.assertEqual(self._row(close).sales_invoice, "POS-CLOSE-1")

    def test_a_close_of_a_linked_shift_goes_to_a_person_and_leaves_that_shift_open(self):
        self._add_shift("POSA-OS-OPEN")
        close = self._send(CLOSE, {"pos_opening_shift": LOCAL_SHIFT, "pos_profile": "Main"}, "shift_close")
        name = self._refused()
        self._link(name, "POSA-OS-OPEN")

        sync_inbox.sweep()
        self._close_it(close)

        self.submit_close.assert_not_called()
        row = self._row(close)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "LinkedShiftCloseError")

    def test_a_later_shift_waits_for_the_close_before_it(self):
        close = self._send(CLOSE, {"pos_opening_shift": "POSA-OS-OLD", "pos_profile": "Main"}, "shift_close")
        later = self._send(LATER_SHIFT, {**OPENING, "offline_id": LATER_SHIFT}, "shift_open", depends_on=[CLOSE])

        sync_inbox.process(later)

        self.assertEqual(self._row(later).status, "Blocked")
        self.assertEqual(self.created_shifts, [])

        self._row(close).update({"status": "Synced", "sales_invoice": "POS-CLOSE-1"})
        sync_inbox.sweep()
        sync_inbox.process(later)

        self.assertEqual(self._row(later).status, "Synced")


class TestARefusal(ShiftFlow):
    def test_a_cashier_with_a_shift_goes_to_a_person_with_a_stable_code(self):
        name = self._refused()

        row = self._row(name)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "ShiftConflictError")
        self.assertEqual(row.error_class, BUSINESS)
        self.assertEqual(self.created_shifts, [])

    def test_its_sales_stay_blocked_and_keep_their_payload(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        self._age(sale)
        self._refused()

        self._post(sale)
        sync_inbox.sweep()

        row = self._row(sale)
        self.assertEqual(row.status, "Blocked")
        self.assertEqual(json.loads(row.payload)["posa_pos_opening_shift"], LOCAL_SHIFT)
        self.process_invoice.assert_not_called()

    def test_reprocessing_after_the_other_shift_closed_creates_it(self):
        name = self._refused()
        self.inbox.opening_shifts["POSA-OS-OPEN"].status = "Closed"

        sync_inbox.reprocess(name)

        self.assertEqual(self._row(name).status, "Synced")
        self.assertEqual(self.created_shifts[0]["offline_id"], LOCAL_SHIFT)

    def test_voiding_it_hands_its_sales_to_a_person(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        name = self._refused()

        sync_inbox.void(name, "Opened by mistake")
        sync_inbox.sweep()
        self._post(sale)

        row = self._row(sale)
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_class, "dependency")
        self.process_invoice.assert_not_called()


class TestTheManagersLink(ShiftFlow):
    def test_its_sales_go_to_the_open_shift(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        name = self._refused()

        self._link(name, "POSA-OS-OPEN")
        self.assertEqual(self._row(name).status, "Synced")
        self.assertEqual(self._row(name).sales_invoice, "POSA-OS-OPEN")
        self.assertEqual(self._row(sale).shift, "POSA-OS-OPEN")

        sync_inbox.sweep()
        self._post(sale)

        self.assertEqual(self.process_invoice.call_args.args[0]["posa_pos_opening_shift"], "POSA-OS-OPEN")
        self.assertEqual(self._row(sale).status, "Synced")

    def test_it_creates_no_shift(self):
        self._link(self._refused(), "POSA-OS-OPEN")
        self.assertEqual(self.created_shifts, [])

    def test_a_pos_invoice_goes_to_whoever_holds_that_shift(self):
        sale = self._send(SALE, {**SALE_PAYLOAD, "doctype": "POS Invoice"})
        name = self._refused()
        self.inbox.opening_shifts["POSA-OS-OPEN"].user = "colleague@example.com"

        self._link(name, "POSA-OS-OPEN")

        self.assertEqual(self._row(sale).cashier, "colleague@example.com")

    def test_a_sales_invoice_keeps_its_cashier(self):
        sale = self._send(SALE, SALE_PAYLOAD)
        name = self._refused()
        self.inbox.opening_shifts["POSA-OS-OPEN"].user = "colleague@example.com"

        self._link(name, "POSA-OS-OPEN")

        self.assertEqual(self._row(sale).cashier, CASHIER)

    def _assert_link_refused(self, name, shift):
        with self.assertRaises(frappe.ValidationError):
            sync_inbox.apply_fix(name, "link_shift", {"shift": shift})

    def test_a_closed_shift_is_refused(self):
        name = self._refused()
        self._add_shift("POSA-OS-CLOSED", status="Closed")
        self._assert_link_refused(name, "POSA-OS-CLOSED")

    def test_another_profiles_shift_is_refused(self):
        name = self._refused()
        self._add_shift("POSA-OS-ELSEWHERE", pos_profile="Other")
        self._assert_link_refused(name, "POSA-OS-ELSEWHERE")

    def test_a_shift_that_does_not_exist_is_refused(self):
        self._assert_link_refused(self._refused(), "POSA-OS-GONE")

    def test_a_shift_a_device_already_closed_is_refused(self):
        name = self._refused()
        self._send(CLOSE, {"pos_opening_shift": "POSA-OS-OPEN", "pos_profile": "Main"}, "shift_close")
        self._assert_link_refused(name, "POSA-OS-OPEN")

    def test_a_shift_closed_after_the_fix_stops_the_reprocess(self):
        name = self._refused()
        sync_inbox.apply_fix(name, "link_shift", {"shift": "POSA-OS-OPEN"})
        self.inbox.opening_shifts["POSA-OS-OPEN"].status = "Closed"

        sync_inbox.reprocess(name)

        self.assertEqual(self._row(name).status, sync_inbox.REVIEW)
        self.assertEqual(self._row(name).sales_invoice, None)

    def test_a_device_cannot_set_the_link_itself(self):
        item = {
            "offline_id": LOCAL_SHIFT,
            "entity": "shift_open",
            "pos_profile": "Main",
            "payload": {**OPENING, "linked_shift": "POSA-OS-COLLEAGUE"},
        }
        self.assertEqual(sync_inbox.validate_envelope(item), "A device cannot link a shift")

    def test_the_general_link_cannot_skip_those_checks(self):
        name = self._refused()
        with self.assertRaises(frappe.ValidationError):
            sync_inbox.link_existing_invoice(name, "POSA-OS-OPEN", "POS Opening Shift", "By hand")


class TestOpenShiftHandler(test_sync_entities.NoSiteTestCase):
    def _settings(self, allowed=1, invoice_type="Sales Invoice"):
        frappe.local.db.get_value.return_value = frappe._dict(
            allow_offline_shift_open=allowed, invoice_type=invoice_type
        )

    def _open(self, payload=OPENING, **fields):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access") as self.access,
            patch("pos_next.api.shifts.insert_opening_shift", return_value=Mock(name="shift")) as self.insert,
            patch("pos_next.services.sync_entities.frappe.get_all", return_value=[]),
        ):
            row = test_sync_entities._row(entity="shift_open", payload=json.dumps(payload), **fields)
            return sync_entities.open_shift(row)

    def test_a_shift_with_no_time_or_amounts_is_a_contract_problem(self):
        self._settings()
        for missing in ("period_start_date", "balance_details"):
            with self.assertRaises(SyncContractError):
                self._open({**OPENING, missing: None})

    def test_the_server_decides_whether_a_shift_may_open_offline(self):
        self._settings(allowed=0)
        with self.assertRaises(OfflineShiftNotAllowedError):
            self._open()
        self.insert.assert_not_called()

    def test_a_profile_with_no_settings_does_not_allow_it(self):
        frappe.local.db.get_value.return_value = None
        with self.assertRaises(OfflineShiftNotAllowedError):
            self._open()

    def test_a_pos_invoice_shift_from_an_earlier_day_would_refuse_its_own_sales(self):
        self._settings(invoice_type="POS Invoice")
        with (
            patch("pos_next.services.sync_entities.nowdate", return_value="2026-11-08"),
            self.assertRaises(ShiftOutdatedError),
        ):
            self._open()
        self.insert.assert_not_called()

    def test_a_pos_invoice_shift_from_today_opens(self):
        self._settings(invoice_type="POS Invoice")
        with patch("pos_next.services.sync_entities.nowdate", return_value="2026-11-07"):
            self._open()
        self.insert.assert_called_once()

    def test_a_sales_invoice_shift_from_an_earlier_day_opens(self):
        self._settings()
        self._open({**OPENING, "period_start_date": "2020-01-01 09:00:00"})
        self.insert.assert_called_once()

    def test_goes_through_the_online_path(self):
        self._settings()
        self._open()
        args = self.insert.call_args.args
        self.assertEqual(args[:3], ("Main", "Acme", OPENING["balance_details"]))
        self.assertEqual(args[4], "pos_offline_row-1")

    def test_checks_the_cashier_and_the_uploader_against_the_profile(self):
        self._settings()
        self._open(uploaded_by="uploader@example.com")
        self.assertEqual(
            [call.args for call in self.access.call_args_list],
            [("Sales Invoice", "Main", CASHIER), ("Sales Invoice", "Main", "uploader@example.com")],
        )

    def test_someone_with_no_access_stops_it(self):
        self._settings()
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access", side_effect=frappe.PermissionError),
            patch("pos_next.api.shifts.insert_opening_shift") as insert,
        ):
            row = test_sync_entities._row(entity="shift_open", payload=json.dumps(OPENING))
            with self.assertRaises(frappe.PermissionError):
                sync_entities.open_shift(row)
        insert.assert_not_called()

    def test_finds_only_a_submitted_shift(self):
        frappe.local.db.get_value.return_value = "POSA-OS-1"

        self.assertEqual(
            sync_entities.find_shift_open(LOCAL_SHIFT), {"name": "POSA-OS-1", "doctype": "POS Opening Shift"}
        )
        filters = frappe.local.db.get_value.call_args.args[1]
        self.assertEqual(filters, {"offline_id": LOCAL_SHIFT, "docstatus": 1})


class TestServerNames(test_sync_entities.NoSiteTestCase):
    def test_a_sale_depends_on_a_local_shift_even_if_the_device_left_it_out(self):
        self.assertEqual(sync_entities.get_dependencies(SALE_PAYLOAD), [LOCAL_SHIFT])

    def test_a_close_depends_on_a_local_shift_even_if_the_device_left_it_out(self):
        self.assertEqual(sync_entities.get_dependencies({"pos_opening_shift": LOCAL_SHIFT}), [LOCAL_SHIFT])

    def test_a_shift_the_server_knows_is_no_dependency(self):
        self.assertEqual(sync_entities.get_dependencies({"posa_pos_opening_shift": "POSA-OS-1"}), [])

    def test_a_server_name_is_left_alone(self):
        self.assertEqual(sync_entities.get_server_shift({"pos_opening_shift": "POSA-OS-1"}), "POSA-OS-1")

    def test_a_local_name_gives_what_the_server_made_of_it(self):
        frappe.local.db.get_value.return_value = "POSA-OS-1"
        self.assertEqual(sync_entities.get_server_shift(SALE_PAYLOAD), "POSA-OS-1")

    def test_a_shift_still_on_its_way_gives_nothing(self):
        frappe.local.db.get_value.return_value = None
        self.assertIsNone(sync_entities.get_server_shift(SALE_PAYLOAD))


class TestOnlinePath(test_sync_entities.NoSiteTestCase):
    """create_opening_shift and the queue share insert_opening_shift."""

    def _insert(self, *args, **kwargs):
        self.document = Mock()
        with (
            patch("frappe.utils.data.now_datetime", datetime.now),
            patch("pos_next.api.shifts.check_opening_shift", return_value=None),
            patch("pos_next.api.shifts.frappe.get_doc", return_value=self.document) as self.get_doc,
        ):
            return shifts.insert_opening_shift("Main", "Acme", [{"mode_of_payment": "Cash", "opening_amount": 5}], *args, **kwargs)

    def test_online_it_opens_now_and_has_no_offline_id(self):
        before = datetime.now()
        self._insert()

        values = self.get_doc.call_args.args[0]
        self.assertGreaterEqual(values["period_start_date"], before.replace(microsecond=0))
        self.assertIsNone(values["offline_id"])

    def test_it_is_submitted_which_is_what_creates_the_pos_opening_entry(self):
        document = self._insert()
        self.assertIs(document, self.document)
        document.insert.assert_called_once_with(ignore_permissions=True)
        document.submit.assert_called_once_with()

    def test_the_amounts_map_to_the_shifts_field(self):
        self._insert()
        self.document.set.assert_called_once_with("balance_details", [{"mode_of_payment": "Cash", "amount": 5}])

    def _create(self):
        self.shift = Mock()
        with (
            patch("pos_next.api.shifts.insert_opening_shift", return_value=self.shift) as self.create,
            patch("pos_next.api.shifts.frappe.get_doc", side_effect=lambda doctype, name: f"{doctype} {name}"),
        ):
            return shifts.create_opening_shift("Main", "Acme", '[{"mode_of_payment": "Cash", "opening_amount": 5}]')

    def test_create_opening_shift_still_answers_with_the_three_documents(self):
        with patch("pos_next.api.invoices._assert_invoice_write_access"):
            data = self._create()

        self.create.assert_called_once_with("Main", "Acme", [{"mode_of_payment": "Cash", "opening_amount": 5}])
        self.assertEqual(data["pos_opening_shift"], self.shift.as_dict())
        self.assertEqual(data["pos_profile"], "POS Profile Main")
        self.assertEqual(data["company"], "Company Acme")

    def test_someone_outside_the_profile_opens_nothing_and_reads_nothing(self):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access", side_effect=frappe.PermissionError) as access,
            self.assertRaises(frappe.PermissionError),
        ):
            self._create()

        access.assert_called_once_with("Sales Invoice", "Main")
        self.create.assert_not_called()

    def test_the_role_for_closing_does_not_stop_a_cashier_opening(self):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access"),
            patch("pos_next.api.shifts.assert_may_close_shift", side_effect=frappe.PermissionError),
        ):
            self.assertIn("pos_opening_shift", self._create())

    def test_a_cashier_with_a_shift_is_refused_with_the_stable_code(self):
        with patch("pos_next.api.shifts.check_opening_shift", return_value={"pos_opening_shift": Mock()}):
            with self.assertRaises(ShiftConflictError):
                shifts.insert_opening_shift("Main", "Acme", [])


class TestRefusalCodes(test_sync_entities.NoSiteTestCase):
    def _shift(self):
        return Mock(pos_profile="Main", name="NEW", user=CASHIER, pos_opening_entry=None)

    def test_another_shift_on_the_profile_gets_the_stable_code(self):
        frappe.local.db.get_value.return_value = frappe._dict(name="POSA-OS-1", user="other@example.com")
        with self.assertRaises(ShiftConflictError):
            POSOpeningShift.validate_no_other_active_shift(self._shift())

    def test_an_open_standard_entry_gets_the_stable_code(self):
        entry = frappe._dict(name="POE-1", user="other@example.com", period_start_date=datetime(2026, 11, 7, 8))
        frappe.local.db.get_value.side_effect = [None, entry]
        shift = self._shift()
        shift.is_blocked_by_opening_entry.return_value = True

        with patch("frappe.utils.formatdate", return_value="2026-11-07"):
            with self.assertRaises(ShiftConflictError):
                POSOpeningShift.validate_no_other_active_shift(shift)

    def test_each_refusal_needs_a_person_and_keeps_its_name(self):
        for exc in (ShiftConflictError, ShiftOutdatedError, OfflineShiftNotAllowedError, LinkedShiftCloseError):
            result = classify(exc("No"))
            self.assertEqual(result.error_class, BUSINESS)
            self.assertEqual(result.error_code, exc.__name__)
            self.assertIsNone(next_retry_minutes(result.error_class, 1))

    def test_the_online_path_still_sees_a_validation_error(self):
        self.assertTrue(issubclass(ShiftConflictError, frappe.ValidationError))


class TestSchema(unittest.TestCase):
    """What only exists on a site after a migrate, read from the files that declare it."""

    @staticmethod
    def _fields(path):
        with open(frappe.get_app_path("pos_next", *path), encoding="utf-8") as handle:
            return json.load(handle)

    def test_the_inbox_accepts_the_entity(self):
        doctype = self._fields(("pos_next", "doctype", "offline_invoice_sync", "offline_invoice_sync.json"))
        entity = next(field for field in doctype["fields"] if field["fieldname"] == "entity")
        self.assertIn("shift_open", entity["options"].split("\n"))

    def test_a_shift_can_hold_one_offline_id_and_no_amended_copy_inherits_it(self):
        doctype = self._fields(("pos_next", "doctype", "pos_opening_shift", "pos_opening_shift.json"))
        field = next(field for field in doctype["fields"] if field["fieldname"] == "offline_id")
        self.assertEqual(field["unique"], 1)
        self.assertEqual(field["no_copy"], 1)
        self.assertIn("offline_id", doctype["field_order"])

    def test_the_setting_is_off_unless_someone_turns_it_on(self):
        doctype = self._fields(("pos_next", "doctype", "pos_settings", "pos_settings.json"))
        field = next(field for field in doctype["fields"] if field["fieldname"] == "allow_offline_shift_open")
        self.assertEqual(field["default"], "0")
        self.assertIn("allow_offline_shift_open", doctype["field_order"])

    def test_the_setting_reaches_the_device(self):
        from pos_next.api.constants import DEFAULT_POS_SETTINGS, POS_SETTINGS_FIELDS

        self.assertIn("allow_offline_shift_open", POS_SETTINGS_FIELDS)
        self.assertEqual(DEFAULT_POS_SETTINGS["allow_offline_shift_open"], 0)

    def test_the_form_lists_the_setting(self):
        with open(frappe.get_app_path("pos_next", "pos_next", "custom", "pos_settings.json"), encoding="utf-8") as handle:
            self.assertIn("allow_offline_shift_open", handle.read())


if __name__ == "__main__":
    unittest.main()
