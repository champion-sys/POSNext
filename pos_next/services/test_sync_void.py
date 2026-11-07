# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""A device asking to void a queued record, through the real push."""

import json
from pathlib import Path
from unittest.mock import Mock, patch

import frappe

from pos_next.pos_next.doctype.offline_invoice_sync import offline_invoice_sync
from pos_next.services import sync_inbox, sync_void
from pos_next.services.test_sync_flow import SALE, Upload

REASON = "The customer changed their mind"
ORIGINAL = "pos_offline_original"
POSTED = {"name": "SINV-1", "doctype": "Sales Invoice", "grand_total": 25}


class Void(Upload):
    def setUp(self):
        super().setUp()
        for target, replacement in (
            ("pos_next.services.sync_void._", lambda text: text),
            ("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=True)),
            ("pos_next.services.sync_void.now_datetime", Mock(return_value="2026-11-06 12:00:00")),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, offline_id=SALE, **values):
        return self.item(offline_id, **{"cashier": "lina@example.com", "void_reason": REASON, **values})

    def ask(self, *items):
        return self.push(*(items or [self.request()]))

    def stored_with(self, status, offline_id=SALE, **values):
        name = self._send(offline_id, {"pos_profile": "Main", "grand_total": 25})
        self._row(name).update(status=status, **values)
        return self._row(name)

    def attempts(self, outcome):
        return [
            call
            for call in sync_inbox._log_attempt.call_args_list
            if call.args[1] == outcome
        ]


class TestNothingStored(Void):
    def test_a_device_cannot_void_where_the_profile_turned_it_off(self):
        with patch("pos_next.services.sync_void._is_voiding_allowed", Mock(return_value=False)):
            result = self.ask()

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertFalse(self.inbox.rows)

    def test_a_record_of_a_profile_that_turned_it_off_is_left_alone(self):
        row = self.stored_with("Needs Review")
        allowed = Mock(side_effect=lambda profile: profile == "Other")

        with patch("pos_next.services.sync_void._is_voiding_allowed", allowed):
            result = self.ask(self.request(pos_profile="Other"))

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(self._row(row.name).status, "Needs Review")

    def test_the_record_is_kept_voided_with_its_reason_and_payload(self):
        result = self.ask(self.request(payload={"pos_profile": "Main", "grand_total": 25}))

        self.assertEqual(result[SALE]["status"], "voided")
        row = self.stored()
        self.assertEqual(row.status, "Voided")
        self.assertEqual(row.resolution, "Voided")
        self.assertEqual(row.resolution_note, REASON)
        self.assertEqual(row.resolved_by, "lina@example.com")
        self.assertEqual(json.loads(row.original_payload)["grand_total"], 25)
        self.assertEqual(row.uploaded_by, "lina@example.com")

    def test_it_is_never_processed(self):
        self.ask()

        self.assertEqual(sync_inbox._due_rows(), [])
        sync_inbox.enqueue_processing.assert_not_called()

    def test_the_request_is_in_its_audit_trail(self):
        self.ask()
        self.assertEqual(self.attempts("voided by device")[0].kwargs["message"], REASON)

    def test_a_reason_keeps_no_surrounding_space(self):
        self.ask(self.request(void_reason=f"  {REASON}\n"))
        self.assertEqual(self.stored().resolution_note, REASON)

    def test_a_record_stored_by_another_request_at_the_same_moment_is_voided_once(self):
        real_new_document = self._new_document

        def lose_the_race(values):
            document = real_new_document(values)

            def insert():
                self.inbox.insert({"offline_id": SALE, "status": "Received", "pos_profile": "Main", "payload": "{}"})
                raise frappe.DuplicateEntryError(sync_inbox.DOCTYPE, SALE)

            document.insert.side_effect = insert
            return document

        with patch("pos_next.services.sync_inbox.frappe.get_doc", lose_the_race):
            result = self.ask()

        self.assertEqual(result[SALE]["status"], "voided")
        self.assertEqual(len(self.inbox.rows), 1)
        self.assertEqual(self.stored().status, "Voided")

    def test_a_document_with_no_record_stands(self):
        finder = patch.dict(
            sync_inbox._ENTITIES,
            {"invoice": sync_inbox._Entity(None, Mock(return_value=POSTED), ())},
        )
        with finder:
            result = self.ask()

        self.assertEqual(result[SALE]["status"], "sale_stands")
        self.assertEqual(result[SALE]["invoice"], "SINV-1")
        self.assertEqual(self.stored().status, "Synced")
        self.assertEqual(self.stored().error_code, sync_void.VOID_AFTER_POSTED)


class TestStoredNotFinished(Void):
    def test_each_unfinished_status_is_voided_with_the_reason(self):
        for number, status in enumerate(("Received", "Blocked", "Needs Review", "Retry Scheduled")):
            offline_id = f"pos_offline_{number}"
            row = self.stored_with(status, offline_id)

            result = self.ask(self.request(offline_id))

            self.assertEqual(result[offline_id]["status"], "voided", status)
            self.assertEqual(row.status, "Voided", status)
            self.assertEqual(row.resolution_note, REASON, status)

    def test_a_job_that_comes_after_it_does_nothing(self):
        row = self.stored_with("Received")
        self.ask()

        create = Mock()
        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(create, Mock(return_value=None), ())}):
            sync_inbox.process(row.name)

        create.assert_not_called()
        self.assertEqual(row.status, "Voided")

    def test_a_retry_due_later_does_not_bring_it_back(self):
        row = self.stored_with("Retry Scheduled", next_retry_at="2026-11-06 11:00:00")
        self.ask()

        self.assertIsNone(row.next_retry_at)
        self.assertEqual(sync_inbox._due_rows(), [])

    def test_a_job_that_moved_the_row_after_the_read_is_not_overwritten(self):
        row = self.stored_with("Received")
        stale = frappe._dict(row)
        row["status"] = "Processing"

        with patch.object(sync_inbox, "_lock", return_value=stale):
            result = self.ask()

        self.assertEqual(row.status, "Processing")
        self.assertEqual(result[SALE]["status"], "void_pending")
        self.assertEqual(self.attempts("voided by device"), [])

    def test_a_document_whose_status_update_was_lost_stands(self):
        row = self.stored_with("Received")

        with patch.dict(sync_inbox._ENTITIES, {"invoice": sync_inbox._Entity(None, Mock(return_value=POSTED), ())}):
            result = self.ask()

        self.assertEqual(result[SALE]["status"], "sale_stands")
        self.assertEqual(row.status, "Synced")
        self.assertEqual(row.sales_invoice, "SINV-1")

    def test_a_record_without_a_payload_keeps_the_only_copy_of_it(self):
        row = self.stored_with("Needs Review", payload=None, payload_hash=None, original_payload=None)

        self.ask(self.request(payload={"pos_profile": "Main", "grand_total": 25}))

        self.assertEqual(row.status, "Voided")
        self.assertEqual(json.loads(row.payload)["grand_total"], 25)
        self.assertEqual(row.original_payload, row.payload)

    def test_a_sweep_that_read_it_as_blocked_does_not_undo_the_void(self):
        row = self.stored_with("Blocked", depends_on="pos_offline_never", received_at=sync_inbox.now_datetime())
        row["received_at"] = sync_inbox.add_to_date(row.received_at, hours=-2)
        read_by_the_sweep = frappe._dict(row)
        self.ask()

        sync_inbox._flag_if_stuck(read_by_the_sweep)

        self.assertEqual(row.status, "Voided")


