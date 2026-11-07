# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import inspect
import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, Mock, patch

import frappe

from pos_next.api import partial_payments, shifts
from pos_next.api import invoices
from pos_next.api.invoices import save_invoice_draft
from pos_next.pos_next.doctype.pos_closing_shift import pos_closing_shift
from pos_next.services import sync_entities, sync_inbox
from pos_next.services.invoice_processor import process_invoice
from pos_next.services.sync_classifier import ClockSkewError, DependencyError, SyncContractError, classify

LOCAL_CUSTOMER = "pos_offline_customer-1"
LOCAL_INVOICE = "pos_offline_invoice-1"


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


def _row(**values):
    row = {
        "name": "row-1",
        "offline_id": "pos_offline_row-1",
        "entity": "invoice",
        "status": "Received",
        "cashier": "cashier@example.com",
        "pos_profile": "Main",
        "attempts": 0,
        "depends_on": "",
        "payload": "{}",
        "client_grand_total": 0,
        "accept_total_difference": 0,
        "accept_unfinished": 0,
    }
    return frappe._dict({**row, **values})


class NoSiteTestCase(unittest.TestCase):
    """Replace the helpers that need a site, so these run without a database."""

    def setUp(self):
        for target, replacement in (
            ("frappe.throw", _raise),
            ("frappe._", lambda text, *_args, **_kwargs: text),
            ("pos_next.services.sync_entities._", lambda text: text),
            ("pos_next.services.sync_inbox._", lambda text: text),
            ("pos_next.services.sync_inbox.now_datetime", datetime.now),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        frappe.local.session = Mock(user="uploader@example.com")
        frappe.local.db = Mock()
        frappe.local.form_dict = frappe._dict()
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)


class TestLocalNames(NoSiteTestCase):
    def test_recognises_a_name_from_the_device(self):
        self.assertTrue(sync_entities.is_local_name(LOCAL_CUSTOMER))
        self.assertFalse(sync_entities.is_local_name("CUST-0001"))
        self.assertFalse(sync_entities.is_local_name(None))

    def test_a_local_customer_is_a_dependency_even_when_the_device_left_it_out(self):
        self.assertEqual(sync_entities.get_dependencies({"customer": LOCAL_CUSTOMER}), [LOCAL_CUSTOMER])

    def test_dependencies_keep_their_order_without_repeats(self):
        dependencies = sync_entities.get_dependencies(
            {"customer": LOCAL_CUSTOMER, "return_against": LOCAL_INVOICE}, [LOCAL_INVOICE, "other"]
        )
        self.assertEqual(dependencies, [LOCAL_INVOICE, "other", LOCAL_CUSTOMER])

    def test_a_real_customer_is_not_a_dependency(self):
        self.assertEqual(sync_entities.get_dependencies({"customer": "CUST-0001"}), [])

    def test_the_payload_gets_the_real_customer(self):
        frappe.local.db.get_value.return_value = frappe._dict(status="Synced", sales_invoice="CUST-0001")
        payload = {"customer": LOCAL_CUSTOMER, "customer_name": "Sara"}

        sync_entities.resolve_local_names(payload)

        self.assertEqual(payload, {"customer": "CUST-0001"})

    def test_a_customer_linked_by_a_manager_counts(self):
        frappe.local.db.get_value.return_value = frappe._dict(status="Resolved", sales_invoice="CUST-0002")
        payload = {"customer": LOCAL_CUSTOMER}

        sync_entities.resolve_local_names(payload)

        self.assertEqual(payload["customer"], "CUST-0002")

    def test_a_voided_customer_needs_a_person(self):
        frappe.local.db.get_value.return_value = frappe._dict(status="Voided", sales_invoice=None)

        with self.assertRaises(DependencyError) as caught:
            sync_entities.resolve_local_names({"customer": LOCAL_CUSTOMER})

        self.assertEqual(classify(caught.exception).error_class, "dependency")

    def test_a_customer_fixed_by_a_manager_needs_nothing(self):
        payload = {"customer": "CUST-0003"}
        sync_entities.resolve_local_names(payload)
        frappe.local.db.get_value.assert_not_called()


class TestEnvelope(NoSiteTestCase):
    def test_accepts_each_entity(self):
        for entity in sync_entities.ENTITIES:
            item = {"offline_id": "x", "pos_profile": "Main", "payload": {}, "entity": entity}
            self.assertIsNone(sync_inbox.validate_envelope(item))

    def test_rejects_an_unknown_entity(self):
        item = {"offline_id": "x", "pos_profile": "Main", "payload": {}, "entity": "stock_entry"}
        self.assertEqual(sync_inbox.validate_envelope(item), "Unknown entity")

    def test_an_envelope_without_an_entity_is_a_sale(self):
        self.assertIsNone(sync_inbox.validate_envelope({"offline_id": "x", "pos_profile": "Main", "payload": {}}))


class TestBlocking(NoSiteTestCase):
    def _is_blocked(self, row, statuses):
        with patch("pos_next.services.sync_inbox.frappe.get_all", return_value=statuses):
            return sync_inbox._is_blocked(row)

    def test_an_invoice_waits_for_its_customer(self):
        row = _row(depends_on=LOCAL_CUSTOMER)
        self.assertTrue(self._is_blocked(row, [(LOCAL_CUSTOMER, "Received")]))

    def test_an_invoice_waits_for_a_customer_not_received_yet(self):
        self.assertTrue(self._is_blocked(_row(depends_on=LOCAL_CUSTOMER), []))

    def test_an_invoice_continues_once_the_customer_is_done(self):
        row = _row(depends_on=LOCAL_CUSTOMER)
        self.assertFalse(self._is_blocked(row, [(LOCAL_CUSTOMER, "Synced")]))

    def test_nothing_to_wait_for(self):
        self.assertFalse(sync_inbox._is_blocked(_row()))


class TestStuckRows(NoSiteTestCase):
    def _flag(self, received_at, statuses):
        row = _row(status="Blocked", depends_on=LOCAL_CUSTOMER, received_at=received_at)
        frappe.local.db.get_value.return_value = "Blocked"
        with (
            patch("pos_next.services.sync_inbox.frappe.get_all", return_value=statuses),
            patch.object(sync_inbox, "_handle_failure") as handle_failure,
        ):
            sync_inbox._flag_if_stuck(row)
        return handle_failure

    def test_a_dependency_that_never_arrives_goes_to_review(self):
        handle_failure = self._flag(datetime.now() - timedelta(hours=2), [])
        self.assertIn(LOCAL_CUSTOMER, str(handle_failure.call_args.args[2]))

    def test_it_is_given_time_to_arrive(self):
        self._flag(datetime.now() - timedelta(minutes=1), []).assert_not_called()

    def test_a_dependency_that_arrived_is_left_to_finish(self):
        self._flag(datetime.now() - timedelta(hours=2), [(LOCAL_CUSTOMER, "Retry Scheduled")]).assert_not_called()

    def test_review_is_released_once_it_arrives(self):
        row = _row(status="Needs Review", depends_on=LOCAL_CUSTOMER)
        with patch(
            "pos_next.services.sync_inbox.frappe.get_all",
            side_effect=[[row], [(LOCAL_CUSTOMER, "Synced")]],
        ):
            sync_inbox._release_arrived_rows()

        frappe.local.db.set_value.assert_called_once_with(
            sync_inbox.DOCTYPE,
            {"name": "row-1", "status": sync_inbox.REVIEW, "error_code": "WaitingForDependencyError"},
            "status",
            "Received",
        )


