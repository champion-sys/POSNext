# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""
POS Invoice Override
Handles wallet payments that require party information for Receivable accounts.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt
from erpnext.accounts.doctype.pos_invoice.pos_invoice import POSInvoice
from erpnext.accounts.utils import get_account_currency

def _get_post_change_gl_entries_setting():
	"""
	Get post_change_gl_entries setting compatible with ERPNext v15 and v16.
	"""
	meta = frappe.get_meta("Accounts Settings")
	if meta.has_field("post_change_gl_entries"):
		value = frappe.db.get_single_value("Accounts Settings", "post_change_gl_entries")
		return cint(value) if value is not None else 0

	Singles = frappe.qb.DocType("Singles")
	result = (
		frappe.qb.from_(Singles)
		.select(Singles.value)
		.where(Singles.doctype == "POS Settings")
		.where(Singles.field == "post_change_gl_entries")
		.limit(1)
		.run()
	)
	return cint(result[0][0]) if result else 0

class CustomPOSInvoice(POSInvoice):
	"""
	Custom POS Invoice class that handles wallet payments correctly.
	"""

	# def make_pos_gl_entries(self, gl_entries):
	# 	"""
	# 	Override to add party information for wallet payment accounts.
	# 	"""
	# 	if cint(self.is_pos):
	# 		skip_change_gl_entries = not _get_post_change_gl_entries_setting()

	# 		for payment_mode in self.payments:
	# 			if skip_change_gl_entries and payment_mode.account == self.account_for_change_amount:
	# 				payment_mode.base_amount -= flt(self.change_amount)

	# 			if payment_mode.amount:
	# 				# Credit entry to debit_to (customer receivable)
	# 				gl_entries.append(
	# 					self.get_gl_dict(
	# 						{
	# 							"account": self.debit_to,
	# 							"party_type": "Customer",
	# 							"party": self.customer,
	# 							"against": payment_mode.account,
	# 							"credit": payment_mode.base_amount,
	# 							"credit_in_account_currency": payment_mode.base_amount
	# 							if self.party_account_currency == self.company_currency
	# 							else payment_mode.amount,
	# 							"against_voucher": self.return_against
	# 							if cint(self.is_return) and self.return_against
	# 							else self.name,
	# 							"against_voucher_type": self.doctype,
	# 							"cost_center": self.cost_center,
	# 						},
	# 						self.party_account_currency,
	# 						item=self,
	# 					)
	# 				)

	# 				# Debit entry to payment mode account
	# 				payment_mode_account_currency = get_account_currency(payment_mode.account)

	# 				# Get party info for wallet payments
	# 				party_type, party = self.get_party_and_party_type_for_pos_gl_entry(
	# 					payment_mode.mode_of_payment, payment_mode.account
	# 				)

	# 				gl_entries.append(
	# 					self.get_gl_dict(
	# 						{
	# 							"account": payment_mode.account,
	# 							"party_type": "Mode of Payment",
	# 							"party": payment_mode.mode_of_payment,
	# 							"against": self.customer,
	# 							"debit": payment_mode.base_amount,
	# 							"debit_in_account_currency": payment_mode.base_amount
	# 							if payment_mode_account_currency == self.company_currency
	# 							else payment_mode.amount,
	# 							"cost_center": self.cost_center,
	# 						},
	# 						payment_mode_account_currency,
	# 						item=self,
	# 					)
	# 				)

	# 		if not skip_change_gl_entries:
	# 			if hasattr(self, "get_gle_for_change_amount"):
	# 				gl_entries.extend(self.get_gle_for_change_amount())
	# 			else:
	# 				self.make_gle_for_change_amount(gl_entries)

	def validate_pos_paid_amount(self):
		"""
		Allow pure customer-credit POS sales to submit without a payment row.
		"""
		if getattr(self.flags, "pos_next_redeemed_customer_credit", 0):
			if len(self.payments) == 0 and cint(self.is_pos) and flt(self.grand_total) > 0:
				return

		super().validate_pos_paid_amount()

	def validate_is_pos_using_sales_invoice(self):
		if not self.pos_profile:
			return

		invoice_type = frappe.db.get_value("POS Settings", {"pos_profile": self.pos_profile}, "invoice_type") or "Sales Invoice"
		if invoice_type == "Sales Invoice" and not self.is_return:
			frappe.throw(_("Sales Invoice mode is activated in POS. Please create Sales Invoice instead."))

	def get_party_and_party_type_for_pos_gl_entry(self, mode_of_payment, account):
		"""
		Get party type and party for wallet payment GL entries.
		"""
		is_wallet_mode_of_payment = frappe.db.get_value(
			"Mode of Payment", mode_of_payment, "is_wallet_payment"
		)

		party_type, party = "", ""
		if is_wallet_mode_of_payment:
			party_type, party = "Customer", self.customer

		return party_type, party
