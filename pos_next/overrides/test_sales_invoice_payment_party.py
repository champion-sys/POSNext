# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import unittest
from unittest.mock import Mock, patch

from pos_next.overrides.sales_invoice import get_payment_party


class TestPaymentParty(unittest.TestCase):
    def party(self, exists):
        with patch("pos_next.overrides.sales_invoice.frappe.db", Mock(exists=Mock(return_value=exists))):
            return get_payment_party("Cash")

    def test_a_site_with_the_party_type_keeps_the_party(self):
        self.assertEqual(self.party(True), {"party_type": "Mode of Payment", "party": "Cash"})

    def test_a_site_without_it_sets_no_party_for_erpnext_to_refuse(self):
        self.assertEqual(self.party(False), {})