class TestCreateCustomer(NoSiteTestCase):
    payload = json.dumps({"customer_name": "Sara", "mobile_no": "+966-5", "pos_profile": "Main"})

    @patch("pos_next.services.sync_entities.frappe.has_permission", return_value=False)
    def test_uses_the_cashiers_permission(self, has_permission):
        with self.assertRaises(frappe.PermissionError):
            sync_entities.create_customer(_row(entity="customer", payload=self.payload))

        has_permission.assert_called_once_with("Customer", "create", user="cashier@example.com")

    @patch("pos_next.services.sync_entities.frappe.has_permission", return_value=True)
    @patch("pos_next.api.customers.insert_customer")
    def test_creates_the_customer(self, insert_customer, _has_permission):
        insert_customer.return_value = Mock()
        insert_customer.return_value.name = "CUST-0001"

        result = sync_entities.create_customer(_row(entity="customer", payload=self.payload))

        self.assertEqual(result, {"name": "CUST-0001", "doctype": "Customer", "customer": "CUST-0001"})
        kwargs = insert_customer.call_args.kwargs
        self.assertEqual(kwargs["offline_id"], "pos_offline_row-1")
        self.assertTrue(kwargs["ignore_permissions"])

    def test_refuses_a_customer_without_a_name(self):
        with self.assertRaises(SyncContractError):
            sync_entities.create_customer(_row(entity="customer", payload="{}"))

    def test_a_copy_already_created_is_found(self):
        frappe.local.db.get_value.return_value = "CUST-0001"
        self.assertEqual(sync_entities.find_customer("id")["name"], "CUST-0001")


class TestProcess(NoSiteTestCase):
    def _process(self, row, create):
        handler = sync_inbox._Entity(create, Mock(return_value=None), ())
        frappe.local.db.get_value.return_value = row
        with (
            patch.dict(sync_inbox._ENTITIES, {row.entity: handler}),
            patch.object(sync_inbox, "_log_attempt"),
            patch.object(sync_inbox, "_notify_uploader"),
            patch.object(sync_inbox, "_notify_managers"),
        ):
            sync_inbox.process("row-1")

    def test_dispatches_by_entity(self):
        create = Mock(return_value={"name": "CUST-0001", "doctype": "Customer"})
        row = _row(entity="customer")

        self._process(row, create)

        create.assert_called_once_with(row)

    def test_a_row_from_before_entities_is_a_sale(self):
        self.assertIs(sync_inbox._get_handler(_row(entity=None)), sync_inbox._ENTITIES["invoice"])

    def test_records_the_real_customer_on_the_row(self):
        with patch.object(sync_inbox, "_log_attempt"), patch.object(sync_inbox, "_notify_uploader"):
            sync_inbox._mark_synced("row-1", {"name": "CUST-0001", "doctype": "Customer", "customer": "CUST-0001"}, "synced")

        values = frappe.local.db.set_value.call_args.args[2]
        self.assertEqual(values["sales_invoice"], "CUST-0001")
        self.assertEqual(values["invoice_doctype"], "Customer")
        self.assertEqual(values["customer"], "CUST-0001")

    def test_a_failure_keeps_the_reason(self):
        self._process(_row(entity="customer"), Mock(side_effect=frappe.ValidationError("Bad territory")))

        values = frappe.local.db.set_value.call_args_list[-1].args[2]
        self.assertEqual(values["status"], sync_inbox.REVIEW)
        self.assertEqual(values["error_class"], "business")
        self.assertIn("Bad territory", values["error_message"])
        frappe.local.db.rollback.assert_called()


class TestCreateInvoice(NoSiteTestCase):
    @patch("pos_next.api.invoices._assert_invoice_write_access")
    @patch("pos_next.services.invoice_processor.process_invoice")
    def test_posts_against_the_real_customer_and_keeps_the_stored_payload(self, process_invoice, _access):
        frappe.local.db.get_value.return_value = frappe._dict(status="Synced", sales_invoice="CUST-0001")
        process_invoice.return_value = {"name": "SINV-1", "grand_total": 10}
        stored = json.dumps({"customer": LOCAL_CUSTOMER, "customer_name": "Sara", "pos_profile": "Main"})
        row = _row(payload=stored, depends_on=LOCAL_CUSTOMER)

        result = sync_inbox._create_invoice(row)

        self.assertEqual(process_invoice.call_args.args[0]["customer"], "CUST-0001")
        self.assertEqual(result["customer"], "CUST-0001")
        self.assertEqual(row.payload, stored)


