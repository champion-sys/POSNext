import base64
import io
import json

import frappe
from frappe import _
from frappe.utils import cint, now_datetime


ALLOWED_INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")
ALLOWED_PAPER_SIZES = ("58", "80")


def _json_loads(value, fallback=None):
    if fallback is None:
        fallback = {}

    if not value:
        return fallback

    if isinstance(value, (dict, list)):
        return value

    try:
        return json.loads(value)
    except Exception:
        return fallback


def _json_dumps(value):
    if isinstance(value, str):
        return value

    return json.dumps(value, ensure_ascii=False, indent=2)


def _normalize_paper_size(paper_size):
    paper_size = str(paper_size or "80").replace("mm", "").strip()

    if paper_size not in ALLOWED_PAPER_SIZES:
        frappe.throw(_("Paper Size must be either 58 or 80"))

    return paper_size


def _normalize_invoice_doctype(invoice_doctype):
    if invoice_doctype in ALLOWED_INVOICE_DOCTYPES:
        return invoice_doctype

    frappe.throw(_("Invalid Invoice DocType"))


def _get_pos_settings_doc(pos_settings):
    if not pos_settings:
        frappe.throw(_("POS Settings is required"))

    if not frappe.db.exists("POS Settings", pos_settings):
        frappe.throw(_("POS Settings {0} does not exist").format(pos_settings))

    return frappe.get_doc("POS Settings", pos_settings)


def _get_invoice_doctype_from_pos_settings(pos_settings):
    _get_pos_settings_doc(pos_settings)

    meta = frappe.get_meta("POS Settings")
    invoice_type = None

    if meta.has_field("invoice_type"):
        invoice_type = frappe.db.get_value("POS Settings", pos_settings, "invoice_type")

    if invoice_type in ALLOWED_INVOICE_DOCTYPES:
        return invoice_type

    return "POS Invoice"


def _has_pos_settings_access(pos_settings, permission_type="read"):
    if frappe.has_permission("POS Settings", ptype=permission_type):
        return True

    pos_profile = frappe.db.get_value("POS Settings", pos_settings, "pos_profile")

    if not pos_profile:
        return False

    return bool(
        frappe.db.exists(
            "POS Profile User",
            {
                "parent": pos_profile,
                "user": frappe.session.user,
            },
        )
    )


def _ensure_pos_settings_access(pos_settings, permission_type="read"):
    if not _has_pos_settings_access(pos_settings, permission_type):
        frappe.throw(_("You do not have access to this POS Settings"))


def _get_template_doc(template):
    if not template:
        frappe.throw(_("Template is required"))

    if not frappe.db.exists("POS Thermal Print Template", template):
        frappe.throw(_("Template {0} does not exist").format(template))

    return frappe.get_doc("POS Thermal Print Template", template)


def _get_print_format_name(template_name):
    return "POS Thermal - {0}".format(template_name)


def _generate_or_update_print_format(doc):
    if not doc.generated_html:
        frappe.throw(_("Generated HTML is empty"))

    # Restrict Print Format creation/saving to users with rights to modify Print Format
    if not frappe.has_permission("Print Format", ptype="write"):
        frappe.throw(_("You do not have permission to generate or update Print Formats"))

    print_format_name = doc.print_format or _get_print_format_name(doc.template_name)

    if frappe.db.exists("Print Format", print_format_name):
        print_format = frappe.get_doc("Print Format", print_format_name)
        print_format.doc_type = doc.invoice_doctype
        print_format.print_format_type = "Jinja"
        print_format.custom_format = 1
        print_format.disabled = 0
        print_format.html = doc.generated_html

        if frappe.get_meta("Print Format").has_field("print_format_name"):
            print_format.print_format_name = print_format_name

        print_format.save(ignore_permissions=True)
    else:
        print_format = frappe.new_doc("Print Format")
        print_format.name = print_format_name

        if frappe.get_meta("Print Format").has_field("print_format_name"):
            print_format.print_format_name = print_format_name

        if frappe.get_meta("Print Format").has_field("module"):
            print_format.module = "POS Next"

        print_format.doc_type = doc.invoice_doctype
        print_format.print_format_type = "Jinja"
        print_format.custom_format = 1
        print_format.disabled = 0
        print_format.html = doc.generated_html
        print_format.insert(ignore_permissions=True)

    return print_format