class TestProcessing(Void):
    def test_the_void_stays_pending(self):
        row = self.stored_with("Processing")

        result = self.ask()

        self.assertEqual(result[SALE]["status"], "void_pending")
        self.assertEqual(row.status, "Processing")
        self.assertFalse(row.resolution_note)

    def test_it_is_voided_once_the_job_gives_up(self):
        row = self.stored_with("Processing")
        self.ask()

        row["status"] = sync_inbox.REVIEW

        self.assertEqual(self.ask()[SALE]["status"], "voided")

    def test_the_sale_stands_once_the_job_posts_it(self):
        row = self.stored_with("Processing")
        self.ask()

        row.update(status="Synced", sales_invoice="SINV-1")

        self.assertEqual(self.ask()[SALE]["status"], "sale_stands")


class TestAlreadyPosted(Void):
    def test_each_posted_status_stands_and_names_its_document(self):
        for number, status in enumerate(("Synced", "Resolved")):
            offline_id = f"pos_offline_{number}"
            row = self.stored_with(status, offline_id, sales_invoice="SINV-1")

            result = self.ask(self.request(offline_id))

            self.assertEqual(result[offline_id]["status"], "sale_stands", status)
            self.assertEqual(result[offline_id]["invoice"], "SINV-1", status)
            self.assertEqual(row.status, status)
            self.assertEqual(row.sales_invoice, "SINV-1", status)

    def test_nothing_here_touches_the_invoice(self):
        self.stored_with("Synced", sales_invoice="SINV-1")

        with patch("pos_next.services.sync_inbox.frappe.get_doc") as get_doc:
            self.ask()

        get_doc.assert_not_called()

    def test_the_row_is_marked_for_a_manager_with_a_stable_code(self):
        row = self.stored_with("Synced", sales_invoice="SINV-1")

        self.ask()

        self.assertEqual(row.error_code, "VoidAfterPosted")
        self.assertIn(REASON, row.error_message)
        self.assertIn("SINV-1", row.error_message)
        sync_inbox._notify_managers.assert_called_once_with(row.name, row.error_message)

    def test_a_manager_is_told_what_to_do_about_that_code(self):
        form = Path(offline_invoice_sync.__file__).with_suffix(".js").read_text()

        self.assertIn(f'const VOID_AFTER_POSTED = "{sync_void.VOID_AFTER_POSTED}"', form)
        self.assertIn("error_code === VOID_AFTER_POSTED) return VOID_AFTER_POSTED_GUIDE", form)

    def test_an_edit_voided_while_the_sale_it_replaced_is_on_the_server_does_not_hide_that_sale(self):
        self.stored_with("Received", ORIGINAL)

        result = self.ask(self.request(payload={"pos_profile": "Main", "edited_from": ORIGINAL}))

        self.assertEqual(result[SALE]["status"], "sale_stands")
        row = self.stored(SALE)
        self.assertEqual(row.status, "Voided")
        self.assertEqual(row.error_code, "VoidAfterPosted")
        self.assertIn(ORIGINAL, row.error_message)
        self.assertEqual(self.stored(ORIGINAL).status, "Received")

    def test_an_edit_voided_when_the_sale_it_replaced_never_arrived_is_simply_voided(self):
        result = self.ask(self.request(payload={"pos_profile": "Main", "edited_from": ORIGINAL}))
        self.assertEqual(result[SALE]["status"], "voided")