class TestCreatePayment(NoSiteTestCase):
    payload = json.dumps(
        {
            "invoice_name": "SINV-1",
            "posting_date": "2026-11-05",
            "posa_pos_opening_shift": "POSA-OS-1",
            "payments": [{"mode_of_payment": "Cash", "amount": 40}, {"mode_of_payment": "Card", "amount": 10}],
        }
    )

    def _create(self, payload=None, wallet_modes=(), **row):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access") as self.access,
            patch("pos_next.api.partial_payments.post_queued_payments") as self.post,
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=list(wallet_modes)),
        ):
            self.post.return_value = ["PE-1", "PE-2"]
            frappe.local.db.get_value.return_value = "Main"
            return sync_entities.create_payment(_row(entity="payment", payload=payload or self.payload, **row))

    def test_posts_on_the_day_and_in_the_shift_the_money_was_taken(self):
        result = self._create()

        self.post.assert_called_once()
        invoice, payments, posting_date, reference_no, offline_id = self.post.call_args.args
        self.assertEqual(invoice, "SINV-1")
        self.assertEqual(len(payments), 2)
        self.assertEqual(posting_date, "2026-11-05")
        self.assertEqual(reference_no, "POSA-OS-1")
        self.assertEqual(offline_id, "pos_offline_row-1")
        self.assertEqual(result["name"], "PE-1")
        self.assertEqual(result["doctype"], "Payment Entry")
        self.assertEqual(result["grand_total"], 50)
        self.assertEqual(result["note"], "PE-1, PE-2")

    def test_checks_the_cashier_not_the_uploader(self):
        self._create()
        self.access.assert_called_once_with("Sales Invoice", "Main", "cashier@example.com")

    def test_a_cashiers_high_role_does_not_carry_the_uploader_to_another_profile(self):
        with self.assertRaises(frappe.PermissionError):
            with (
                patch("pos_next.api.invoices._assert_invoice_write_access", self._refuse_uploader),
                patch("pos_next.api.partial_payments.post_queued_payments") as post,
                patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=[]),
            ):
                frappe.local.db.get_value.return_value = "Other"
                sync_entities.create_payment(
                    _row(entity="payment", payload=self.payload, uploaded_by="uploader@example.com")
                )
        post.assert_not_called()

    @staticmethod
    def _refuse_uploader(_doctype, pos_profile, user):
        if user == "uploader@example.com":
            raise frappe.PermissionError(pos_profile)

    def test_a_clock_too_far_off_stops_the_payment_before_it_posts(self):
        row = _row(entity="payment", payload='{"invoice_name": "SINV-1"}', clock_skew_seconds=31536000)

        with (
            patch("pos_next.api.partial_payments.post_queued_payments") as post,
            self.assertRaises(ClockSkewError),
        ):
            sync_entities.create_payment(row)
        post.assert_not_called()

    def test_a_managers_acceptance_lets_the_payment_through(self):
        self._create(clock_skew_seconds=31536000, accept_device_date=1)
        self.post.assert_called_once()

    def test_a_wallet_cannot_be_spent_offline(self):
        with self.assertRaises(frappe.ValidationError):
            self._create(wallet_modes=["Card"])
        self.post.assert_not_called()

    def test_refuses_a_payment_without_an_invoice(self):
        with self.assertRaises(SyncContractError):
            sync_entities.create_payment(_row(entity="payment", payload="{}"))

    def test_a_copy_already_posted_is_found(self):
        frappe.local.db.get_value.return_value = frappe._dict(name="PE-1", paid_amount=50)

        result = sync_entities.find_payment("pos_offline_row-1")

        self.assertEqual(result, {"name": "PE-1", "doctype": "Payment Entry", "grand_total": 50})
        self.assertEqual(
            frappe.local.db.get_value.call_args.args[1],
            {"offline_id": "pos_offline_row-1:1", "docstatus": 1},
        )


class TestPaymentResend(NoSiteTestCase):
    def test_a_resend_is_not_stored_again(self):
        payload = {"invoice_name": "SINV-1"}
        frappe.local.db.get_value.return_value = frappe._dict(
            name="row-1", payload_hash=sync_inbox.compute_payload_hash(payload)
        )

        with patch("pos_next.services.sync_inbox.frappe.get_doc") as get_doc:
            name, conflict = sync_inbox.ingest({"offline_id": "x", "payload": payload}, "cashier@example.com")

        self.assertEqual((name, conflict), ("row-1", False))
        get_doc.assert_not_called()

    def test_a_finished_payment_does_not_run_again(self):
        create = Mock()
        row = _row(entity="payment", status="Synced")
        frappe.local.db.get_value.return_value = row

        with patch.dict(sync_inbox._ENTITIES, {"payment": sync_inbox._Entity(create, Mock(), ())}):
            sync_inbox.process("row-1")

        create.assert_not_called()

    def test_a_payment_that_already_posted_is_only_marked(self):
        create = Mock()
        find = Mock(return_value={"name": "PE-1", "doctype": "Payment Entry", "grand_total": 50})
        frappe.local.db.get_value.return_value = _row(entity="payment")

        with (
            patch.dict(sync_inbox._ENTITIES, {"payment": sync_inbox._Entity(create, find, ())}),
            patch.object(sync_inbox, "_log_attempt"),
            patch.object(sync_inbox, "_notify_uploader"),
        ):
            sync_inbox.process("row-1")

        create.assert_not_called()

    def test_the_unique_index_catching_a_second_worker_counts_as_done(self):
        find = Mock(return_value={"name": "PE-1", "doctype": "Payment Entry", "grand_total": 50})
        frappe.local.db.get_value.return_value = _row(entity="payment")

        with (
            patch.dict(sync_inbox._ENTITIES, {"payment": sync_inbox._Entity(Mock(), find, ())}),
            patch.object(sync_inbox, "_mark_synced") as mark_synced,
        ):
            sync_inbox._handle_failure("row-1", 1, frappe.UniqueValidationError("Duplicate"), "", None)

        mark_synced.assert_called_once_with("row-1", find.return_value, "recovered")


class TestPaymentEntries(NoSiteTestCase):
    @patch("pos_next.api.partial_payments.create_payment_entry", side_effect=["PE-1", "PE-2"])
    @patch("pos_next.api.partial_payments.frappe.log_error")
    def test_each_entry_gets_its_own_key(self, _log_error, create_payment_entry):
        payments = [
            {"mode_of_payment": "Cash", "amount": 40},
            {"mode_of_payment": "Bank", "amount": 0},
            {"mode_of_payment": "Card", "amount": 10},
        ]

        entries = partial_payments._create_payment_entries("SINV-1", payments, "2026-11-05", "SHIFT", "id")

        self.assertEqual(entries, ["PE-1", "PE-2"])
        keys = [call.kwargs["offline_id"] for call in create_payment_entry.call_args_list]
        self.assertEqual(keys, ["id:1", "id:2"])
        self.assertEqual(create_payment_entry.call_args.kwargs["reference_no"], "SHIFT")
        self.assertEqual(create_payment_entry.call_args.kwargs["posting_date"], "2026-11-05")

    @patch("pos_next.api.partial_payments.create_payment_entry", return_value="PE-1")
    def test_the_online_path_stays_as_it_was(self, create_payment_entry):
        partial_payments._create_payment_entries("SINV-1", [{"mode_of_payment": "Cash", "amount": 40}])

        kwargs = create_payment_entry.call_args.kwargs
        self.assertIsNone(kwargs["offline_id"])
        self.assertIsNone(kwargs["reference_no"])
        self.assertIsNone(kwargs["posting_date"])

    @patch("pos_next.api.partial_payments.frappe.format_value", side_effect=lambda value, _df: value)
    @patch("pos_next.api.partial_payments.frappe.get_doc")
    def test_more_than_is_owed_fails_with_the_reason(self, get_doc, _format_value):
        get_doc.return_value = Mock(outstanding_amount=30)

        with self.assertRaises(frappe.ValidationError):
            partial_payments.post_queued_payments(
                "SINV-1", [{"mode_of_payment": "Cash", "amount": 40}], None, None, "id"
            )

    @patch("pos_next.api.partial_payments.frappe.get_doc")
    @patch("erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry")
    @patch(
        "erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account",
        return_value={"account": "Cash - T"},
    )
    def test_a_deadlock_stays_a_deadlock_so_the_queue_retries(self, _account, get_payment_entry, get_doc):
        get_doc.return_value = Mock(docstatus=1, outstanding_amount=100, posting_date="2026-11-01")
        get_payment_entry.side_effect = frappe.QueryDeadlockError("Deadlock")
        frappe.local.db.exists.return_value = True

        with self.assertRaises(frappe.QueryDeadlockError):
            partial_payments.create_payment_entry("SINV-1", 40, "Cash", posting_date="2026-11-05")


