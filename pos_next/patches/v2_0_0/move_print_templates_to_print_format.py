# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""POS templates moved from the POS Print Template DocType to Frappe's Print Format.

Templates a site wrote there become Print Formats ticked for POS devices, POS Settings point at
them by their new names, and the old DocType goes.
"""

import frappe

OLD = "POS Print Template"
PAPER_SIZES = {"80mm": "Receipt 80 mm", "58mm": "Receipt 58 mm", "A4": "A4", "A5": "A5"}


def execute():
	from frappe.utils.fixtures import sync_fixtures

	from pos_next.print_templates import RENAMED

	# The Print Format fields come with the fixtures, which migrate syncs after the patches
	sync_fixtures("pos_next")

	renamed = dict(RENAMED)
	if frappe.db.table_exists(OLD):
		columns = set(frappe.db.get_table_columns(OLD))
		fields = [f for f in ("name", "paper", "html", "css", "copies", "enabled") if f in columns]
		for row in frappe.db.sql(
			f"select {', '.join(f'`{f}`' for f in fields)} from `tab{OLD}`", as_dict=True
		):
			if row.name in RENAMED:
				continue  # a shipped one: after_migrate makes it as a Print Format
			name = row.name
			# A Print Format of that name ticked for devices is this one, moved on an earlier run
			if frappe.db.exists("Print Format", name) and not frappe.db.get_value(
				"Print Format", name, "pos_next_offline"
			):
				name = f"{row.name} (POS)"
			if not frappe.db.exists("Print Format", name):
				frappe.get_doc(
					{
						"doctype": "Print Format",
						"name": name,
						"doc_type": "Sales Invoice",
						"module": "POS Next",
						"standard": "No",
						"custom_format": 1,
						"print_format_type": "Jinja",
						"pdf_generator": "chrome",
						"paper_size": PAPER_SIZES.get(row.get("paper")) or "Receipt 80 mm",
						"disabled": 0 if row.get("enabled", 1) else 1,
						"pos_next_offline": 1,
						"pos_next_copies": max(int(row.get("copies") or 1), 1),
						"html": row.get("html") or "",
						"css": row.get("css") or "",
					}
				).insert(ignore_permissions=True)
			renamed[row.name] = name

	for settings, template in frappe.get_all(
		"POS Settings",
		filters={"print_template": ["is", "set"]},
		fields=["name", "print_template"],
		as_list=True,
	):
		if template in renamed:
			frappe.db.set_value(
				"POS Settings", settings, "print_template", renamed[template], update_modified=False
			)

	if frappe.db.exists("DocType", OLD):
		frappe.delete_doc("DocType", OLD, force=True, ignore_missing=True)
	# Deleting the DocType keeps its table; every row in it is a Print Format now
	frappe.db.sql_ddl(f"drop table if exists `tab{OLD}`")
