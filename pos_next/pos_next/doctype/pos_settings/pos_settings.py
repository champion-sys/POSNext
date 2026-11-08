# Copyright (c) 2025, Youssef Restom and contributors
# For license information, please see license.txt

import frappe
from frappe.model import child_table_fields, default_fields, no_value_fields, numeric_fieldtypes, table_fields
from frappe.model.document import Document
from frappe.utils import cint, cstr, flt, validate_email_address

from pos_next.services.sync_alerts import split_recipients

#: One sends mail outside the company and the other erases records for good, so the POS is
#: not even shown them
SERVER_ONLY_FIELDS = ("sync_alert_recipients", "sync_payload_retention_days")

#: Kept up to date by the hourly job, never by a form
ALERT_STATE_FIELD = "sync_alert_last_sent_at"

#: What a cashier must not change. The doctype lets a cashier write and the POS saves with
#: ignore_permissions, so the only thing holding these is validate_who_may_change. It covers
#: what the server acts on, what holds a cashier back even if only the POS enforces it, and
#: what decides how a sale is priced or booked. test_every_field_is_classed keeps it complete.
MANAGER_ONLY_FIELDS = (
	*SERVER_ONLY_FIELDS,
	# Which POS Profile this is for, whether it applies, and who may reach it
	"pos_profile",
	"enabled",
	"role_allowed_to_access_settings_in_pos",
	# The offline permissions and limits
	"allow_delete_offline_invoice",
	"allow_offline_returns",
	"allow_offline_shift_close",
	"allow_offline_shift_open",
	"custom_allow_edit_offline_invoice",
	"custom_allow_print_offline_invoice",
	"custom_disable_offline_mode",
	"disable_offline_coupons",
	"max_offline_hours",
	"sync_total_tolerance",
	# Prices and discounts
	"allow_user_to_edit_additional_discount",
	"allow_user_to_edit_item_discount",
	"allow_user_to_edit_rate",
	"custom_show_coupon",
	"custom_show_offers",
	"fetch_coupon",
	"max_discount_allowed",
	# How a sale may be paid, returned or dated
	"allow_change_posting_date",
	"allow_credit_sale",
	"allow_customer_credit_payment",
	"allow_free_batch_return",
	"allow_negative_stock",
	"allow_partial_payment",
	"allow_return",
	"allow_return_without_invoice",
	"return_validity_days",
	"use_exact_amount",
	# Access to what other shifts did, and what a closing hides from the person counting
	"allow_print_draft_invoices",
	"allow_print_last_invoice",
	"allow_print_previous_invoices",
	"custom_allow_access_to_previous_invoices",
	"custom_hide_stock_quantity",
	"hide_expected_amount",
	# Locking the screen
	"enable_session_lock",
	"session_lock_timeout",
	# Other documents a sale may become
	"allow_customer_purchase_order",
	"allow_duplicate_customer_names",
	"allow_sales_order",
	"allow_select_sales_order",
	"allow_submissions_in_background_job",
	"create_only_sales_order",
	# Accounting, and what a sale adds up to
	"auto_create_wallet",
	"auto_set_delivery_charges",
	"barcode_rules",
	"closing_to_mode_of_payment",
	"decimal_precision",
	"default_loyalty_program",
	"enable_loyalty_program",
	"enable_sales_persons",
	"invoice_type",
	"loyalty_to_wallet",
	"post_change_gl_entries",
	"tax_inclusive",
	"use_delivery_charges",
	"wallet_account",
)


def _for_the_pos(settings):
	"""Drop what the POS has no use for. Its settings screen sends back all it was given."""
	for fieldname in (*SERVER_ONLY_FIELDS, ALERT_STATE_FIELD):
		settings.pop(fieldname, None)
	return settings


def _is_manager():
	from pos_next.api.sync import MANAGER_ROLES

	return bool(set(MANAGER_ROLES) & set(frappe.get_roles()))


def _comparable(doc, df):
	"""A value as it can be compared. A form holds a number as text, a database does not."""
	value = doc.get(df.fieldname)
	if df.fieldtype in table_fields:
		return [_comparable_row(row) for row in value or []]
	return flt(value) if df.fieldtype in numeric_fieldtypes else cstr(value)