class TestFixes(NoSiteTestCase):
    def _apply(self, entity, fix, values, payload="{}", **fields):
        row = Mock(status=sync_inbox.REVIEW, entity=entity, payload=payload, **fields)
        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row),
            patch.object(sync_inbox, "_log_attempt"),
        ):
            sync_inbox.apply_fix("row-1", fix, values)
        return row

    def test_a_corrected_date_no_longer_depends_on_the_device_clock(self):
        row = self._apply("invoice", "posting_date", {"posting_date": "2026-11-01"})

        self.assertEqual(row.accept_device_date, 1)

    def test_a_customer_gets_a_valid_group(self):
        row = self._apply("customer", "customer_group", {"customer_group": "Retail"})
        self.assertEqual(json.loads(row.payload)["customer_group"], "Retail")

    def test_a_payment_can_be_reduced_to_what_is_owed(self):
        payload = json.dumps({"payments": [{"mode_of_payment": "Cash", "amount": 40}]})
        row = self._apply("payment", "payment_amount", {"mode_of_payment": "Cash", "amount": 25}, payload)
        self.assertEqual(json.loads(row.payload)["payments"][0]["amount"], 25)

    def test_the_shift_fix_moves_the_row_with_its_payload(self):
        row = self._apply("invoice", "shift", {"shift": "SHIFT-2"}, '{"posa_pos_opening_shift": "SHIFT-1"}')

        self.assertEqual(row.shift, "SHIFT-2")
        self.assertEqual(json.loads(row.payload)["posa_pos_opening_shift"], "SHIFT-2")

    def test_a_pos_invoice_goes_to_whoever_holds_the_new_shift(self):
        frappe.local.db.get_value.return_value = "lina@example.com"

        row = self._apply(
            "invoice", "shift", {"shift": "SHIFT-2"}, invoice_doctype="POS Invoice", cashier="sara@example.com"
        )

        self.assertEqual(row.cashier, "lina@example.com")

    def test_a_sales_invoice_keeps_its_cashier_when_it_moves(self):
        row = self._apply(
            "invoice", "shift", {"shift": "SHIFT-2"}, invoice_doctype="Sales Invoice", cashier="sara@example.com"
        )

        self.assertEqual(row.cashier, "sara@example.com")

    def test_a_fix_on_a_record_without_a_payload_says_so(self):
        for payload in (None, ""):
            with self.assertRaises(SyncContractError) as caught:
                self._apply("invoice", "customer", {"customer": "CUST-0001"}, payload)
            self.assertIn("no payload", str(caught.exception))

    def test_a_fix_on_a_payload_a_person_broke_says_so(self):
        for payload in ("not json", "[]", "1"):
            with self.assertRaises(SyncContractError):
                self._apply("invoice", "customer", {"customer": "CUST-0001"}, payload)

    def test_an_approval_needs_no_payload(self):
        row = self._apply("invoice", "accept_total_difference", {}, None)
        row.set.assert_called_once_with("accept_total_difference", 1)

    def test_a_fix_for_another_entity_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            self._apply("customer", "warehouse", {"warehouse": "Stores"})

    def test_a_row_from_before_entities_uses_the_sale_fixes(self):
        row = self._apply(None, "customer", {"customer": "CUST-0001"}, '{"customer": "pos_offline_x"}')
        self.assertEqual(json.loads(row.payload)["customer"], "CUST-0001")

    def test_a_changed_customer_does_not_keep_the_old_name(self):
        payload = '{"customer": "pos_offline_x", "customer_name": "Sara"}'
        row = self._apply("invoice", "customer", {"customer": "CUST-0001"}, payload)
        self.assertEqual(json.loads(row.payload), {"customer": "CUST-0001"})

    def test_a_record_links_only_to_its_own_kind(self):
        row = Mock(status=sync_inbox.REVIEW, entity="customer")
        with patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row):
            with self.assertRaises(frappe.ValidationError):
                sync_inbox.link_existing_invoice("row-1", "SINV-1", "Sales Invoice", "Entered by hand")

    @patch("pos_next.services.sync_inbox.frappe.get_meta", return_value=Mock(is_submittable=0))
    @patch.object(sync_inbox, "_notify_uploader")
    def test_a_customer_entered_by_hand_closes_the_review(self, _notify, _meta):
        row = Mock(status=sync_inbox.REVIEW, entity="customer")
        frappe.local.db.exists.return_value = "CUST-0001"
        with patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row):
            sync_inbox.link_existing_invoice("row-1", "CUST-0001", "Customer", "Entered by hand")

        self.assertEqual(row.status, "Resolved")
        self.assertEqual(row.sales_invoice, "CUST-0001")


class TestCouponUsage(NoSiteTestCase):
    """Whichever path a sale takes, its coupon counts once."""

    def _submit(self, payload, document, **kwargs):
        invoice_doc = frappe._dict({"name": "SINV-1", "pos_profile": "Main", "branch": "Main", **document})
        invoice_doc.flags = frappe._dict()
        invoice_doc.save = Mock()
        invoice_doc.submit = Mock()
        frappe.local.flags = frappe._dict()
        frappe.local.db.exists.return_value = bool(payload.get("name"))

        processor = "pos_next.services.invoice_processor"
        coupon = "pos_next.pos_next.doctype.pos_coupon.pos_coupon"
        wallet = "pos_next.pos_next.doctype.wallet_transaction.wallet_transaction"
        with (
            patch(f"{processor}.frappe.get_doc", return_value=invoice_doc),
            patch(f"{processor}.save_invoice_draft", return_value={"name": "SINV-1"}),
            patch(f"{processor}._assert_invoice_write_access"),
            patch(f"{processor}._set_payment_accounts"),
            patch(f"{processor}._auto_set_return_batches"),
            patch(f"{processor}._validate_stock_on_invoice"),
            patch(f"{wallet}.reverse_wallet_transactions_for_return"),
            patch(f"{coupon}.increment_coupon_usage") as increment,
        ):
            process_invoice(payload, {}, "Sales Invoice", "Main", **kwargs)
        return increment

    def test_online_with_the_code_on_the_draft(self):
        increment = self._submit(
            {"name": "SINV-1", "coupon_code": None, "pos_coupon_code": "SAVE10"}, {"pos_coupon_code": "SAVE10"}
        )
        increment.assert_called_once_with("SAVE10")

    def test_online_with_only_the_name_of_the_draft(self):
        increment = self._submit({"name": "SINV-1"}, {"pos_coupon_code": "SAVE10"})
        increment.assert_called_once_with("SAVE10")

    def test_a_queued_sale(self):
        increment = self._submit({"coupon_code": "SAVE10"}, {"pos_coupon_code": "SAVE10"}, queued=True)
        increment.assert_called_once_with("SAVE10")

    def test_a_code_that_stayed_in_erpnexts_field(self):
        increment = self._submit({"name": "SINV-1", "coupon_code": "SAVE10"}, {"coupon_code": "SAVE10"})
        increment.assert_called_once_with("SAVE10")

    def test_a_return_inherits_the_code_and_redeems_nothing(self):
        increment = self._submit(
            {"name": "SINV-2"},
            {"pos_coupon_code": "SAVE10", "is_return": 1, "return_against": "SINV-1", "grand_total": -10},
        )
        increment.assert_not_called()

    def test_a_sale_without_a_coupon(self):
        self._submit({"name": "SINV-1"}, {}).assert_not_called()


