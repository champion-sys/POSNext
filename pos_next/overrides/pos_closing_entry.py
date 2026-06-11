# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import frappe
from erpnext.accounts.doctype.pos_closing_entry.pos_closing_entry import POSClosingEntry

class CustomPOSClosingEntry(POSClosingEntry):
	def fetch_invoice_type(self):
		if self.pos_profile:
			self.invoice_type = frappe.db.get_value(
				"POS Settings",
				{"pos_profile": self.pos_profile},
				"invoice_type"
			) or "Sales Invoice"
		else:
			self.invoice_type = frappe.db.get_single_value("POS Settings", "invoice_type") or "Sales Invoice"
