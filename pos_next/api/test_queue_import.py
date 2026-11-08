# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Through the real import, push and inbox, with only the database faked."""

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

import frappe
from werkzeug.test import EnvironBuilder
from werkzeug.wrappers import Request

from pos_next.api import queue_import
from pos_next.api import sync as sync_api
from pos_next.services import sync_inbox, sync_void
from pos_next.services.test_sync_flow import LATE_SALE, SALE, Upload

MANAGER = "manager@example.com"
CASHIER = "lina@example.com"
DEVICE = "device-old-phone"
INVOICE = {"name": "SINV-1", "doctype": "Sales Invoice", "grand_total": 0}

# POS/src/utils/offline/__tests__/queueFile.test.js writes the same file
EXPORTED_FILE = Path(__file__).parents[2] / "POS/src/utils/offline/__tests__/fixtures/queue-file-v1.json"


def _upload(content):
    builder = EnvironBuilder(method="POST", data={"file": (BytesIO(content), "queue.json")})
    return Request(builder.get_environ())


class ImportFlow(Upload):
    def setUp(self):
        super().setUp()
        self.roles = ["Nexus POS Manager"]
        self.profile_writers.add(MANAGER)
        self.document_types = []
        frappe.local.session.user = MANAGER
        self.addCleanup(setattr, frappe.local, "request", None)

        for target, replacement in (
            ("frappe.get_roles", lambda: self.roles),
            ("frappe.log_error", Mock()),
            ("pos_next.api.queue_import._", lambda text: text),
            ("pos_next.services.queue_file._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _new_document(self, values):
        self.document_types.append(values["doctype"])
        return super()._new_document(values)

    @staticmethod
    def file(*rows, **header):
        return json.dumps(
            {
                "format_version": 1,
                "device_id": DEVICE,
                "app_version": "1.16.0",
                "server": "https://old.example.com",
                "exported_at": "2026-11-07T10:00:00.000Z",
                "protocol_version": 1,
                "rows": list(rows),
                **header,
            }
        ).encode()

    def import_file(self, content):
        frappe.local.request = _upload(content)
        return queue_import.import_queue_file()

    def import_rows(self, *rows, **header):
        return self.import_file(self.file(*rows, **header))

    @staticmethod
    def counts(result):
        return tuple(result[key] for key in ("stored", "already_known", "conflicts", "rejected"))

    def process_all(self, create):
        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(create, Mock(return_value=None), ())}):
            for name in sync_inbox._due_rows():
                sync_inbox.process(name)


class TestWhoMayImport(ImportFlow):
    def test_a_cashier_is_refused_and_nothing_is_stored(self):
        self.roles = ["POSNext Cashier"]

        with self.assertRaises(frappe.PermissionError):
            self.import_rows(self.item())

        self.assertEqual(self.inbox.rows, {})

    def test_a_cashier_is_refused_before_the_file_is_looked_at(self):
        self.roles = ["POSNext Cashier"]

        with self.assertRaises(frappe.PermissionError):
            self.import_file(b"not even json")

    def test_a_pos_manager_may(self):
        self.assertEqual(self.import_rows(self.item())["stored"], 1)

    def test_a_system_manager_may(self):
        self.roles = ["System Manager"]
        self.assertEqual(self.import_rows(self.item())["stored"], 1)

    def test_only_post_reaches_it(self):
        self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[queue_import.import_queue_file], ["POST"])

    def test_it_is_not_open_to_guests(self):
        self.assertNotIn(queue_import.import_queue_file, frappe.guest_methods)


class TestAFileThatCannotBeRead(ImportFlow):
    def assert_nothing_stored(self, content, exception=frappe.ValidationError):
        with self.assertRaises(exception):
            self.import_file(content)

        self.assertEqual(self.inbox.rows, {})
        sync_inbox.enqueue_processing.assert_not_called()

    def test_not_json(self):
        self.assert_nothing_stored(b"{broken")

    def test_an_unknown_version(self):
        self.assert_nothing_stored(self.file(self.item(), format_version=2))

    def test_over_the_limit(self):
        with patch("pos_next.services.queue_file.MAX_FILE_BYTES", 10):
            self.assert_nothing_stored(self.file(self.item()))

    def test_a_request_with_no_file(self):
        frappe.local.request = Request(EnvironBuilder(method="POST").get_environ())

        with self.assertRaises(frappe.ValidationError):
            queue_import.import_queue_file()