class TestReprocessWithoutPayload(NoSiteTestCase):
    def _reprocess(self, row):
        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row),
            patch.object(sync_inbox, "process") as self.process,
        ):
            return sync_inbox.reprocess("row-1", "note")

    def test_the_review_stays_open(self):
        row = MagicMock(status=sync_inbox.REVIEW, payload=None)
        row.as_dict.return_value = frappe._dict(status=sync_inbox.REVIEW)

        result = self._reprocess(row)

        self.assertEqual(result.status, sync_inbox.REVIEW)
        self.process.assert_not_called()
        row.save.assert_not_called()
        self.assertEqual(row.status, sync_inbox.REVIEW)

    def test_a_record_with_a_payload_is_processed(self):
        self._reprocess(MagicMock(status=sync_inbox.REVIEW, payload="{}"))
        self.process.assert_called_once_with("row-1")


class TestQueuedCoupons(NoSiteTestCase):
    def _apply(self, queued, result):
        invoice = frappe._dict(customer="Customer A", company="ACME", posting_date="2026-11-05", coupon_code="SAVE10")
        with patch(
            "pos_next.pos_next.doctype.pos_coupon.pos_coupon.check_coupon_code", return_value=result
        ) as self.check:
            overrun = invoices._apply_coupon(invoice, "SAVE10", queued)
        return invoice, overrun

    def test_the_online_path_asks_for_no_exception(self):
        invoice, overrun = self._apply(False, {"valid": True, "overrun": None})

        self.assertIsNone(self.check.call_args.kwargs["queued_on"])
        self.assertEqual(invoice.coupon_code, "SAVE10")
        self.assertIsNone(overrun)

    def test_the_online_path_still_refuses(self):
        with self.assertRaises(frappe.ValidationError):
            self._apply(False, {"valid": False, "msg": "Fully redeemed"})

    def test_a_queued_sale_is_judged_on_its_own_date(self):
        self._apply(True, {"valid": True})
        self.assertEqual(self.check.call_args.kwargs["queued_on"], "2026-11-05")

    def test_a_queued_sale_stays_out_of_erpnexts_coupon_checks(self):
        invoice, overrun = self._apply(True, {"valid": True, "overrun": "Already used 5 times of 5 allowed"})

        self.assertIsNone(invoice.coupon_code)
        self.assertEqual(invoice.pos_coupon_code, "SAVE10")
        self.assertEqual(overrun, "Already used 5 times of 5 allowed")

    def test_a_refusal_other_than_the_limit_still_stops_a_queued_sale(self):
        with self.assertRaises(frappe.ValidationError):
            self._apply(True, {"valid": False, "msg": "Disabled"})

    @patch("pos_next.api.invoices.save_invoice_draft")
    def test_a_client_cannot_claim_to_be_queued_through_update_invoice(self, save_draft):
        invoices.update_invoice({"queued": 1})
        save_draft.assert_called_once_with({"queued": 1})

    @patch("pos_next.services.sync_inbox.record_direct_sync")
    @patch("pos_next.services.sync_inbox.get_duplicate_response", return_value=None)
    @patch("pos_next.services.invoice_processor.process_invoice", return_value={"name": "SINV-1"})
    @patch("pos_next.api.invoices._assert_invoice_write_access")
    def test_a_client_cannot_claim_to_be_queued_through_submit_invoice(
        self, _access, process_invoice, _duplicate, _record
    ):
        invoice = {"doctype": "Sales Invoice", "pos_profile": "Main", "queued": 1, "offline_id": "pos_offline_x"}

        invoices.submit_invoice(invoice=invoice, data={"queued": 1})

        self.assertNotIn("queued", process_invoice.call_args.kwargs)

    @patch("pos_next.api.invoices._assert_invoice_write_access")
    @patch("pos_next.services.invoice_processor.process_invoice")
    def test_the_inbox_is_what_says_a_sale_is_queued(self, process_invoice, _access):
        process_invoice.return_value = {"name": "SINV-1", "grand_total": 10}

        sync_inbox._create_invoice(_row(payload=json.dumps({"pos_profile": "Main"})))

        self.assertTrue(process_invoice.call_args.kwargs["queued"])

    def test_the_overrun_stays_on_the_record(self):
        result = {"name": "SINV-1", "doctype": "Sales Invoice", "coupon_overrun": "Already used 5 times of 5 allowed"}
        with patch.object(sync_inbox, "_log_attempt") as log_attempt, patch.object(sync_inbox, "_notify_uploader"):
            sync_inbox._mark_synced("row-1", result, "synced")

        values = frappe.local.db.set_value.call_args.args[2]
        self.assertEqual(values["status"], "Synced")
        self.assertEqual(values["coupon_overrun"], "Already used 5 times of 5 allowed")
        log_attempt.assert_any_call("row-1", "coupon overrun", message="Already used 5 times of 5 allowed")

    def test_keeping_the_sale_without_the_coupon_clears_the_field_that_counts(self):
        payload = {"coupon_code": "SAVE10", "pos_coupon_code": "SAVE10", "customer": "CUST-0001"}

        sync_inbox._fix_remove_coupon(payload, {})

        self.assertEqual(payload, {"customer": "CUST-0001"})

    def test_a_manager_can_keep_the_sale_without_the_coupon(self):
        row = Mock(status=sync_inbox.REVIEW, entity="invoice", payload='{"coupon_code": "SAVE10", "discount_amount": 5}')
        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row),
            patch.object(sync_inbox, "_log_attempt"),
        ):
            sync_inbox.apply_fix("row-1", "remove_coupon", {})

        self.assertEqual(json.loads(row.payload), {"discount_amount": 5})


