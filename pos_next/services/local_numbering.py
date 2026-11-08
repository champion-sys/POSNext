# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""The number a device gives an invoice the moment it is made.

A device numbers every sale and return it makes, online or offline:
"L" + the naming series ERPNext would use + the shift number + "-" + a counter of five
digits, such as LACC-SINV-2026-3-00001. Sales and returns count apart, within one shift.
The invoice keeps its ERPNext name once it reaches the server, and the number stays on it
in posa_local_number, so a cashier can find it by either one.

The device builds the number and the server never changes it. It is not unique and does
not identify a sale to the sync queue: offline_id does that.
"""

import json
import re

import frappe
from frappe import _

FIELD = "posa_local_number"
PREFIX = "L"
MAX_LENGTH = 140
INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")
SYNC_DOCTYPE = "Offline Invoice Sync"


class LocalNumberError(frappe.ValidationError):
	pass


def check(value):
	"""The local number to store, as the device sent it, or None when there is none.

	Raises:
		LocalNumberError: When it is not a number a device makes
	"""
	if value is None or value == "":
		return None
	if not isinstance(value, str) or not value.startswith(PREFIX):
		frappe.throw(_("Local number {0} must start with {1}").format(value, PREFIX), LocalNumberError)
	if len(value) > MAX_LENGTH:
		frappe.throw(
			_("Local number {0} is longer than {1} characters").format(value, MAX_LENGTH), LocalNumberError
		)
	return value


def of_payload(payload):
	"""What a queue record keeps of the number its payload carries.

	A record is stored before anything about its contents can fail, so a value that cannot
	be stored is left out here, and the invoice refuses it when the record is processed.
	"""
	value = (payload or {}).get(FIELD)
	return value if isinstance(value, str) and 0 < len(value) <= MAX_LENGTH else None


# ---------------------------------------------------------------------------
# What a device needs to number invoices
# ---------------------------------------------------------------------------


def shift_number(shift):
	"""The last group of digits of a shift's name, as a whole number: POSA-OS-26-0000003 is "3"."""
	groups = re.findall(r"\d+", shift or "")
	return str(int(groups[-1])) if groups else None


def counter_of(number):
	"""The counter at the end of a local number, or None."""
	tail = (number or "").rsplit("-", 1)[-1]
	return int(tail) if tail.isdigit() else None


def get_series(doctype, is_return=False, values=None):
	"""The naming series ERPNext names a new invoice of this kind by, unparsed.

	As frappe.model.naming.set_new_name does: a Document Naming Rule whose conditions the
	invoice meets comes first, by priority, and gives its prefix. Otherwise the naming_series
	of a new document, which is the default Document Naming Settings sets, or the first
	series of the doctype. ERPNext 16 gives a return no series of its own: make_sales_return
	does not copy naming_series (no_copy), so a return takes the same default as a sale.

	Args:
		doctype: Sales Invoice or POS Invoice
		is_return: For a return
		values: What else is known of the invoice, for the conditions of a naming rule
	"""
	from frappe.model.naming import get_default_naming_series

	probe = frappe.new_doc(doctype)
	probe.update({**(values or {}), "is_pos": 1, "is_return": 1 if is_return else 0})

	rules = frappe.cache_manager.get_doctype_map(
		"Document Naming Rule",
		doctype,
		filters={"document_type": doctype, "disabled": 0},
		order_by="priority desc",
	)
	for row in rules:
		rule = frappe.get_cached_doc("Document Naming Rule", row.name)
		if _rule_matches(rule, probe):
			return rule.prefix

	return probe.get("naming_series") or get_default_naming_series(doctype)


def _return_option(doctype, sale_series):
	"""The doctype's own series for returns, such as ACC-SINV-RET-.YYYY.- beside ACC-SINV-.YYYY.-.

	ERPNext names a return by the sale's series, so a sale and a return of a shift would
	share local numbers. ERPNext ships a RET series as an option, chosen only by hand; the
	local number takes it, so a return reads as one: LACC-SINV-RET-2026-3-00001.
	"""
	field = frappe.get_meta(doctype).get_field("naming_series")
	options = [option.strip() for option in (field.options or "").split("\n")] if field else []
	for option in options:
		if option != sale_series and "RET" in option and option.replace("RET-", "", 1) == sale_series:
			return option
	return None


def _rule_matches(rule, doc):
	from frappe.utils.data import evaluate_filters

	if not rule.conditions:
		return True
	return evaluate_filters(
		doc, [(rule.document_type, d.field, d.condition, d.value) for d in rule.conditions]
	)


