# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import os

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

DOCTYPE = "POS Print Template"
PREVIEW_DOCTYPES = ("Sales Invoice", "POS Invoice")
DEFAULTS_FOLDER = os.path.join(os.path.dirname(__file__), "defaults")

#: Shipped with the app. Each is made once and is the site's to edit from then on.
DEFAULT_TEMPLATES = (
	{"template_name": "POS Receipt 80mm", "paper": "80mm", "html": "receipt.html", "css": "receipt_80mm.css"},
	{"template_name": "POS Receipt 58mm", "paper": "58mm", "html": "receipt.html", "css": "receipt_58mm.css"},
	{
		"template_name": "A4 Tax Invoice",
		"paper": "A4",
		"html": "a4_tax_invoice.html",
		"css": "a4_tax_invoice.css",
	},
)


def ensure_default_templates():
	"""Make the shipped templates a site lacks. Runs after install and after every migrate.

	One that exists is left as the site edited it, and one a manager deleted stays deleted.

	Returns:
		list[str]: The templates made on this run
	"""
	made = []
	for spec in DEFAULT_TEMPLATES:
		name = spec["template_name"]
		if frappe.db.exists(DOCTYPE, name) or frappe.db.exists(
			"Deleted Document", {"deleted_doctype": DOCTYPE, "deleted_name": name}
		):
			continue

		frappe.get_doc(
			{
				"doctype": DOCTYPE,
				"template_name": name,
				"paper": spec["paper"],
				"enabled": 1,
				"copies": 1,
				"html": _read_default(spec["html"]),
				"css": _read_default(spec["css"]),
				"notes": "Shipped with POS Next. Edit it freely: updates of the app never overwrite it.",
			}
		).insert(ignore_permissions=True)
		made.append(name)
	return made


def _read_default(filename):
	with open(os.path.join(DEFAULTS_FOLDER, filename), encoding="utf-8") as handle:
		return handle.read()


class POSPrintTemplate(Document):
	"""A receipt or invoice layout in HTML, CSS and Jinja.

	The POS device renders it with Nunjucks, so only a manager may write one: a template can
	run JavaScript on the device that prints it.
	"""

	def validate(self):
		self.template_name = (self.template_name or "").strip()
		if cint(self.copies) < 1:
			self.copies = 1
		if not self.preview_doctype:
			self.preview_doctype = "Sales Invoice"
		if self.preview_doctype not in PREVIEW_DOCTYPES:
			frappe.throw(
				_("Preview Invoice Type must be Sales Invoice or POS Invoice"),
				title=_("Invalid Preview Invoice"),
			)
