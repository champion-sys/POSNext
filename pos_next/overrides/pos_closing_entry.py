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

	def validate_pos_invoices(self):
		"""Check a shift's invoices against whoever sold them, not all against the shift's user.

		A shared device uploads a colleague's sale into the open shift, and it stays in her
		name, so the shift it belongs to must still close. Other closings keep ERPNext's rule.
		"""
		if not self.flags.closes_shift:
			super().validate_pos_invoices()
			return

		closing_user, rows = self.user, self.pos_invoices
		owners = dict(
			frappe.get_all(
				"POS Invoice",
				filters={"name": ["in", [row.pos_invoice for row in rows]]},
				fields=["name", "owner"],
				as_list=True,
			)
		)
		by_owner = {}
		for row in rows:
			by_owner.setdefault(owners.get(row.pos_invoice), []).append(row)

		try:
			for owner, owned in by_owner.items():
				self.user, self.pos_invoices = owner, owned
				super().validate_pos_invoices()
		finally:
			self.user, self.pos_invoices = closing_user, rows
