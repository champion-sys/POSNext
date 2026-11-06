# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Whole journeys through the inbox, on an in-memory stand-in for its table."""

import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from pos_next.api import sync as sync_api
from pos_next.services import sync_inbox
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
        self.assigned = {"Main": {"cashier@example.com"}}
        self.device_profiles = ["Main"]
        self.shifts = {}

    @staticmethod
    def _matches(row, filters):
        for fieldname, expected in filters.items():
            value = row.get(fieldname)
            if isinstance(expected, list):
                operator, operand = expected
                if operator == "in" and value not in operand:
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
            return self.shifts.get(filters)
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
        values = field if isinstance(field, dict) else {field: value}
        self.rows[name].update(values)

    def exists(self, doctype, name=None):
        if doctype == "POS Profile User":
            profiles = [name["parent"]] if "parent" in name else self.assigned
            return any(name["user"] in self.assigned.get(profile, ()) for profile in profiles)
        return name

    def commit(self):
        pass

    def rollback(self, **_kwargs):
        pass

    def count(self, *_args, **_kwargs):
        return 0

    def insert(self, values):
        name = f"row-{len(self.rows) + 1}"
        self.rows[name] = frappe._dict({"attempts": 0, **values, "name": name})
        return name


class Flow(unittest.TestCase):
    def setUp(self):
        self.inbox = FakeInbox()
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
            ("pos_next.services.sync_inbox.get_datetime", lambda value: value),
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
        session = frappe.local.session
        sid, data = session.sid, session.data
        form_dict = frappe.local.form_dict

        self._process(name, Mock(return_value=self.finished))

        self.assertIs(session.sid, sid)
        self.assertIs(session.data, data)
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
            patch("pos_next.services.invoice_processor.process_invoice") as process_invoice,
        ):
            process_invoice.return_value = {"name": "SINV-1", "grand_total": 0}
            sync_inbox.process(name)

        self.assertNotIn("owner", process_invoice.call_args.args[0])
        self.assertEqual(process_invoice.call_args.kwargs, {"offline_id": SALE, "queued": True})


class TestClosedShift(Flow):
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

    def test_a_sales_invoice_posts_on_submit_whatever_its_shift(self):
        self.inbox.shifts["SHIFT-1"] = "Closed"

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

    def test_a_claim_to_be_someone_outside_the_profile_is_dropped(self):
        self.push(self.item(cashier="omar@example.com"))
        self.assertEqual(self.stored().cashier, "lina@example.com")

    def test_high_roles_do_not_make_someone_a_cashier_here(self):
        self.profile_writers.add("Administrator")

        self.push(self.item(cashier="Administrator"))

        self.assertEqual(self.stored().cashier, "lina@example.com")

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
