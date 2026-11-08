# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""The Print Formats POS Next ships, and the site setup that lets a POS manager write them.

A POS template is a Frappe Print Format with "Print on POS Devices" ticked. The shipped ones are
made once on a site and are the site's to edit from then on: an app update never overwrites them.
"""

import os

import frappe

DEFAULTS_FOLDER = os.path.join(os.path.dirname(__file__), "defaults")
MANAGER_ROLE = "Nexus POS Manager"
MANAGER_RIGHTS = ("read", "write", "create", "delete", "print", "email", "report", "export", "share")

#: Shipped with the app, made once per site
DEFAULT_FORMATS = (
	{
		"name": "POS Next Receipt 80mm",
		"paper_size": "Receipt 80 mm",
		"html": "receipt.html",
		"css": "receipt_80mm.css",
		"margin": 0,
	},
	{
		"name": "POS Next Receipt 58mm",
		"paper_size": "Receipt 58 mm",
		"html": "receipt.html",
		"css": "receipt_58mm.css",
		"margin": 0,
	},
	{
		"name": "POS Next A4 Tax Invoice",
		"paper_size": "A4",
		"html": "a4_tax_invoice.html",
		"css": "a4_tax_invoice.css",
		"margin": 10,
	},
)

#: The formats of POS Print Template, the DocType these replaced, by their new names
RENAMED = {
	"POS Receipt 80mm": "POS Next Receipt 80mm",
	"POS Receipt 58mm": "POS Next Receipt 58mm",
	"A4 Tax Invoice": "POS Next A4 Tax Invoice",
}

#: Print Format shows Paper Size only for the chrome PDF generator; a POS template needs it too
PAPER_SIZE_DEPENDS_ON = "eval:doc.pos_next_offline || (!doc.print_format_builder_beta && !doc.raw_printing && doc.pdf_generator === 'chrome')"


def ensure_default_formats():
	"""Make the shipped formats a site lacks. One a manager edited or deleted stays as it is.

	Returns:
		list[str]: The formats made on this run
	"""
	made = []
	for spec in DEFAULT_FORMATS:
		name = spec["name"]
		if frappe.db.exists("Print Format", name) or frappe.db.exists(
			"Deleted Document", {"deleted_doctype": "Print Format", "deleted_name": name}
		):
			continue

		margin = spec["margin"]
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
				"paper_size": spec["paper_size"],
				"margin_top": margin,
				"margin_bottom": margin,
				"margin_left": margin,
				"margin_right": margin,
				"pos_next_offline": 1,
				"pos_next_copies": 1,
				"html": _read(spec["html"]),
				"css": _read(spec["css"]),
			}
		).insert(ignore_permissions=True)
		made.append(name)
	return made


def ensure_print_format_setup():
	"""Let a POS manager write Print Formats, and show Paper Size on a POS template."""
	from frappe.custom.doctype.property_setter.property_setter import make_property_setter
	from frappe.permissions import add_permission, update_permission_property

	if not frappe.db.exists("Role", MANAGER_ROLE):
		return

	if not frappe.db.exists(
		"Custom DocPerm", {"parent": "Print Format", "role": MANAGER_ROLE, "permlevel": 0}
	):
		# Copies Print Format's standard rules first, so System Manager keeps its rights
		add_permission("Print Format", MANAGER_ROLE, 0)
		for right in MANAGER_RIGHTS:
			update_permission_property("Print Format", MANAGER_ROLE, 0, right, 1, validate=False)
		frappe.clear_cache(doctype="Print Format")

	if (
		frappe.db.get_value(
			"Property Setter",
			{"doc_type": "Print Format", "field_name": "paper_size", "property": "depends_on"},
			"value",
		)
		!= PAPER_SIZE_DEPENDS_ON
	):
		make_property_setter(
			"Print Format",
			"paper_size",
			"depends_on",
			PAPER_SIZE_DEPENDS_ON,
			"Data",
			validate_fields_for_doctype=False,
		)


def _read(filename):
	with open(os.path.join(DEFAULTS_FOLDER, filename), encoding="utf-8") as handle:
		return handle.read()
