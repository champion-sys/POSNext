# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

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
