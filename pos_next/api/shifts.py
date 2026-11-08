# Copyright (c) 2024, POS Next and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.utils import get_datetime

from pos_next.api.utilities import get_wallet_payment_modes
from pos_next.services.sync_classifier import ShiftConflictError
from pos_next.services.sync_entities import has_pending_close


@frappe.whitelist()
def get_opening_dialog_data():
	"""Get data required for opening shift dialog"""
	data = {}

	# Get POS Profiles where current user is defined in POS Profile User table
	pos_profiles_data = frappe.db.sql(
		"""
		SELECT DISTINCT p.name, p.company, p.currency, p.warehouse, p.selling_price_list
		FROM `tabPOS Profile` p
		INNER JOIN `tabPOS Profile User` u ON u.parent = p.name
		WHERE p.disabled = 0 AND u.user = %s
		ORDER BY p.name
		""",
		frappe.session.user,
		as_dict=1,
	)

	data["pos_profiles_data"] = pos_profiles_data

	# Derive companies from accessible POS Profiles
	company_names = []
	for profile in pos_profiles_data:
		if profile.company and profile.company not in company_names:
			company_names.append(profile.company)
	data["companies"] = [{"name": c} for c in company_names]

	# Get payment methods for POS profiles (exclude wallet payment methods)
	pos_profiles_list = [p.name for p in pos_profiles_data]

	if pos_profiles_list:
		# Exclude wallet payment modes from opening balance
		wallet_modes = get_wallet_payment_modes()

		payment_filters = {"parent": ["in", pos_profiles_list]}
		if wallet_modes:
			payment_filters["mode_of_payment"] = ["not in", wallet_modes]

		data["payments_method"] = frappe.get_list(
			"POS Payment Method",
			filters=payment_filters,
			fields=["*"],
			limit_page_length=0,
			order_by="parent",
			ignore_permissions=True,
		)

		# Set currency from pos profile
		for mode in data["payments_method"]:
			mode["currency"] = frappe.get_cached_value("POS Profile", mode["parent"], "currency")
	else:
		data["payments_method"] = []

	return data


@frappe.whitelist()
def check_opening_shift(user=None):
	"""Check if user has an open shift"""
	if not user:
		user = frappe.session.user

	open_shifts = frappe.db.get_all(
		"POS Opening Shift",
		filters={
			"user": user,
			"pos_closing_shift": ["is", "not set"],
			"docstatus": 1,
			"status": "Open",
		},
		fields=["name", "pos_profile", "period_start_date"],
		order_by="period_start_date desc",
	)

	# Closed on a device and still finishing here: nothing more may be sold into it
	open_shifts = [shift for shift in open_shifts if not has_pending_close(shift["name"])]

	if not open_shifts:
		return None

	# Get the latest open shift
	shift_data = open_shifts[0]

	# It carries the POS Profile and the company, so a colleague's takes the access to close it
	if user != frappe.session.user:
		from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import assert_shift_access

		assert_shift_access(shift_data["name"])

	data = {}
	data["pos_opening_shift"] = frappe.get_doc("POS Opening Shift", shift_data["name"])
	data["pos_profile"] = frappe.get_doc("POS Profile", shift_data["pos_profile"])
	data["company"] = frappe.get_doc("Company", data["pos_profile"].company)
	# Include server timestamp so frontend can compute shift duration
	# without timezone mismatch (period_start_date is in server timezone)
	data["server_now"] = str(get_datetime())

	return data


@frappe.whitelist()
def create_opening_shift(pos_profile, company, balance_details):
	"""Create a new POS Opening Shift"""
	from pos_next.api.invoices import _assert_invoice_write_access

	# The closing rule without its role: a shift ties up the POS Profile for everyone on it, and
	# the answer carries the whole profile, while the role only says who may end a shift
	_assert_invoice_write_access("Sales Invoice", pos_profile)

	balance_details = json.loads(balance_details) if isinstance(balance_details, str) else balance_details

	new_pos_opening = insert_opening_shift(pos_profile, company, balance_details)

	data = {}
	data["pos_opening_shift"] = new_pos_opening.as_dict()
	data["pos_profile"] = frappe.get_doc("POS Profile", pos_profile)
	data["company"] = frappe.get_doc("Company", company)

	return data