class TestWhatIsStored(ImportFlow):
    def test_each_row_is_recorded_as_the_managers_upload_from_that_device(self):
        self.import_rows(self.item(seq=7, created_at_device="2026-11-06T10:00:00.000Z"))

        row = self.stored()
        self.assertEqual(row.uploaded_by, MANAGER)
        self.assertEqual(row.device_id, DEVICE)
        self.assertEqual(row.client_version, "1.16.0")
        self.assertEqual(row.protocol_version, 1)
        self.assertEqual(row.seq, 7)
        self.assertEqual(row.status, "Received")

    def test_a_file_with_no_device_id_still_imports(self):
        self.import_rows(self.item(), device_id=None)
        self.assertIsNone(self.stored().device_id)

    def test_it_goes_to_the_normal_job_and_not_inside_the_request(self):
        self.import_rows(self.item(), self.item(LATE_SALE))

        sync_inbox.enqueue_processing.assert_called_once_with("Main")
        self.assertEqual({row.status for row in self.inbox.rows.values()}, {"Received"})

    def test_each_profile_gets_its_job(self):
        self.import_rows(self.item(), self.item(LATE_SALE, pos_profile="Other"))

        self.assertEqual(
            {call.args[0] for call in sync_inbox.enqueue_processing.call_args_list}, {"Main", "Other"}
        )

    def test_rows_are_due_in_queue_order(self):
        first = self.item("pos_offline_first", seq=1, created_at_device="2026-11-06 10:00:00")
        second = self.item("pos_offline_second", seq=2, created_at_device="2026-11-06 10:00:00")

        self.import_rows(second, first)

        self.assertEqual([row.offline_id for row in self.inbox.rows.values()], ["pos_offline_first", "pos_offline_second"])

    def test_the_file_itself_is_never_kept(self):
        self.import_rows(self.item(), self.item(LATE_SALE))
        self.assertEqual(set(self.document_types), {"Offline Invoice Sync"})

    def test_an_empty_file_is_fine(self):
        self.assertEqual(self.counts(self.import_rows()), (0, 0, 0, 0))


class TestWhatIsReported(ImportFlow):
    def test_every_outcome_in_one_file(self):
        self.import_rows(self.item("pos_offline_held"))
        sync_inbox.enqueue_processing.reset_mock()

        changed = self.item("pos_offline_held")
        changed["payload"]["grand_total"] = 999
        result = self.import_rows(
            self.item("pos_offline_new", seq=1),
            self.item("pos_offline_held", seq=2),
            {**changed, "seq": 3},
            {"seq": 4, "offline_id": "pos_offline_bad"},
        )

        self.assertEqual(self.counts(result), (1, 1, 1, 1))

    def test_it_names_what_it_refused(self):
        self.import_rows(self.item())
        changed = self.item()
        changed["payload"]["grand_total"] = 999

        result = self.import_rows(changed, {"offline_id": "pos_offline_bad"})

        by_status = {problem["status"]: problem for problem in result["problems"]}
        self.assertEqual(by_status["conflict"]["offline_id"], SALE)
        self.assertEqual(by_status["rejected"]["offline_id"], "pos_offline_bad")
        self.assertEqual(by_status["rejected"]["message"], "Missing payload")

    def test_a_flood_of_bad_rows_is_counted_but_not_listed_in_full(self):
        rows = [{"offline_id": f"bad-{index}"} for index in range(queue_import.MAX_PROBLEMS + 5)]

        result = self.import_rows(*rows)

        self.assertEqual(result["rejected"], queue_import.MAX_PROBLEMS + 5)
        self.assertEqual(len(result["problems"]), queue_import.MAX_PROBLEMS)

    def test_it_says_where_the_file_claims_to_come_from(self):
        result = self.import_rows()

        self.assertEqual(result["device_id"], DEVICE)
        self.assertEqual(result["server"], "https://old.example.com")
        self.assertEqual(result["exported_at"], "2026-11-07T10:00:00.000Z")