def next_counters(shift):
	"""1 + the highest counter used in a shift, for sales and for returns apart.

	Counts the invoices of the shift, drafts and cancelled ones too, since their numbers were
	given, and the queue records of the shift that have no invoice yet. A record whose payload
	is gone cannot say which kind it was, so it counts for both: a number is skipped, never
	given twice.

	Args:
		shift: POS Opening Shift name
	"""
	highest = {"sale": 0, "return": 0}

	def note(number, kind):
		counter = counter_of(number)
		if counter is None:
			return
		for key in (kind,) if kind else highest:
			highest[key] = max(highest[key], counter)

	for doctype in INVOICE_DOCTYPES:
		for row in frappe.get_all(
			doctype,
			filters={"posa_pos_opening_shift": shift, FIELD: ["is", "set"]},
			fields=[FIELD, "is_return"],
		):
			note(row[FIELD], "return" if row.is_return else "sale")

	for row in frappe.get_all(
		SYNC_DOCTYPE,
		filters={"shift": shift, FIELD: ["is", "set"], "sales_invoice": ["is", "not set"]},
		fields=[FIELD, "payload"],
	):
		note(row[FIELD], _kind_of_payload(row.payload))

	return {kind: counter + 1 for kind, counter in highest.items()}


def _kind_of_payload(payload):
	try:
		data = json.loads(payload) if payload else None
	except ValueError:
		data = None
	if not isinstance(data, dict):
		return None
	return "return" if data.get("is_return") else "sale"


def get_local_numbering(pos_profile, shift):
	"""What a device needs to number the invoices of a shift.

	Args:
		pos_profile: POS Profile document or name
		shift: POS Opening Shift name, or None

	Returns:
		dict: sale_series, return_series, shift_number, and next: the counters to go on from
	"""
	if isinstance(pos_profile, str):
		pos_profile = frappe.get_cached_doc("POS Profile", pos_profile)

	invoice_type = frappe.db.get_value("POS Settings", {"pos_profile": pos_profile.name}, "invoice_type")
	doctype = "POS Invoice" if invoice_type == "POS Invoice" else "Sales Invoice"
	values = {
		"company": pos_profile.company,
		"pos_profile": pos_profile.name,
		"customer": pos_profile.get("customer"),
		"currency": pos_profile.get("currency"),
		"selling_price_list": pos_profile.get("selling_price_list"),
		"set_warehouse": pos_profile.get("warehouse"),
		"update_stock": 1,
		"posa_pos_opening_shift": shift,
	}
	sale_series = get_series(doctype, False, values)
	return_series = get_series(doctype, True, values)
	if return_series == sale_series:
		return_series = _return_option(doctype, sale_series) or return_series

	return {
		"sale_series": sale_series,
		"return_series": return_series,
		"shift_number": shift_number(shift) if shift else None,
		"next": next_counters(shift) if shift else {"sale": 1, "return": 1},
	}


def get_local_numbering_safely(pos_profile, shift):
	"""get_local_numbering for a response that must not fail because of it."""
	try:
		return get_local_numbering(pos_profile, shift)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "Local Numbering Error")
		return None


# ---------------------------------------------------------------------------
# Finding an invoice by either number
# ---------------------------------------------------------------------------


def find_by_local_number(number, doctypes=INVOICE_DOCTYPES):
	"""The invoice a local number was given to: (doctype, name), or None.

	The number is not unique. When returns take the series of sales, as ERPNext's default
	does, the first sale and the first return of a shift carry the same number, and a
	cashier who types it means the sale. So a submitted invoice comes first, then a sale
	before a return, then the newest.
	"""
	if not number or not isinstance(number, str):
		return None

	found = []
	for doctype in doctypes:
		for row in frappe.get_all(
			doctype, filters={FIELD: number}, fields=["name", "docstatus", "is_return", "creation"], limit=20
		):
			found.append(((row.docstatus == 1, not row.is_return, row.creation), doctype, row.name))
	if not found:
		return None
	_rank, doctype, name = max(found, key=lambda entry: entry[0])
	return doctype, name


def resolve_invoice_name(value, doctypes=INVOICE_DOCTYPES):
	"""The server name of the invoice a cashier typed, by its name or its local number.

	Returns the value as it came when it names an invoice, or names none: the caller then
	says the invoice does not exist, as before.
	"""
	if not value or not isinstance(value, str):
		return value
	if any(frappe.db.exists(doctype, value) for doctype in doctypes):
		return value
	found = find_by_local_number(value, doctypes)
	return found[1] if found else value
