# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest

import frappe

from pos_next.services import sync_classifier as sc
from pos_next.services.sync_classifier import (
    CashierUnavailableError,
    ShiftClosedError,
    SyncContractError,
    TotalMismatchError,
    classify,
)
from pos_next.services.sync_inbox import compute_payload_hash, validate_envelope


class QueryDeadlockError(Exception):
    pass


class NegativeStockError(frappe.ValidationError):
    pass


class TestClassify(unittest.TestCase):
    def test_database_contention_is_transient(self):
        self.assertEqual(classify(QueryDeadlockError("Deadlock")).error_class, sc.TRANSIENT_SERVER)

    def test_stock_shortage_by_type(self):
        self.assertEqual(classify(NegativeStockError("Short")).error_class, sc.STOCK)

    def test_stock_shortage_from_the_pos_check(self):
        exc = frappe.ValidationError(frappe.as_json({"errors": [{"item_code": "A"}]}))
        self.assertEqual(classify(exc).error_class, sc.STOCK)

    def test_business_rule(self):
        self.assertEqual(classify(frappe.ValidationError("Closed period")).error_class, sc.BUSINESS)
        self.assertEqual(classify(TotalMismatchError("Differs")).error_class, sc.BUSINESS)
        self.assertEqual(classify(frappe.PermissionError("No access")).error_class, sc.BUSINESS)

    def test_what_only_a_person_can_settle_has_a_stable_code_and_no_retry(self):
        for error in (CashierUnavailableError, ShiftClosedError):
            result = classify(error("مغلقة"))
            self.assertEqual(result.error_class, sc.BUSINESS)
            self.assertEqual(result.error_code, error.__name__)
            self.assertIsNone(sc.next_retry_minutes(result.error_class, 1))

    def test_contract(self):
        self.assertEqual(classify(SyncContractError("Bad JSON")).error_class, sc.CONTRACT)

    def test_anything_else_is_a_bug(self):
        self.assertEqual(classify(KeyError("oops")).error_class, sc.BUG)

    def test_code_is_stable_across_languages(self):
        self.assertEqual(classify(frappe.ValidationError("فترة مقفلة")).error_code, "ValidationError")

    def test_same_cause_groups_across_invoices(self):
        first = classify(frappe.ValidationError("Row 3: item 1001 is disabled"))
        second = classify(frappe.ValidationError("Row 7: item 2002 is disabled"))
        self.assertEqual(first.fingerprint, second.fingerprint)

    def test_html_is_removed_from_the_message(self):
        self.assertEqual(classify(frappe.ValidationError("<b>Stop</b>")).message, "Stop")


class TestRetryPolicy(unittest.TestCase):
    def test_transient_retries_then_goes_to_review(self):
        self.assertEqual(sc.next_retry_minutes(sc.TRANSIENT_SERVER, 1), 1)
        self.assertEqual(sc.next_retry_minutes(sc.TRANSIENT_SERVER, 5), 240)
        self.assertIsNone(sc.next_retry_minutes(sc.TRANSIENT_SERVER, 6))

    def test_stock_retries_four_times(self):
        self.assertEqual(sc.next_retry_minutes(sc.STOCK, 4), 15)
        self.assertIsNone(sc.next_retry_minutes(sc.STOCK, 5))

    def test_business_goes_straight_to_review(self):
        self.assertIsNone(sc.next_retry_minutes(sc.BUSINESS, 1))
        self.assertIsNone(sc.next_retry_minutes(sc.BUG, 1))


class TestEnvelope(unittest.TestCase):
    def test_hash_ignores_key_order_and_print_marks(self):
        first = {"customer": "A", "items": [{"qty": 1}]}
        second = {"items": [{"qty": 1}], "was_printed": True, "customer": "A"}
        self.assertEqual(compute_payload_hash(first), compute_payload_hash(second))

    def test_hash_changes_with_the_sale(self):
        self.assertNotEqual(compute_payload_hash({"total": 1}), compute_payload_hash({"total": 2}))

    def test_valid_envelope(self):
        self.assertIsNone(validate_envelope({"offline_id": "x", "pos_profile": "Main", "payload": {}}))

    def test_rejects_missing_fields(self):
        self.assertIn("offline_id", validate_envelope({"payload": {}}))
        self.assertIn("payload", validate_envelope({"offline_id": "x", "pos_profile": "Main"}))
        self.assertIn("pos_profile", validate_envelope({"offline_id": "x", "payload": {}}))
        self.assertIsNotNone(validate_envelope("not a dict"))


if __name__ == "__main__":
    unittest.main()