class TestOneBadRow(ImportFlow):
    def assert_alone(self, bad):
        result = self.import_rows(self.item("pos_offline_first", seq=1), bad, self.item("pos_offline_last", seq=3))

        self.assertEqual(self.counts(result), (2, 0, 0, 1))
        self.assertEqual(
            {row.offline_id for row in self.inbox.rows.values()}, {"pos_offline_first", "pos_offline_last"}
        )

    def test_not_an_object(self):
        self.assert_alone("junk")

    def test_no_payload(self):
        self.assert_alone({"seq": 2, "offline_id": "pos_offline_bad"})

    def test_an_id_that_is_not_text(self):
        self.assert_alone({"seq": 2, "offline_id": {"like": "%"}, "pos_profile": "Main", "payload": {}})

    def test_an_id_that_is_a_list(self):
        self.assert_alone({"seq": 2, "offline_id": ["pos_offline_first"], "payload": {"pos_profile": "Main"}})

    def test_an_unknown_kind_of_record(self):
        self.assert_alone(self.item("pos_offline_bad", seq=2, entity="salary"))

    def test_a_payload_for_another_profile_than_the_row(self):
        bad = self.item("pos_offline_bad", seq=2)
        bad["payload"]["pos_profile"] = "Other"
        self.assert_alone(bad)

    def test_a_row_that_blows_up_while_it_is_stored(self):
        self.assert_alone(self.item("pos_offline_bad", seq=2, depends_on=5))

    def test_a_profile_this_manager_cannot_reach(self):
        self.profile_writers.clear()
        self.inbox.assigned["Main"].add(MANAGER)

        self.assert_alone(self.item("pos_offline_bad", seq=2, pos_profile="Other", cashier="omar@example.com"))

    def test_it_leaves_no_message_for_the_whole_response(self):
        frappe.local.message_log = []
        self.import_rows(self.item(pos_profile="Other", depends_on=5))
        self.assertEqual(frappe.local.message_log, [])


class TestWhatAnEditedFileCannotDo(ImportFlow):
    def test_a_colleague_on_the_profile_keeps_the_sale(self):
        self.import_rows(self.item(cashier="sara@example.com"))
        self.assertEqual(self.stored().cashier, "sara@example.com")

    def _process_stored(self):
        users = []

        def create(_row):
            users.append(frappe.session.user)
            return {"name": "SINV-1", "doctype": "Sales Invoice"}

        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(create, Mock(return_value=None), ())}):
            sync_inbox.process(self.stored().name)
        return users

    # The cashier may have left the profile since the file was made: a person decides
    def test_a_cashier_from_elsewhere_is_not_given_to_the_manager(self):
        self.import_rows(self.item(cashier="omar@example.com"))

        self.assertEqual(self.stored().cashier, "omar@example.com")
        self.assertEqual(self._process_stored(), [])
        self.assertEqual(self.stored().status, sync_inbox.REVIEW)
        self.assertEqual(self.stored().error_code, "CashierNotOnProfileError")

    def test_a_name_with_high_roles_is_not_enough(self):
        self.profile_writers.add("Administrator")

        self.import_rows(self.item(cashier="Administrator"))

        self.assertEqual(self._process_stored(), [])
        self.assertEqual(self.stored().error_code, "CashierNotOnProfileError")

    def test_the_uploader_cannot_be_claimed(self):
        self.import_rows(self.item(uploaded_by="sara@example.com"))
        self.assertEqual(self.stored().uploaded_by, MANAGER)

    def test_the_header_cannot_claim_it_either(self):
        self.import_rows(self.item(), uploaded_by="sara@example.com", cashier="sara@example.com")

        self.assertEqual(self.stored().uploaded_by, MANAGER)
        self.assertEqual(self.stored().cashier, CASHIER)

    def test_a_row_cannot_finish_itself_or_wave_its_checks_through(self):
        self.import_rows(
            self.item(
                status="Synced",
                sales_invoice="SINV-1",
                accept_unfinished=1,
                accept_total_difference=1,
                resolution="Reprocessed",
            )
        )

        row = self.stored()
        self.assertEqual(row.status, "Received")
        self.assertFalse(row.get("sales_invoice"))
        self.assertFalse(row.get("accept_unfinished"))
        self.assertFalse(row.get("accept_total_difference"))
        self.assertFalse(row.get("resolution"))

    def test_a_stored_sale_cannot_be_overwritten(self):
        self.import_rows(self.item())
        before = self.stored().payload
        changed = self.item()
        changed["payload"]["grand_total"] = 1

        result = self.import_rows(changed)

        self.assertEqual(result["conflicts"], 1)
        self.assertEqual(self.stored().payload, before)

    def test_a_device_id_claim_is_only_a_label(self):
        self.import_rows(self.item(), device_id="some-enrolled-device")

        self.assertEqual(self.stored().device_id, "some-enrolled-device")
        self.assertEqual(self.stored().uploaded_by, MANAGER)


