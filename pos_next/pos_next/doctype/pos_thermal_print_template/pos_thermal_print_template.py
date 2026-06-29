import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


ALLOWED_INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")
ALLOWED_PAPER_SIZES = ("58", "80")


class POSThermalPrintTemplate(Document):
    def validate(self):
        self.normalize_values()
        self.set_invoice_doctype_from_pos_settings()
        self.validate_template_name()
        self.validate_invoice_doctype()
        self.validate_paper_size()
        self.validate_layout_json()

    def before_save(self):
        if not self.version:
            self.version = 1

        if self.is_default:
            self.unset_other_default_templates()

    def normalize_values(self):
        if self.paper_size:
            self.paper_size = str(self.paper_size).replace("mm", "").strip()

        if self.template_name:
            self.template_name = self.template_name.strip()

    def set_invoice_doctype_from_pos_settings(self):
        if not self.pos_settings:
            return

        self.invoice_doctype = get_invoice_doctype_from_pos_settings(self.pos_settings)

    def validate_template_name(self):
        if not self.template_name:
            frappe.throw(_("Template Name is required"))

        if self.name and self.name != self.template_name and not self.is_new():
            frappe.throw(
                _("Template Name cannot be changed because it is used as the document name")
            )

    def validate_invoice_doctype(self):
        if self.invoice_doctype not in ALLOWED_INVOICE_DOCTYPES:
            frappe.throw(_("Invoice DocType must be either Sales Invoice or POS Invoice"))

    def validate_paper_size(self):
        if not self.paper_size:
            return

        if self.paper_size not in ALLOWED_PAPER_SIZES:
            frappe.throw(_("Paper Size must be either 58 or 80"))

    def validate_layout_json(self):
        if not self.layout_json:
            return

        try:
            layout = json.loads(self.layout_json)
        except Exception:
            frappe.throw(_("Layout JSON is not valid"))

        if not isinstance(layout, dict):
            frappe.throw(_("Layout JSON must be a JSON object"))

    def unset_other_default_templates(self):
        if not self.pos_settings or not self.invoice_doctype:
            return

        templates = frappe.get_all(
            "POS Thermal Print Template",
            filters={
                "pos_settings": self.pos_settings,
                "invoice_doctype": self.invoice_doctype,
                "name": ["!=", self.name],
                "is_default": 1,
            },
            pluck="name",
        )

        for template in templates:
            frappe.db.set_value(
                "POS Thermal Print Template",
                template,
                "is_default",
                0,
                update_modified=False,
            )

    def mark_generated(self, print_format=None):
        self.last_generated_on = now_datetime()

        if print_format:
            self.print_format = print_format

        self.save(ignore_permissions=True)


def get_invoice_doctype_from_pos_settings(pos_settings):
    if not pos_settings:
        frappe.throw(_("POS Settings is required"))

    if not frappe.db.exists("POS Settings", pos_settings):
        frappe.throw(_("POS Settings {0} does not exist").format(pos_settings))

    meta = frappe.get_meta("POS Settings")
    invoice_type = None

    if meta.has_field("invoice_type"):
        invoice_type = frappe.db.get_value("POS Settings", pos_settings, "invoice_type")

    if invoice_type in ALLOWED_INVOICE_DOCTYPES:
        return invoice_type

    return "POS Invoice"