class TestQueuedReturns(NoSiteTestCase):
    prepared = {
        "customer": "CUST-0001",
        "doctype": "Sales Invoice",
        "items": [
            {
                "item_code": "A",
                "sales_invoice_item": "row-a",
                "rate": 9.5,
                "uom": "Nos",
                "warehouse": "Stores",
                "conversion_factor": 1,
            },
            {
                "item_code": "B",
                "sales_invoice_item": "row-b",
                "rate": 20,
                "uom": "Box",
                "warehouse": "Stores",
                "conversion_factor": 12,
            },
        ],
    }

    def _align(self, payload, prepared=None):
        with (
            patch("pos_next.api.invoices._prepare_return_invoice", return_value=prepared or self.prepared) as self.prepare,
            patch(
                "pos_next.services.sync_entities.frappe.get_all",
                return_value=[(1, "row-a"), (2, "row-b")],
            ),
        ):
            sync_entities.align_return(payload)
        return payload

    def test_applies_the_online_rules_on_the_day_of_the_return(self):
        self._align({"return_against": "SINV-1", "posting_date": "2026-11-05", "posa_pos_opening_shift": "S", "items": []})
        self.prepare.assert_called_once_with("SINV-1", "S", as_of="2026-11-05")

    def test_a_broken_rule_stops_the_return_with_its_reason(self):
        with patch(
            "pos_next.api.invoices._prepare_return_invoice",
            side_effect=frappe.ValidationError("Return period has expired"),
        ):
            with self.assertRaises(frappe.ValidationError):
                sync_entities.align_return({"return_against": "SINV-1", "items": []})

    def test_a_return_from_a_kept_document_keeps_its_rates(self):
        item = {"item_code": "A", "sales_invoice_item": "row-a", "rate": 9.9}
        payload = self._align({"return_against": "SINV-1", "items": [item]})
        self.assertEqual(payload["items"][0]["rate"], 9.9)

    def test_a_return_of_a_queued_sale_gets_its_links_and_rates(self):
        payload = self._align(
            {
                "return_against": "SINV-1",
                "items": [{"item_code": "B", "qty": -1, "rate": 25, "original_idx": 2}],
            }
        )

        item = payload["items"][0]
        self.assertEqual(item["sales_invoice_item"], "row-b")
        self.assertEqual(item["rate"], 20)
        self.assertEqual(item["uom"], "Box")
        self.assertEqual(item["conversion_factor"], 12)
        self.assertNotIn("original_idx", item)

    def test_uses_the_pos_invoice_link_on_a_pos_invoice(self):
        prepared = {
            "customer": "CUST-0001",
            "doctype": "POS Invoice",
            "items": [
                {
                    "item_code": "A",
                    "pos_invoice_item": "row-a",
                    "rate": 9.5,
                    "uom": "Nos",
                    "warehouse": "Stores",
                    "conversion_factor": 1,
                }
            ],
        }
        payload = self._align(
            {"return_against": "POSINV-1", "items": [{"item_code": "A", "original_idx": 1}]}, prepared
        )
        self.assertEqual(payload["items"][0]["pos_invoice_item"], "row-a")

    def test_a_row_with_nothing_left_to_return_fails_with_the_reason(self):
        prepared = {**self.prepared, "items": self.prepared["items"][:1]}
        with self.assertRaises(frappe.ValidationError):
            self._align({"return_against": "SINV-1", "items": [{"item_code": "B", "original_idx": 2}]}, prepared)

    def test_a_different_item_at_that_position_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            self._align({"return_against": "SINV-1", "items": [{"item_code": "Z", "original_idx": 1}]})

    def test_the_return_follows_its_invoice_to_a_corrected_customer(self):
        payload = self._align({"return_against": "SINV-1", "customer": "CUST-OLD", "items": []})
        self.assertEqual(payload["customer"], "CUST-0001")

    @patch("pos_next.api.invoices._assert_invoice_write_access")
    @patch("pos_next.services.invoice_processor.process_invoice")
    @patch("pos_next.services.sync_entities.align_return")
    def test_a_return_waits_for_the_real_name_of_its_invoice(self, align_return, process_invoice, _access):
        frappe.local.db.get_value.return_value = frappe._dict(status="Synced", sales_invoice="SINV-9")
        process_invoice.return_value = {"name": "SINV-10", "grand_total": -10}
        stored = json.dumps({"is_return": 1, "return_against": LOCAL_INVOICE, "pos_profile": "Main"})

        sync_inbox._create_invoice(_row(payload=stored, depends_on=LOCAL_INVOICE))

        self.assertEqual(align_return.call_args.args[0]["return_against"], "SINV-9")
        self.assertEqual(process_invoice.call_args.args[0]["return_against"], "SINV-9")

    def test_a_return_of_a_voided_sale_needs_a_person(self):
        frappe.local.db.get_value.return_value = frappe._dict(status="Voided", sales_invoice=None)
        stored = json.dumps({"is_return": 1, "return_against": LOCAL_INVOICE, "pos_profile": "Main"})

        with self.assertRaises(DependencyError):
            sync_inbox._create_invoice(_row(payload=stored, depends_on=LOCAL_INVOICE))

    def test_a_request_cannot_set_the_day_of_a_return(self):
        for method in (invoices.validate_return_items, invoices.prepare_return_invoice):
            self.assertNotIn("as_of", inspect.signature(method).parameters)


