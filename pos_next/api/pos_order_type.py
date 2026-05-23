# -*- coding: utf-8 -*-

from __future__ import unicode_literals

import frappe
from frappe import _


def _get_enabled_order_type_rows():
	return frappe.get_list(
		"POS Order Type",
		filters={"disabled": 0},
		fields=["type_name", "has_tables"],
		order_by="type_name asc",
		limit_page_length=0,
	)


def _user_can_access_pos_profile(pos_profile: str) -> bool:
	# Same check used elsewhere in the app: explicit POS Profile User row OR standard permission.
	return bool(
		frappe.db.exists(
			"POS Profile User",
			{"parent": pos_profile, "user": frappe.session.user},
		)
		or frappe.has_permission("POS Profile", "read", pos_profile)
	)


@frappe.whitelist()
def get_order_types(pos_profile: str | None = None):
	"""Return enabled POS Order Types, optionally filtered by POS Profile allowed child table.

	If `pos_profile` is provided and the POS Profile has rows in the child table
	`allowed_pos_order_type` (child doctype: POS Order Type Detail), return only
	the allowed order types for that profile.

	Shape:
		[{"label": <type_name>, "value": <type_name>, "has_tables": 0/1}, ...]
	"""
	pos_profile = (pos_profile or "").strip() or None

	# Base enabled types
	enabled = _get_enabled_order_type_rows() or []
	enabled_by_name = {
		r.get("type_name"): r
		for r in enabled
		if r and r.get("type_name")
	}

	if not pos_profile:
		rows = enabled
	else:
		if not frappe.db.exists("POS Profile", pos_profile):
			frappe.throw(_("POS Profile {0} not found").format(pos_profile))

		if not _user_can_access_pos_profile(pos_profile):
			frappe.throw(_("You don't have access to this POS Profile"))

		# Pull allowed order types from POS Profile child table.
		# NOTE: `allowed_pos_order_type` is expected to be the parentfield.
		allowed_rows = frappe.get_all(
			"POS Order Type Detail",
			filters={
				"parenttype": "POS Profile",
				"parent": pos_profile,
				"parentfield": "allowed_pos_order_type",
			},
			fields=["pos_order_type", "is_default"],
			order_by="idx asc",
		)

		allowed_names = [r.get("pos_order_type") for r in (allowed_rows or []) if r.get("pos_order_type")]

		# If the profile isn't configured with allowed types yet, fall back to all enabled.
		if allowed_names:
			rows = [enabled_by_name.get(name) for name in allowed_names]
			rows = [r for r in rows if r]
		else:
			rows = enabled

	return [
		{
			"label": r.get("type_name"),
			"value": r.get("type_name"),
			"has_tables": int(r.get("has_tables") or 0),
			"is_default": int(next((ar.get("is_default") for ar in (allowed_rows or []) if ar.get("pos_order_type") == r.get("type_name")), 0)),
		}
		for r in rows
		if r and r.get("type_name")
	]