def _comparable_row(row):
	return {
		fieldname: cstr(value)
		for fieldname, value in row.get_valid_dict().items()
		if fieldname not in (*default_fields, *child_table_fields)
	}


class POSSettings(Document):
	def validate(self):
		"""Validate POS Settings"""
		# Guard against None values and validate discount percentage
		max_discount = flt(self.max_discount_allowed)
		if max_discount < 0 or max_discount > 100:
			frappe.throw("Max Discount Allowed must be between 0 and 100")

		# Guard against None values and validate search limit
		if self.use_limit_search:
			search_limit = cint(self.search_limit)
			if search_limit <= 0:
				frappe.throw("Search Limit must be greater than 0")

		# Validate use_exact_amount cannot be enabled with credit sale or partial payment
		if cint(self.use_exact_amount):
			if cint(self.allow_credit_sale):
				frappe.throw(
					"'Use Exact Amount for Non-Cash' cannot be enabled together with 'Allow Credit Sale'. "
					"Please disable Credit Sale first."
				)
			if cint(self.allow_partial_payment):
				frappe.throw(
					"'Use Exact Amount for Non-Cash' cannot be enabled together with 'Allow Partial Payment'. "
					"Please disable Partial Payment first."
				)

		# Prevent changing Invoice Type if there are open shifts
		if self._doc_before_save and self.invoice_type != self._doc_before_save.invoice_type:
			open_shift = frappe.db.exists(
				"POS Opening Shift",
				{"pos_profile": self.pos_profile, "status": "Open"}
			)
			if open_shift:
				frappe.throw(
					frappe._("Cannot change Invoice Type because there is an active open POS shift ({0}) for POS Profile {1}.").format(
						open_shift, self.pos_profile
					)
				)

		self.validate_sync_housekeeping()
		self.validate_who_may_change()

	def validate_sync_housekeeping(self):
		before = self.get_doc_before_save()
		self.set(ALERT_STATE_FIELD, before.get(ALERT_STATE_FIELD) if before else None)

		for email in split_recipients(self.sync_alert_recipients):
			validate_email_address(email, throw=True)

	def validate_who_may_change(self):
		"""Hold a save to what it changes, not what it carries.

		The POS screen sends back everything it loaded, so an unchanged value is no attempt at
		anything. The POS hides its settings from everyone but managers and the role named
		here, and a request need not come from there, so that rule is enforced here too.
		"""
		before = self.get_doc_before_save()
		changed = self._get_changed_fields(before)
		if not changed or _is_manager():
			return

		protected = [df for df in changed if df.fieldname in MANAGER_ONLY_FIELDS]
		if protected:
			frappe.throw(
				frappe._("Only a POS manager can change: {0}").format(
					", ".join(frappe._(df.label) for df in protected)
				),
				frappe.PermissionError,
			)

		allowed_role = before.get("role_allowed_to_access_settings_in_pos") if before else None
		if allowed_role not in frappe.get_roles():
			frappe.throw(
				frappe._("Your role cannot change the POS Settings of {0}").format(self.pos_profile),
				frappe.PermissionError,
			)

	def _get_changed_fields(self, before):
		"""What this save changes. On a new record, what it sets away from the defaults."""
		fields = [df for df in self.meta.fields if df.fieldtype in table_fields or df.fieldtype not in no_value_fields]
		if not before:
			defaults = frappe._dict({df.fieldname: df.default for df in fields})
			# A new record has to say whose it is
			defaults.pos_profile = self.pos_profile
			before = defaults

		return [df for df in fields if _comparable(self, df) != _comparable(before, df)]

	# def on_update(self):
	# 	"""Sync allow_negative_stock with Stock Settings"""
	# 	self.sync_negative_stock_setting()

	def sync_negative_stock_setting(self):
		"""
		Synchronize allow_negative_stock with Stock Settings.

		When enabled in POS Settings, it enables the global Stock Settings.
		When disabled, it only disables global Stock Settings if no other
		POS Settings have it enabled.

		Note: Runs in the same transaction as the save, no manual commits.
		"""
		current_stock_setting = cint(
			frappe.db.get_single_value("Stock Settings", "allow_negative_stock") or 0
		)

		if cint(self.allow_negative_stock):
			# Enable Stock Settings if not already enabled
			if not current_stock_setting:
				frappe.db.set_single_value("Stock Settings", "allow_negative_stock", 1, update_modified=False)
				frappe.msgprint(
					"Stock Settings 'Allow Negative Stock' has been automatically enabled.",
					indicator="green",
					alert=True
				)
		else:
			# Only disable if no other enabled POS Settings have it enabled
			if current_stock_setting:
				# Use count for better performance and clarity
				other_enabled_count = frappe.db.count(
					"POS Settings",
					{
						"allow_negative_stock": 1,
						"enabled": 1,  # Only check enabled POS Settings
						"name": ["!=", self.name]
					}
				)

				if other_enabled_count == 0:
					frappe.db.set_single_value("Stock Settings", "allow_negative_stock", 0, update_modified=False)
					frappe.msgprint(
						"Stock Settings 'Allow Negative Stock' has been automatically disabled.",
						indicator="orange",
						alert=True
					)