class TestReturnPeriod(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        frappe.local.qb = MagicMock()
        self.addCleanup(setattr, frappe.local, "qb", None)
        frappe.local.db.get_value.return_value = 7

        run = frappe.local.qb.from_.return_value.select.return_value.where.return_value.run
        run.return_value = [frappe._dict(pos_profile="Main", posting_date="2026-11-01")]

        patcher = patch("pos_next.api.invoices.nowdate", return_value="2026-12-30")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_online_counts_from_today(self):
        result = invoices._validate_return_items("SINV-1", [], "Sales Invoice")
        self.assertFalse(result["valid"])

    def test_a_queued_return_counts_from_the_day_it_was_made(self):
        with patch("frappe.utils.date_diff", return_value=4) as date_diff:
            result = invoices._validate_return_items("SINV-1", [], "Sales Invoice", as_of="2026-11-05")

        self.assertTrue(result["valid"])
        self.assertEqual(str(date_diff.call_args.args[0]), "2026-11-05")


class TestOfflineReturnDocuments(NoSiteTestCase):
    @patch("pos_next.api.invoices._prepare_return_invoice")
    @patch("pos_next.api.invoices._assert_invoice_write_access")
    def test_nothing_is_prepared_while_the_setting_is_off(self, _access, prepare):
        frappe.local.db.get_value.return_value = 0

        self.assertEqual(invoices.get_offline_return_documents("Main"), [])
        prepare.assert_not_called()

    @patch("pos_next.api.invoices.frappe.clear_messages")
    @patch("pos_next.api.invoices.get_returnable_invoices")
    @patch("pos_next.api.invoices._prepare_return_invoice")
    @patch("pos_next.api.invoices._assert_invoice_write_access")
    def test_keeps_what_a_device_needs_with_the_rules_of_each_invoice(
        self, _access, prepare, returnable, _clear_messages
    ):
        frappe.local.db.get_value.side_effect = [1, {"allow_return": 1, "return_validity_days": 30}]
        returnable.return_value = [frappe._dict(name="SINV-1"), frappe._dict(name="SINV-2")]
        prepare.side_effect = [
            {
                "doctype": "Sales Invoice",
                "return_against": "SINV-1",
                "pos_profile": "Other Branch",
                "sales_team": [{"sales_person": "Sara", "allocated_percentage": 100, "incentives": 3}],
                "items": [{"item_code": "A", "remaining_qty": 2, "income_account": "Sales - T"}],
                "taxes": [{"account_head": "VAT - T"}],
            },
            frappe.ValidationError("All items from this invoice have already been returned"),
        ]

        documents = invoices.get_offline_return_documents("Main")

        self.assertEqual(len(documents), 1)
        document = documents[0]
        self.assertEqual(document["_return_rules"]["return_validity_days"], 30)
        self.assertEqual(document["items"][0]["remaining_qty"], 2)
        self.assertNotIn("income_account", document["items"][0])
        self.assertNotIn("taxes", document)
        self.assertEqual(document["sales_team"], [{"sales_person": "Sara", "allocated_percentage": 100}])


class TestShiftCloseWaiting(NoSiteTestCase):
    manifest = ["pos_offline_sale-1", "pos_offline_sale-2"]

    def _row(self, **values):
        return _row(entity="shift_close", depends_on="\n".join(self.manifest), **values)

    def _is_blocked(self, row, statuses):
        with patch("pos_next.services.sync_inbox.frappe.get_all", return_value=statuses):
            return sync_inbox._is_blocked(row)

    def _flag(self, row, statuses):
        frappe.local.db.get_value.return_value = "Blocked"
        with (
            patch("pos_next.services.sync_inbox.frappe.get_all", return_value=statuses),
            patch.object(sync_inbox, "_handle_failure") as handle_failure,
        ):
            sync_inbox._flag_if_stuck(row)
        return handle_failure

    def test_the_whole_manifest_is_waited_for_even_if_the_device_left_some_out(self):
        dependencies = sync_entities.get_dependencies({"manifest": self.manifest}, ["pos_offline_sale-2"])
        self.assertCountEqual(dependencies, self.manifest)

    def test_a_sale_in_the_manifest_that_never_arrived_holds_the_close(self):
        self.assertTrue(self._is_blocked(self._row(), [("pos_offline_sale-1", "Synced")]))

    def test_the_close_goes_ahead_when_everything_has_finished(self):
        statuses = [("pos_offline_sale-1", "Synced"), ("pos_offline_sale-2", "Voided")]
        self.assertFalse(self._is_blocked(self._row(), statuses))

    def test_a_manager_can_go_ahead_without_them(self):
        self.assertFalse(self._is_blocked(self._row(accept_unfinished=1), []))

    def test_names_the_sale_that_never_arrived(self):
        row = self._row(received_at=datetime.now() - timedelta(hours=2))
        handle_failure = self._flag(row, [("pos_offline_sale-1", "Synced")])

        exc = handle_failure.call_args.args[2]
        self.assertIn("pos_offline_sale-2", str(exc))
        self.assertNotIn("pos_offline_sale-1", str(exc))
        self.assertEqual(classify(exc).error_class, "dependency")

    def test_a_sale_under_review_reaches_a_manager(self):
        row = self._row(received_at=datetime.now() - timedelta(hours=2))
        statuses = [("pos_offline_sale-1", "Synced"), ("pos_offline_sale-2", "Needs Review")]
        self.assertIn("pos_offline_sale-2", str(self._flag(row, statuses).call_args.args[2]))

    def test_an_invoice_waiting_on_a_customer_under_review_stays_blocked(self):
        row = _row(depends_on=LOCAL_CUSTOMER, received_at=datetime.now() - timedelta(hours=2))
        self._flag(row, [(LOCAL_CUSTOMER, "Needs Review")]).assert_not_called()

    def test_sales_on_their_way_are_given_time(self):
        row = self._row(received_at=datetime.now() - timedelta(hours=2))
        statuses = [("pos_offline_sale-1", "Received"), ("pos_offline_sale-2", "Processing")]
        self._flag(row, statuses).assert_not_called()

    def test_going_ahead_needs_a_manager_on_a_shift_close_only(self):
        row = Mock(status=sync_inbox.REVIEW, entity="shift_close", payload="{}")
        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row),
            patch.object(sync_inbox, "_log_attempt"),
        ):
            sync_inbox.apply_fix("row-1", "accept_unfinished", {})
        row.set.assert_called_once_with("accept_unfinished", 1)

        with self.assertRaises(frappe.ValidationError):
            row.entity = "invoice"
            with patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row):
                sync_inbox.apply_fix("row-1", "accept_unfinished", {})