class TestTheDeviceSendsItToo(ImportFlow):
    """Exporting leaves the rows queued, so the same sale can arrive both ways."""

    def push_as_the_cashier(self, item):
        frappe.local.session.user = CASHIER
        try:
            return self.push(item)[item["offline_id"]]
        finally:
            frappe.local.session.user = MANAGER

    def setUp(self):
        super().setUp()
        self.create = Mock(return_value=INVOICE)

    def test_imported_first_and_processed_then_pushed(self):
        item = self.item()
        self.import_rows(item)
        self.process_all(self.create)

        answer = self.push_as_the_cashier(item)
        self.process_all(self.create)

        self.create.assert_called_once()
        self.assertEqual(len(self.inbox.rows), 1)
        self.assertEqual(answer["status"], "synced")
        self.assertEqual(answer["invoice"], "SINV-1")

    def test_imported_first_and_pushed_before_any_job_ran(self):
        item = self.item()
        self.import_rows(item)

        answer = self.push_as_the_cashier(item)
        self.process_all(self.create)

        self.create.assert_called_once()
        self.assertEqual(len(self.inbox.rows), 1)
        self.assertEqual(answer["status"], "received")

    def test_pushed_first_then_imported(self):
        item = self.item()
        self.push_as_the_cashier(item)
        self.process_all(self.create)

        result = self.import_rows(item)
        self.process_all(self.create)

        self.create.assert_called_once()
        self.assertEqual(self.counts(result), (0, 1, 0, 0))

    def test_the_device_keeps_its_own_name_on_the_record(self):
        item = self.item()
        self.push_as_the_cashier(item)

        self.import_rows(item)

        self.assertEqual(self.stored().uploaded_by, CASHIER)

    def test_the_same_file_twice(self):
        content = self.file(self.item(), self.item(LATE_SALE))

        self.import_file(content)
        self.process_all(self.create)
        result = self.import_file(content)
        self.process_all(self.create)

        self.assertEqual(self.create.call_count, 2)
        self.assertEqual(self.counts(result), (0, 2, 0, 0))

    def test_a_print_after_the_export_is_not_a_different_sale(self):
        item = self.item()
        self.import_rows(item)

        printed = self.item()
        printed["payload"].update(was_printed=True, last_printed_at=1730000000000)

        self.assertEqual(self.push_as_the_cashier(printed)["status"], "received")
        self.assertEqual(len(self.inbox.rows), 1)

    def test_a_different_sale_under_the_same_id_is_not_posted(self):
        self.import_rows(self.item())
        changed = self.item()
        changed["payload"]["grand_total"] = 999

        answer = self.push_as_the_cashier(changed)
        self.process_all(self.create)

        self.assertEqual(answer["status"], "conflict")
        self.create.assert_called_once()