def lock_profile_for_opening(pos_profile):
	"""Serialise the openings of shifts on a POS Profile, until this transaction ends.

	The lock alone is not enough: a plain read sees the snapshot the transaction began
	with, which a shift opened while it waited is not in. The check after it must be a
	locking read, as POSOpeningShift.validate_no_other_active_shift does.
	"""
	if not frappe.db.get_value("POS Profile", pos_profile, "name", for_update=True):
		frappe.throw(_("POS Profile {0} does not exist").format(pos_profile), frappe.DoesNotExistError)


def insert_opening_shift(pos_profile, company, balance_details, opened_at=None, offline_id=None):
	"""Open a shift for the session user. Submitting it creates what the POS Profile needs.

	Args:
		balance_details: Rows of mode_of_payment and opening_amount
		opened_at: When a shift opened on a device began. Defaults to now.
		offline_id: The queue record it came from, whose unique index stops a second copy

	Returns:
		Document: The submitted POS Opening Shift
	"""
	# Two openings at once would both find no shift and both open one
	lock_profile_for_opening(pos_profile)

	# Check if user already has an open shift
	existing_shift = check_opening_shift(frappe.session.user)
	if existing_shift:
		frappe.throw(
			_("You already have an open shift: {0}").format(existing_shift["pos_opening_shift"].name),
			ShiftConflictError,
		)

	opened_at = get_datetime(opened_at)
	new_pos_opening = frappe.get_doc(
		{
			"doctype": "POS Opening Shift",
			"period_start_date": opened_at,
			"posting_date": opened_at.date(),
			"posting_time": opened_at.time(),
			"user": frappe.session.user,
			"pos_profile": pos_profile,
			"company": company,
			"status": "Open",
			"offline_id": offline_id,
		}
	)

	# Add balance details - map opening_amount to amount
	formatted_balance_details = []
	for detail in balance_details:
		formatted_balance_details.append({
			"mode_of_payment": detail.get("mode_of_payment"),
			"amount": detail.get("opening_amount", 0)
		})

	new_pos_opening.set("balance_details", formatted_balance_details)
	new_pos_opening.insert(ignore_permissions=True)
	new_pos_opening.submit()
	return new_pos_opening


def assert_may_close_shift(opening_shift_doc, user=None):
	"""Refuse a user without the role the POS Profile requires for closing.

	Args:
		opening_shift_doc: POS Opening Shift document
		user: Defaults to the session user. A queued close passes the cashier who made it.
	"""
	pos_profile_name = opening_shift_doc.pos_profile
	if pos_profile_name:
		allowed_role = frappe.db.get_value("POS Profile", pos_profile_name, "role_allowed_to_closing_shift")
		if allowed_role and allowed_role not in frappe.get_roles(user or frappe.session.user):
			frappe.throw(
				_("You are not allowed to close this shift. Only users with role '{0}' can close it.").format(allowed_role),
				frappe.PermissionError
			)


@frappe.whitelist()
def get_closing_shift_data(opening_shift):
	"""Get data for closing shift"""
	from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import (
		assert_shift_access,
		build_closing_shift,
	)

	assert_shift_access(opening_shift)
	opening_shift_doc = frappe.get_doc("POS Opening Shift", opening_shift)

	try:
		# Convert to dict with proper datetime serialization
		opening_shift_dict = opening_shift_doc.as_dict()
		opening_shift_json = json.dumps(opening_shift_dict, default=str)

		# Create closing shift from opening shift (returns a dict)
		closing_data = build_closing_shift(opening_shift_json)

		# Ensure datetime values are JSON serializable
		return json.loads(json.dumps(closing_data, default=str))
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), "Get Closing Shift Data Error")
		frappe.throw(_("Error getting closing shift data: {0}").format(str(e)))


@frappe.whitelist()
def submit_closing_shift(closing_shift):
	"""Submit closing shift"""
	from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import (
		submit_closing_shift as submit_shift,
	)

	try:
		# closing_shift is already a JSON string from frontend
		# If it's a dict, convert to JSON string
		if isinstance(closing_shift, dict):
			closing_shift = json.dumps(closing_shift)

		result = submit_shift(closing_shift)
		return {"name": result, "status": "success"}
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), "Submit Closing Shift Error")
		frappe.throw(_("Error submitting closing shift: {0}").format(str(e)))