@frappe.whitelist()
def get_pos_settings_list():
    filters = {"enabled": 1}

    if not frappe.has_permission("POS Settings", ptype="read"):
        user_profiles = frappe.get_all(
            "POS Profile User",
            filters={"user": frappe.session.user},
            pluck="parent",
        )

        if not user_profiles:
            return []

        filters["pos_profile"] = ["in", user_profiles]

    records = frappe.get_all(
        "POS Settings",
        filters=filters,
        fields=[
            "name",
            "pos_profile",
            "enabled",
            "modified",
        ],
        order_by="modified desc",
    )

    for row in records:
        row["invoice_doctype"] = _get_invoice_doctype_from_pos_settings(row.name)

    return records


@frappe.whitelist()
def get_pos_settings_context(pos_settings):
    _get_pos_settings_doc(pos_settings)
    _ensure_pos_settings_access(pos_settings, "read")

    pos_profile = frappe.db.get_value("POS Settings", pos_settings, "pos_profile")
    invoice_doctype = _get_invoice_doctype_from_pos_settings(pos_settings)

    return {
        "pos_settings": pos_settings,
        "pos_profile": pos_profile,
        "invoice_doctype": invoice_doctype,
    }


def _system_invoice_fields():
    return [
        {
            "fieldname": "name",
            "label": "Invoice Number",
            "fieldtype": "Data",
            "options": None,
            "is_custom": 0,
            "is_system": 1,
            "hidden": 0,
        },
        {
            "fieldname": "owner",
            "label": "Owner",
            "fieldtype": "Data",
            "options": None,
            "is_custom": 0,
            "is_system": 1,
            "hidden": 0,
        },
        {
            "fieldname": "creation",
            "label": "Created On",
            "fieldtype": "Datetime",
            "options": None,
            "is_custom": 0,
            "is_system": 1,
            "hidden": 0,
        },
        {
            "fieldname": "modified",
            "label": "Last Modified On",
            "fieldtype": "Datetime",
            "options": None,
            "is_custom": 0,
            "is_system": 1,
            "hidden": 0,
        },
        {
            "fieldname": "docstatus",
            "label": "Document Status",
            "fieldtype": "Int",
            "options": None,
            "is_custom": 0,
            "is_system": 1,
            "hidden": 0,
        },
    ]


@frappe.whitelist()
def get_invoice_doctype_fields(invoice_doctype):
    invoice_doctype = _normalize_invoice_doctype(invoice_doctype)
    meta = frappe.get_meta(invoice_doctype)

    custom_fieldnames = set(
        frappe.get_all(
            "Custom Field",
            filters={"dt": invoice_doctype},
            pluck="fieldname",
        )
    )

    excluded_fieldtypes = {
        "Section Break",
        "Column Break",
        "Tab Break",
        "HTML",
        "Button",
        "Fold",
    }

    fields = []
    table_fields = []
    seen_fields = set()

    for field in _system_invoice_fields():
        fields.append(field)
        seen_fields.add(field["fieldname"])

    for df in meta.fields:
        if not df.fieldname:
            continue

        is_custom = 1 if df.fieldname in custom_fieldnames else 0

        if df.fieldtype in ("Table", "Table MultiSelect"):
            table_fields.append(
                {
                    "fieldname": df.fieldname,
                    "label": df.label or df.fieldname,
                    "fieldtype": df.fieldtype,
                    "options": df.options,
                    "is_custom": is_custom,
                    "is_system": 0,
                    "hidden": cint(df.hidden),
                    "idx": cint(df.idx),
                }
            )
            continue

        if df.fieldtype in excluded_fieldtypes:
            continue

        if df.fieldname in seen_fields:
            continue

        fields.append(
            {
                "fieldname": df.fieldname,
                "label": df.label or df.fieldname,
                "fieldtype": df.fieldtype,
                "options": df.options,
                "is_custom": is_custom,
                "is_system": 0,
                "hidden": cint(df.hidden),
                "idx": cint(df.idx),
            }
        )
        seen_fields.add(df.fieldname)

    return {
        "doctype": invoice_doctype,
        "fields": fields,
        "table_fields": table_fields,
    }