class TestASaleEditedAfterTheExport(ImportFlow):
    def edit(self, status=None):
        edit = self.item(LATE_SALE)
        edit["payload"]["edited_from"] = SALE
        frappe.local.session.user = CASHIER
        self.push(edit)
        frappe.local.session.user = MANAGER
        if status:
            self.stored(LATE_SALE)["status"] = status

    def test_the_original_is_refused_once_the_edit_is_held(self):
        self.edit()

        result = self.import_rows(self.item())

        self.assertEqual(self.counts(result), (0, 0, 1, 0))
        self.assertIn(LATE_SALE, result["problems"][0]["message"])
        self.assertEqual([row.offline_id for row in self.inbox.rows.values()], [LATE_SALE])

    def test_it_counts_once_retention_has_erased_the_edit(self):
        self.edit()
        self.stored(LATE_SALE).update(status="Synced", sales_invoice="SINV-EDIT", payload=None, original_payload=None)

        self.assertEqual(self.counts(self.import_rows(self.item())), (0, 0, 1, 0))

    def test_an_edit_that_lands_during_the_import_is_seen(self):
        real = sync_api.store_item
        rows = [self.item("pos_offline_first", seq=1), self.item(seq=2)]

        def store(item, *args):
            if item["offline_id"] == SALE:
                self.edit()
            return real(item, *args)

        with patch.object(sync_api, "store_item", side_effect=store):
            result = self.import_rows(*rows)

        self.assertEqual(self.counts(result), (1, 0, 1, 0))

    def test_an_edit_in_the_same_file_ahead_of_its_original_still_wins(self):
        edit = self.item(LATE_SALE, seq=1)
        edit["payload"]["edited_from"] = SALE

        result = self.import_rows(edit, self.item(seq=2))

        self.assertEqual(self.counts(result), (1, 0, 1, 0))

    def test_a_voided_edit_does_not_bring_the_original_back(self):
        self.edit(status="Voided")
        self.assertEqual(self.counts(self.import_rows(self.item())), (0, 0, 1, 0))

    def test_an_edit_of_something_else_changes_nothing(self):
        edit = self.item(LATE_SALE)
        edit["payload"]["edited_from"] = "pos_offline_other"
        self.push(edit)

        self.assertEqual(self.import_rows(self.item())["stored"], 1)

    def test_the_same_file_with_both_keeps_the_edit_back_for_a_manager(self):
        original = self.item(seq=1)
        edit = self.item(LATE_SALE, seq=2)
        edit["payload"]["edited_from"] = SALE

        self.import_rows(edit, original)

        self.assertEqual(self.stored().status, "Received")
        self.assertEqual(self.stored(LATE_SALE).status, sync_inbox.REVIEW)

    def test_a_held_original_stays_known(self):
        self.import_rows(self.item())
        self.edit()

        self.assertEqual(self.counts(self.import_rows(self.item())), (0, 1, 0, 0))


class TestRecordsFromBeforeTheColumn(ImportFlow):
    def run_patch(self, *rows):
        from pos_next.patches.v2_0_0 import fill_offline_sync_edited_from

        with patch.object(frappe, "get_all", return_value=[frappe._dict(row) for row in rows]):
            fill_offline_sync_edited_from.execute()

    def test_an_edit_gets_its_link_from_the_payload(self):
        self.import_rows(self.item(LATE_SALE))
        row = self.stored(LATE_SALE)

        self.run_patch({"name": row.name, "offline_id": LATE_SALE, "payload": frappe.as_json({"edited_from": SALE})})

        self.assertEqual(row.edited_from, SALE)

    def test_a_payload_a_manager_broke_stops_nothing(self):
        self.run_patch({"name": "row-1", "offline_id": LATE_SALE, "payload": '"edited_from": "not json'})

    def test_the_search_finds_the_form_a_payload_is_stored_in(self):
        from pos_next.patches.v2_0_0 import fill_offline_sync_edited_from

        needle = fill_offline_sync_edited_from.HOLDS_AN_EDIT.strip("%")
        self.assertIn(needle, frappe.as_json({"edited_from": SALE, "customer": "A"}))
        self.assertNotIn(needle, frappe.as_json({"edited_from": None}))


