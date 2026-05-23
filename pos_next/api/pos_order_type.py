# -*- coding: utf-8 -*-

from __future__ import unicode_literals

import frappe


@frappe.whitelist()
def get_order_types():
	"""Return enabled POS Order Types.

	Shape:
		[{"label": <type_name>, "value": <type_name>, "has_tables": 0/1}, ...]
	"""
	rows = frappe.get_list(
		"POS Order Type",
		filters={"disabled": 0},
		fields=["type_name", "has_tables"],
		order_by="type_name asc",
		limit_page_length=0,
	)

	return [
		{
			"label": r.get("type_name"),
			"value": r.get("type_name"),
			"has_tables": int(r.get("has_tables") or 0),
		}
		for r in (rows or [])
		if r.get("type_name")
	]