@frappe.whitelist()
def get_pos_settings(pos_profile):
	"""
	Get POS Settings for a specific POS Profile.

	Also injects the current global Stock Settings value to show the actual
	source of truth, preventing confusion when the checkbox appears enabled
	but the global setting was changed elsewhere.
	"""
	from frappe import _

	if not pos_profile:
		return None

	# Check if user has access to this POS Profile
	has_access = frappe.db.exists(
		"POS Profile User",
		{"parent": pos_profile, "user": frappe.session.user}
	)

	if not has_access and not frappe.has_permission("POS Settings", "read"):
		frappe.throw(_("You don't have access to this POS Profile"))

	settings = frappe.db.get_value(
		"POS Settings",
		{"pos_profile": pos_profile},
		"*",
		as_dict=True
	)

	# If no settings exist, create default settings
	if not settings:
		settings = create_default_settings(pos_profile)

	# Inject the current global Stock Settings value for transparency
	# This helps UI reflect the actual state even if multiple POS Settings exist
	settings["_global_allow_negative_stock"] = cint(
		frappe.db.get_single_value("Stock Settings", "allow_negative_stock") or 0
	)

	# Tells the settings screen what its user may only look at
	settings["_manager_only_fields"] = [] if _is_manager() else list(MANAGER_ONLY_FIELDS)

	# The rounded total comes from the POS Profile, as bootstrap sends it
	from pos_next.services.sale_limits import get_rounding_settings

	settings.update(get_rounding_settings(pos_profile))

	return _for_the_pos(settings)


def create_default_settings(pos_profile):
	"""Create default POS Settings for a POS Profile"""
	doc = frappe.new_doc("POS Settings")
	doc.pos_profile = pos_profile
	doc.enabled = 1
	doc.insert()

	return doc.as_dict()


def _only_its_fields(settings):
	"""Keep what a settings screen may change. The record is the one named in the request.

	A name in the body would redirect the save to a POS Profile nobody checked. The screen
	sends modified too, which is how a save from a stale screen is refused.
	"""
	meta = frappe.get_meta("POS Settings")
	return {
		fieldname: value
		for fieldname, value in settings.items()
		if fieldname == "modified" or (fieldname != "pos_profile" and meta.has_field(fieldname))
	}


@frappe.whitelist()
def update_pos_settings(pos_profile, settings):
	"""Update POS Settings for a POS Profile"""
	import json

	from frappe import _

	if isinstance(settings, str):
		settings = json.loads(settings)
	settings = _only_its_fields(_for_the_pos(settings))

	# Check if user has access to this POS Profile
	has_access = frappe.db.exists(
		"POS Profile User",
		{"parent": pos_profile, "user": frappe.session.user}
	)

	# Every cashier can write the doctype, so that would say nothing about this POS Profile
	if not has_access and not frappe.has_permission("POS Profile", "write"):
		frappe.throw(_("You don't have permission to update this POS Profile"))

	# Check if settings exist
	existing = frappe.db.exists("POS Settings", {"pos_profile": pos_profile})

	if existing:
		doc = frappe.get_doc("POS Settings", existing)
		doc.update(settings)
		doc.save(ignore_permissions=True)
	else:
		doc = frappe.new_doc("POS Settings")
		doc.pos_profile = pos_profile
		doc.update(settings)
		doc.insert()

	return _for_the_pos(doc.as_dict())