@frappe.whitelist()
def get_child_table_fields(child_doctype):
    if not child_doctype:
        frappe.throw(_("Child DocType is required"))

    meta = frappe.get_meta(child_doctype)

    custom_fieldnames = set(
        frappe.get_all(
            "Custom Field",
            filters={"dt": child_doctype},
            pluck="fieldname",
        )
    )

    excluded_fieldtypes = {
        "Section Break",
        "Column Break",
        "Tab Break",
        "HTML",
        "Button",
        "Fold",
        "Table",
        "Table MultiSelect",
    }

    fields = []

    for df in meta.fields:
        if not df.fieldname or df.fieldtype in excluded_fieldtypes:
            continue

        fields.append(
            {
                "fieldname": df.fieldname,
                "label": df.label or df.fieldname,
                "fieldtype": df.fieldtype,
                "options": df.options,
                "is_custom": 1 if df.fieldname in custom_fieldnames else 0,
                "is_system": 0,
                "hidden": cint(df.hidden),
                "idx": cint(df.idx),
            }
        )

    return {
        "doctype": child_doctype,
        "fields": fields,
    }

@frappe.whitelist()
def list_templates(pos_settings, invoice_doctype=None):
    _get_pos_settings_doc(pos_settings)
    _ensure_pos_settings_access(pos_settings, "read")

    if not invoice_doctype:
        invoice_doctype = _get_invoice_doctype_from_pos_settings(pos_settings)

    invoice_doctype = _normalize_invoice_doctype(invoice_doctype)

    templates = frappe.get_all(
        "POS Thermal Print Template",
        filters={
            "pos_settings": pos_settings,
            "invoice_doctype": invoice_doctype,
            "disabled": 0,
        },
        fields=[
            "name",
            "template_name",
            "paper_size",
            "is_default",
            "print_format",
            "modified",
        ],
        order_by="is_default desc, modified desc",
    )

    return templates


@frappe.whitelist()
def get_template(template):
    doc = _get_template_doc(template)
    _ensure_pos_settings_access(doc.pos_settings, "read")

    return {
        "name": doc.name,
        "template_name": doc.template_name,
        "pos_settings": doc.pos_settings,
        "invoice_doctype": doc.invoice_doctype,
        "paper_size": str(doc.paper_size or "80"),
        "is_default": cint(doc.is_default),
        "disabled": cint(doc.disabled),
        "layout_json": _json_loads(doc.layout_json, fallback={"elements": []}),
        "generated_html": doc.generated_html or "",
        "generated_css": doc.generated_css or "",
        "print_format": doc.print_format,
        "version": doc.version,
        "remarks": doc.remarks,
    }


@frappe.whitelist()
def save_template(
    pos_settings,
    template_name,
    paper_size,
    layout_json,
    generated_html=None,
    generated_css=None,
    template=None,
    is_default=0,
    disabled=0,
    remarks=None,
):
    _get_pos_settings_doc(pos_settings)
    _ensure_pos_settings_access(pos_settings, "write")

    template_name = str(template_name or "").strip()

    if not template_name:
        frappe.throw(_("Template Name is required"))

    paper_size = _normalize_paper_size(paper_size)
    invoice_doctype = _get_invoice_doctype_from_pos_settings(pos_settings)
    layout_json_string = _json_dumps(layout_json)

    try:
        loaded_layout = json.loads(layout_json_string)
    except Exception:
        frappe.throw(_("Layout JSON is not valid"))

    if not isinstance(loaded_layout, dict):
        frappe.throw(_("Layout JSON must be a JSON object"))

    if template:
        doc = _get_template_doc(template)
        _ensure_pos_settings_access(doc.pos_settings, "write")

        if doc.name != template_name:
            if frappe.db.exists("POS Thermal Print Template", template_name):
                frappe.throw(_("Template {0} already exists").format(template_name))
            frappe.rename_doc("POS Thermal Print Template", doc.name, template_name)
            doc = frappe.get_doc("POS Thermal Print Template", template_name)

        if doc.pos_settings != pos_settings:
            frappe.throw(_("Template does not belong to the selected POS Settings"))

        doc.paper_size = paper_size
        doc.invoice_doctype = invoice_doctype
        doc.layout_json = layout_json_string
        doc.generated_html = generated_html or ""
        doc.generated_css = generated_css or ""
        doc.is_default = cint(is_default)
        doc.disabled = cint(disabled)
        doc.remarks = remarks
        doc.version = cint(doc.version or 1) + 1
        doc.save()
    else:
        if frappe.db.exists("POS Thermal Print Template", template_name):
            frappe.throw(_("Template {0} already exists").format(template_name))

        doc = frappe.new_doc("POS Thermal Print Template")
        doc.template_name = template_name
        doc.pos_settings = pos_settings
        doc.invoice_doctype = invoice_doctype
        doc.paper_size = paper_size
        doc.layout_json = layout_json_string
        doc.generated_html = generated_html or ""
        doc.generated_css = generated_css or ""
        doc.is_default = cint(is_default)
        doc.disabled = cint(disabled)
        doc.remarks = remarks
        doc.version = 1
        doc.insert()

    return {
        "name": doc.name,
        "template_name": doc.template_name,
        "pos_settings": doc.pos_settings,
        "invoice_doctype": doc.invoice_doctype,
        "paper_size": doc.paper_size,
        "is_default": cint(doc.is_default),
        "disabled": cint(doc.disabled),
        "version": doc.version,
    }