class TestRepeatedRequests(Void):
    def test_a_voided_record_gives_the_same_answer_and_one_trail(self):
        first = self.ask()
        second = self.ask()

        self.assertEqual(first, second)
        self.assertEqual(len(self.inbox.rows), 1)
        self.assertEqual(len(self.attempts("voided by device")), 1)

    def test_a_record_a_manager_voided_gives_the_same_answer(self):
        row = self.stored_with("Voided", resolution_note="Entered twice")

        self.assertEqual(self.ask()[SALE]["status"], "voided")
        self.assertEqual(row.resolution_note, "Entered twice")

    def test_a_record_that_stands_gives_the_same_answer_and_one_notification(self):
        row = self.stored_with("Synced", sales_invoice="SINV-1")

        first = self.ask()
        message = row.error_message
        second = self.ask(self.request(void_reason="Another reason"))

        self.assertEqual(first, second)
        self.assertEqual(row.error_message, message)
        sync_inbox._notify_managers.assert_called_once()
        self.assertEqual(len(self.attempts("void refused")), 1)

    def test_a_voided_edit_of_a_held_sale_keeps_answering_that_the_sale_stands(self):
        self.stored_with("Received", ORIGINAL)
        item = self.request(payload={"pos_profile": "Main", "edited_from": ORIGINAL})

        self.assertEqual(self.ask(item), self.ask(item))

    def test_a_record_being_processed_keeps_answering_ask_again(self):
        self.stored_with("Processing")
        self.assertEqual(self.ask(), self.ask())