class TestCloseShift(NoSiteTestCase):
    payload = json.dumps(
        {
            "pos_opening_shift": "POSA-OS-1",
            "posting_date": "2026-11-05",
            "period_end_date": "2026-11-05 22:10:00",
            "closing_amounts": [
                {"mode_of_payment": "Cash", "closing_amount": 480},
                {"mode_of_payment": "Gift Voucher", "closing_amount": 20},
            ],
        }
    )
    closing = {
        "pos_opening_shift": "POSA-OS-1",
        "grand_total": 500,
        "posting_date": "2026-11-06",
        "period_end_date": "2026-11-06 09:00:00",
        "payment_reconciliation": [
            {"mode_of_payment": "Cash", "opening_amount": 0, "expected_amount": 500},
            {"mode_of_payment": "Card", "opening_amount": 0, "expected_amount": 30},
        ],
    }

    def _close(self, row=None, assert_may_close=None):
        opening = Mock(pos_profile="Main")
        opening.as_dict.return_value = {"name": "POSA-OS-1"}
        frappe.local.db.exists.return_value = True
        closing_module = "pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift"
        with (
            patch("pos_next.services.sync_entities.frappe.get_doc", return_value=opening),
            patch("pos_next.api.invoices._assert_invoice_write_access") as self.access,
            patch("pos_next.api.shifts.assert_may_close_shift", assert_may_close or Mock()) as self.role,
            patch(f"{closing_module}.build_closing_shift", return_value=json.loads(json.dumps(self.closing))),
            patch(f"{closing_module}.save_closing_shift", return_value="POS-CLOSE-1") as self.submit,
        ):
            return sync_entities.close_shift(row or _row(entity="shift_close", payload=self.payload))

    def _submitted(self):
        return self.submit.call_args.args[0]

    def test_returns_the_closing_entry(self):
        self.assertEqual(
            self._close(), {"name": "POS-CLOSE-1", "doctype": "POS Closing Shift", "grand_total": 500}
        )

    def test_the_count_is_the_cashiers_and_the_totals_are_the_servers(self):
        self._close()
        rows = {row["mode_of_payment"]: row for row in self._submitted()["payment_reconciliation"]}
        self.assertEqual(rows["Cash"]["closing_amount"], 480)
        self.assertEqual(rows["Cash"]["expected_amount"], 500)

    def test_a_mode_nobody_counted_counts_as_zero(self):
        self._close()
        rows = {row["mode_of_payment"]: row for row in self._submitted()["payment_reconciliation"]}
        self.assertEqual(rows["Card"]["closing_amount"], 0)

    def test_counted_money_with_nothing_expected_still_shows(self):
        self._close()
        rows = {row["mode_of_payment"]: row for row in self._submitted()["payment_reconciliation"]}
        self.assertEqual(rows["Gift Voucher"]["closing_amount"], 20)
        self.assertEqual(rows["Gift Voucher"]["expected_amount"], 0)

    def test_keeps_the_day_the_cash_was_counted(self):
        self._close()
        submitted = self._submitted()
        self.assertEqual(submitted["posting_date"], "2026-11-05")
        self.assertEqual(submitted["period_end_date"], "2026-11-05 22:10:00")

    def test_checks_the_cashier_who_closed_it(self):
        self._close()
        self.access.assert_called_once_with("Sales Invoice", "Main", "cashier@example.com")
        self.assertEqual(self.role.call_args.args[1], "cashier@example.com")

    def test_the_uploader_is_held_to_the_profile_of_the_shift(self):
        self._close(_row(entity="shift_close", payload=self.payload, uploaded_by="uploader@example.com"))
        self.assertEqual(
            [call.args for call in self.access.call_args_list],
            [("Sales Invoice", "Main", "cashier@example.com"), ("Sales Invoice", "Main", "uploader@example.com")],
        )

    def test_a_cashier_without_the_role_stops_it(self):
        with self.assertRaises(frappe.PermissionError):
            self._close(assert_may_close=Mock(side_effect=frappe.PermissionError("Role")))
        self.submit.assert_not_called()

    def test_a_shift_that_does_not_exist_is_a_contract_problem(self):
        frappe.local.db.exists.return_value = False
        with self.assertRaises(SyncContractError):
            sync_entities.close_shift(_row(entity="shift_close", payload='{"pos_opening_shift": "GONE"}'))

    def test_nothing_counts_as_already_closed_by_someone_else(self):
        self.assertIsNone(sync_entities.find_shift_close("id"))

    def test_the_shift_is_found_through_its_own_field(self):
        item = {"offline_id": "x", "entity": "shift_close", "payload": {"pos_opening_shift": "POSA-OS-1"}}
        frappe.local.db.get_value.return_value = None
        frappe.local.db.exists.side_effect = lambda doctype, name: name
        document = Mock()

        with patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=document) as get_doc:
            sync_inbox.ingest(item, "cashier@example.com")

        values = get_doc.call_args.args[0]
        self.assertEqual(values["shift"], "POSA-OS-1")
        self.assertEqual(values["entity"], "shift_close")


class TestPendingClose(NoSiteTestCase):
    def test_looks_for_an_unfinished_close(self):
        frappe.local.db.exists.return_value = "row-1"

        self.assertTrue(sync_entities.has_pending_close("POSA-OS-1"))

        filters = frappe.local.db.exists.call_args.args[1]
        self.assertEqual(filters["entity"], "shift_close")
        self.assertEqual(filters["status"], ["not in", sync_entities.FINAL_STATES])

    @patch("pos_next.api.shifts.has_pending_close", return_value=True)
    def test_a_shift_closing_on_the_server_cannot_be_sold_into(self, _pending):
        frappe.local.db.get_all.return_value = [{"name": "POSA-OS-1", "pos_profile": "Main"}]
        self.assertIsNone(shifts.check_opening_shift("cashier@example.com"))

    def test_the_role_check_can_ask_about_the_cashier(self):
        frappe.local.db.get_value.return_value = "Cashier Lead"
        with patch("pos_next.api.shifts.frappe.get_roles", return_value=["Cashier Lead"]) as get_roles:
            shifts.assert_may_close_shift(Mock(pos_profile="Main"), "cashier@example.com")
        get_roles.assert_called_once_with("cashier@example.com")


class TestClosingValidation(NoSiteTestCase):
    def _validate(self, rows):
        closing = Mock(pos_opening_shift="POSA-OS-1")
        with (
            patch.object(pos_closing_shift.frappe, "get_all", return_value=rows),
            patch.object(pos_closing_shift, "_", lambda text: text),
            patch.object(pos_closing_shift.frappe, "msgprint") as self.msgprint,
        ):
            pos_closing_shift.POSClosingShift.validate_invoice_sync(closing)

    def test_the_close_being_processed_does_not_hold_up_itself(self):
        self._validate([frappe._dict(status="Processing", entity="shift_close", count=1)])

    def test_a_sale_still_processing_holds_it(self):
        with self.assertRaises(frappe.ValidationError):
            self._validate([frappe._dict(status="Processing", entity="invoice", count=1)])

    def test_a_row_from_before_entities_still_counts(self):
        with self.assertRaises(frappe.ValidationError):
            self._validate([frappe._dict(status="Received", entity=None, count=2)])

    def test_a_sale_under_review_only_warns(self):
        self._validate([frappe._dict(status="Needs Review", entity="invoice", count=1)])
        self.msgprint.assert_called_once()


class TestSaveInvoiceDraft(NoSiteTestCase):
    @patch("pos_next.api.invoices.frappe.log_error")
    @patch("pos_next.api.invoices._assert_invoice_write_access")
    @patch("pos_next.api.invoices.frappe.get_doc")
    def test_never_makes_a_customer_out_of_a_local_name(self, get_doc, _access, _log_error):
        invoice = frappe._dict(customer=LOCAL_CUSTOMER, doctype="Sales Invoice")
        get_doc.return_value = invoice

        with self.assertRaises(frappe.ValidationError):
            save_invoice_draft({"doctype": "Sales Invoice", "customer": LOCAL_CUSTOMER})

        self.assertEqual(get_doc.call_count, 1)


if __name__ == "__main__":
    unittest.main()