@frappe.whitelist()
def duplicate_template(template, new_template_name=None):
    source = _get_template_doc(template)
    _ensure_pos_settings_access(source.pos_settings, "write")

    new_template_name = str(new_template_name or "").strip()

    if not new_template_name:
        new_template_name = "{0} Copy".format(source.template_name)

    if frappe.db.exists("POS Thermal Print Template", new_template_name):
        frappe.throw(_("Template {0} already exists").format(new_template_name))

    doc = frappe.copy_doc(source)
    doc.template_name = new_template_name
    doc.is_default = 0
    doc.print_format = None
    doc.last_generated_on = None
    doc.version = 1
    doc.insert()

    return {
        "name": doc.name,
        "template_name": doc.template_name,
    }


@frappe.whitelist()
def set_default_template(template):
    doc = _get_template_doc(template)
    _ensure_pos_settings_access(doc.pos_settings, "write")

    print_format = _generate_or_update_print_format(doc)

    doc.is_default = 1
    doc.disabled = 0
    doc.print_format = print_format.name
    doc.last_generated_on = now_datetime()
    doc.save(ignore_permissions=True)

    pos_profile = frappe.db.get_value("POS Settings", doc.pos_settings, "pos_profile")
    pos_profile_updated = 0

    if pos_profile and frappe.get_meta("POS Profile").has_field("print_format"):
        frappe.db.set_value(
            "POS Profile",
            pos_profile,
            "print_format",
            print_format.name,
            update_modified=True,
        )
        pos_profile_updated = 1

    return {
        "name": doc.name,
        "is_default": 1,
        "print_format": print_format.name,
        "pos_profile": pos_profile,
        "pos_profile_updated": pos_profile_updated,
    }


@frappe.whitelist()
def get_default_template(pos_settings, invoice_doctype=None):
    _get_pos_settings_doc(pos_settings)
    _ensure_pos_settings_access(pos_settings, "read")

    if not invoice_doctype:
        invoice_doctype = _get_invoice_doctype_from_pos_settings(pos_settings)

    invoice_doctype = _normalize_invoice_doctype(invoice_doctype)

    template = frappe.db.get_value(
        "POS Thermal Print Template",
        {
            "pos_settings": pos_settings,
            "invoice_doctype": invoice_doctype,
            "is_default": 1,
            "disabled": 0,
        },
        "name",
    )

    if not template:
        return None

    return get_template(template)


@frappe.whitelist()
def generate_print_format(template):
    doc = _get_template_doc(template)
    _ensure_pos_settings_access(doc.pos_settings, "write")

    print_format = _generate_or_update_print_format(doc)

    doc.print_format = print_format.name
    doc.last_generated_on = now_datetime()
    doc.save(ignore_permissions=True)

    return {
        "template": doc.name,
        "print_format": print_format.name,
        "invoice_doctype": doc.invoice_doctype,
    }


@frappe.whitelist()
def get_qr_data_uri(value, box_size=4, border=2):
    if not value:
        return ""

    try:
        import qrcode
    except ImportError:
        return ""

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=cint(box_size) or 4,
        border=cint(border) or 2,
    )

    qr.add_data(str(value))
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")

    buffer = io.BytesIO()
    img.save(buffer, format="PNG")

    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return "data:image/png;base64,{0}".format(encoded)


@frappe.whitelist()
def get_barcode_data_uri(value, barcode_type="code128"):
    if not value:
        return ""

    try:
        # pip install python-barcode
        import barcode
        from barcode.writer import ImageWriter
    except ImportError:
        return ""

    try:
        barcode_class = barcode.get_barcode_class(barcode_type)
    except barcode.errors.BarcodeNotFoundError:
        barcode_class = barcode.get_barcode_class("code128")

    # Disable text under barcode for cleaner receipt look
    options = {
        "write_text": False,
        "module_height": 8.0,
        "quiet_zone": 2.0
    }

    code = barcode_class(str(value), writer=ImageWriter())
    
    buffer = io.BytesIO()
    code.write(buffer, options=options)
    
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return "data:image/png;base64,{0}".format(encoded)