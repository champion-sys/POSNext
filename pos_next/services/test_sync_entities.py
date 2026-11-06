# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from pos_next.api import partial_payments
from pos_next.api.invoices import save_invoice_draft
from pos_next.services import sync_entities, sync_inbox
from pos_next.services.sync_classifier import DependencyError, SyncContractError, classify

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
            sync_inbox.DOCTYPE, "row-1", "status", "Received", update_modified=True
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

    def _create(self, payload=None, wallet_modes=()):
        with (
            patch("pos_next.api.invoices._assert_invoice_write_access") as self.access,
            patch("pos_next.api.partial_payments.post_queued_payments") as self.post,
            patch("pos_next.api.utilities.get_wallet_payment_modes", return_value=list(wallet_modes)),
        ):
            self.post.return_value = ["PE-1", "PE-2"]
            frappe.local.db.get_value.return_value = "Main"
            return sync_entities.create_payment(_row(entity="payment", payload=payload or self.payload))

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
    def _apply(self, entity, fix, values, payload="{}"):
        row = Mock(status=sync_inbox.REVIEW, entity=entity, payload=payload)
        with (
            patch("pos_next.services.sync_inbox.frappe.get_doc", return_value=row),
            patch.object(sync_inbox, "_log_attempt"),
        ):
            sync_inbox.apply_fix("row-1", fix, values)
        return row

    def test_a_customer_gets_a_valid_group(self):
        row = self._apply("customer", "customer_group", {"customer_group": "Retail"})
        self.assertEqual(json.loads(row.payload)["customer_group"], "Retail")

    def test_a_payment_can_be_reduced_to_what_is_owed(self):
        payload = json.dumps({"payments": [{"mode_of_payment": "Cash", "amount": 40}]})
        row = self._apply("payment", "payment_amount", {"mode_of_payment": "Cash", "amount": 25}, payload)
        self.assertEqual(json.loads(row.payload)["payments"][0]["amount"], 25)

    def test_a_fix_for_another_entity_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            self._apply("customer", "warehouse", {"warehouse": "Stores"})

    def test_a_row_from_before_entities_uses_the_sale_fixes(self):
        row = self._apply(None, "customer", {"customer": "CUST-0001"}, '{"customer": "pos_offline_x"}')
        self.assertEqual(json.loads(row.payload)["customer"], "CUST-0001")

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