class TestTheDevicesClock(ImportFlow):
    def test_a_row_cannot_claim_how_far_off_it_was(self):
        self.import_rows(self.item(clock_skew_seconds=999999))
        self.assertEqual(self.stored().clock_skew_seconds, 0)

    def test_a_row_cannot_claim_it_was_measured(self):
        self.import_rows(self.item(clock_skew_seconds=0, clock_not_measured=0))
        self.assertEqual(self.stored().clock_not_measured, 1)

    def test_a_row_with_no_reading_is_told_apart_from_a_clock_that_agrees(self):
        self.import_rows(self.item())
        self.assertEqual((self.stored().clock_skew_seconds, self.stored().clock_not_measured), (0, 1))

    @staticmethod
    def _iso(seconds_from_now):
        moment = datetime.fromtimestamp(time.time() + seconds_from_now, UTC)
        return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def test_a_row_past_the_limit_ahead_of_the_server_is_held_as_a_wrong_clock(self):
        self.import_rows(self.item(created_at_device=self._iso(3 * 86400)))

        self.process_all(sync_inbox._create_invoice)

        row = self.stored()
        self.assertEqual(row.status, sync_inbox.REVIEW)
        self.assertEqual(row.error_code, "ClockSkewError")
        self.assertEqual(row.clock_not_measured, 1)
        self.assertGreater(row.clock_skew_seconds, 2 * 86400)
        self.assertIn("ahead of the server", row.error_message)

    def test_a_row_just_inside_the_limit_is_not_held(self):
        self.import_rows(self.item(created_at_device=self._iso(11 * 3600)))
        self.assertEqual(self.stored().clock_skew_seconds, 0)

    def test_a_row_from_the_past_is_flagged_and_not_held(self):
        self.import_rows(self.item(created_at_device=self._iso(-30 * 86400)))

        row = self.stored()
        self.assertEqual((row.status, row.clock_skew_seconds, row.clock_not_measured), ("Received", 0, 1))

    def test_a_time_zone_does_not_put_a_correct_clock_ahead(self):
        now = datetime.now(UTC).astimezone(timezone(timedelta(hours=14)))

        self.import_rows(self.item(created_at_device=now.isoformat()))

        self.assertEqual(self.stored().clock_skew_seconds, 0)

    def test_a_time_with_no_zone_is_read_in_the_servers(self):
        with patch("pos_next.services.sync_inbox.get_system_timezone", return_value="Pacific/Kiritimati"):
            now = datetime.now(ZoneInfo("Pacific/Kiritimati")).replace(tzinfo=None)
            self.import_rows(self.item(created_at_device=now.isoformat()))

        self.assertEqual(self.stored().clock_skew_seconds, 0)

    def test_a_time_that_cannot_be_read_stores_the_row_unjudged(self):
        self.import_rows(self.item(created_at_device="not a time"))
        self.assertEqual((self.stored().clock_skew_seconds, self.stored().clock_not_measured), (0, 1))

    def test_a_push_still_measures_it(self):
        frappe.local.session.user = CASHIER
        ahead = (time.time() + 86400) * 1000

        sync_api.push([self.item()], device_time=ahead)

        self.assertGreater(self.stored().clock_skew_seconds, 80000)