class TestAccess(Void):
    def test_the_stored_profile_counts_not_the_one_in_the_envelope(self):
        row = self.stored_with("Received", pos_profile="Other")

        result = self.ask()

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertIn("Other", result[SALE]["message"])
        self.assertEqual(row.status, "Received")

    def test_someone_with_the_stored_profile_may_void(self):
        self.inbox.assigned["Other"].add("lina@example.com")
        self.stored_with("Received", pos_profile="Other")

        self.assertEqual(self.ask()[SALE]["status"], "voided")

    def test_a_device_is_held_to_the_stored_profile(self):
        frappe.local.pos_device = "device-1"
        self.inbox.assigned["Other"].add("lina@example.com")
        row = self.stored_with("Received", pos_profile="Other")

        result = self.ask()

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(row.status, "Received")

    def test_the_envelope_is_checked_as_for_any_upload(self):
        result = self.ask(self.request(pos_profile="Other", payload={"pos_profile": "Other"}))

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})

    def test_a_refused_void_does_not_cost_the_rest_of_the_batch(self):
        self.stored_with("Received", pos_profile="Other")

        result = self.ask(self.request(), self.item("pos_offline_next"))

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(result["pos_offline_next"]["status"], "received")

    def test_a_blank_reason_is_refused_and_posts_nothing(self):
        for reason in ("", "   ", 5):
            result = self.ask(self.request(void_reason=reason))

            self.assertEqual(result[SALE]["status"], "rejected", repr(reason))
            self.assertEqual(self.inbox.rows, {}, repr(reason))


class TestEntities(Void):
    def test_a_customer_and_a_payment_void_like_a_sale(self):
        for entity in ("customer", "payment"):
            offline_id = f"pos_offline_{entity}"

            result = self.ask(self.request(offline_id, entity=entity))

            self.assertEqual(result[offline_id]["status"], "voided", entity)
            self.assertEqual(self.stored(offline_id).entity, entity)

    def test_each_entity_looks_for_its_own_document(self):
        find = Mock(return_value={"name": "CUST-1", "doctype": "Customer", "customer": "CUST-1"})
        row = self.stored_with("Received", entity="customer")

        with patch.dict(sync_inbox._ENTITIES, {"customer": sync_inbox._Entity(None, find, ())}):
            result = self.ask(self.request(entity="customer"))

        self.assertEqual(result[SALE]["status"], "sale_stands")
        self.assertEqual(result[SALE]["invoice"], "CUST-1")
        self.assertEqual(row.status, "Synced")

    def test_a_shift_close_is_refused_whatever_the_envelope_calls_it(self):
        row = self.stored_with("Blocked", entity="shift_close")

        result = self.ask(self.request(entity="invoice"))

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(row.status, "Blocked")

    def test_a_shift_opening_is_refused_since_its_sales_wait_on_it(self):
        row = self.stored_with("Blocked", entity="shift_open")

        result = self.ask()

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(self._row(row.name).status, "Blocked")

    def test_a_shift_close_the_server_never_saw_leaves_nothing_behind(self):
        result = self.ask(self.request(entity="shift_close"))

        self.assertEqual(result[SALE]["status"], "rejected")
        self.assertEqual(self.inbox.rows, {})