class TestARowACashierAskedToVoid(ImportFlow):
    """Exporting keeps a void request on its row, and a push settles it instead of posting."""

    def setUp(self):
        super().setUp()
        self.create = Mock(return_value=INVOICE)
        for target, replacement in (
            ("pos_next.services.sync_void._", lambda text: text),
            ("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=True)),
            ("pos_next.services.sync_void.now_datetime", Mock(return_value="2026-11-06 12:00:00")),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def void(self):
        return self.item(void_reason="Wrong sale")

    def test_it_never_posts(self):
        result = self.import_rows(self.void())
        self.process_all(self.create)

        self.create.assert_not_called()
        self.assertEqual(self.stored().status, "Voided")
        self.assertEqual(self.stored().resolution_note, "Wrong sale")
        self.assertEqual(self.counts(result), (1, 0, 0, 0))

    def test_no_job_is_started_for_it(self):
        self.import_rows(self.void())
        sync_inbox.enqueue_processing.assert_not_called()

    def test_it_stays_on_record_under_the_manager(self):
        self.import_rows(self.void())
        self.assertEqual(self.stored().uploaded_by, MANAGER)

    def test_a_record_still_waiting_is_voided_and_known(self):
        self.import_rows(self.item())

        result = self.import_rows(self.void())

        self.assertEqual(self.stored().status, "Voided")
        self.assertEqual(self.counts(result), (0, 1, 0, 0))

    def test_a_sale_already_posted_stands_for_a_person(self):
        self.import_rows(self.item())
        self.process_all(self.create)

        result = self.import_rows(self.void())

        self.assertEqual(self.stored().status, "Synced")
        self.assertEqual(self.stored().error_code, sync_void.VOID_AFTER_POSTED)
        self.assertEqual(self.counts(result), (0, 1, 0, 0))

    def test_where_voiding_is_off_it_is_stored_as_a_sale(self):
        with patch("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=False)):
            result = self.import_rows(self.void())
        self.process_all(self.create)

        self.create.assert_called_once()
        self.assertEqual(self.stored().status, "Synced")
        self.assertFalse(self.stored().resolution_note)
        self.assertEqual(self.counts(result), (1, 0, 0, 0))
        self.assertEqual(result["problems"], [])
        sync_inbox.enqueue_processing.assert_called_once_with("Main")

    def test_where_voiding_is_off_a_record_still_waiting_is_left_to_post(self):
        self.import_rows(self.item())

        with patch("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=False)):
            result = self.import_rows(self.void())
        self.process_all(self.create)

        self.create.assert_called_once()
        self.assertEqual(self.counts(result), (0, 1, 0, 0))

    def test_where_voiding_is_off_a_shift_record_stays_refused(self):
        with patch("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=False)):
            result = self.import_rows(self.item(entity="shift_close", void_reason="Wrong shift"))

        self.assertEqual(self.counts(result), (0, 0, 0, 1))
        self.assertFalse(self.inbox.rows)

    def test_the_device_asking_again_changes_nothing(self):
        self.import_rows(self.void())
        frappe.local.session.user = CASHIER

        answer = self.push(self.void())[SALE]

        self.assertEqual(answer["status"], "voided")
        self.assertEqual(len(self.inbox.rows), 1)

    def test_a_good_row_beside_it_still_lands(self):
        result = self.import_rows(self.void(), self.item(LATE_SALE))

        self.assertEqual(self.counts(result), (2, 0, 0, 0))
        sync_inbox.enqueue_processing.assert_called_once_with("Main")


class TestAFileTheAppWrote(ImportFlow):
    """The app writes the file, and this reads it. Each side holds the other to this one."""

    def content(self):
        return EXPORTED_FILE.read_bytes()

    def test_every_row_is_stored(self):
        self.assertEqual(self.counts(self.import_file(self.content())), (3, 0, 0, 0))

    def test_the_rows_are_what_a_push_would_store(self):
        self.import_file(self.content())

        exported = json.loads(self.content())
        for item in exported["rows"]:
            row = self.stored(item["offline_id"])
            self.assertEqual(row.payload_hash, sync_inbox.compute_payload_hash(item["payload"]))
            self.assertEqual(row.seq, item["seq"])
            self.assertEqual(row.entity, item["entity"])

    def test_the_device_id_and_version_reach_the_record(self):
        self.import_file(self.content())

        exported = json.loads(self.content())
        row = self.stored(exported["rows"][0]["offline_id"])
        self.assertEqual(row.device_id, exported["device_id"])
        self.assertEqual(row.client_version, exported["app_version"])

    def test_a_row_that_waits_for_another_keeps_waiting(self):
        self.import_file(self.content())

        exported = json.loads(self.content())
        sale = next(row for row in exported["rows"] if row["depends_on"])
        self.assertEqual(self.stored(sale["offline_id"]).depends_on, sale["depends_on"][0])

    def test_the_time_of_the_sale_survives(self):
        with patch("pos_next.services.sync_inbox.get_datetime", frappe.utils.get_datetime):
            self.import_file(self.content())

        row = self.stored(json.loads(self.content())["rows"][0]["offline_id"])
        self.assertEqual(row.client_created_at, datetime(2026, 11, 6, 9, 30))
