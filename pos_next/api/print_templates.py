# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Print templates the POS device renders itself.

A manager writes a POS Print Template in Desk with HTML, CSS and Jinja. The device renders it
with Nunjucks, so it prints offline. This module hands the device what it needs for that: the
templates, the company with its logo embedded, and the POS Profile. Desk preview and online
reprints read one invoice's full context from here too.
"""

import base64
import mimetypes
import os
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import cint, cstr, get_datetime

from pos_next.api.sync_pull import _assert_profile_access

TEMPLATE_DOCTYPE = "POS Print Template"
INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")
TEMPLATE_FIELDS = ("name", "template_name", "paper", "html", "css", "copies", "modified")

#: The logo travels in the bootstrap and sits on every device, so a big one is left out
LOGO_MAX_BYTES = 300 * 1024

ADDRESS_FIELDS = ("address_line1", "address_line2", "city", "county", "state", "pincode", "country")


def _log(message):
	"""Tell the site why receipts print without the logo: one Error Log a day, not one per bootstrap."""
	frappe.logger("pos_next.print_templates").warning(message)

	key = f"pos_next:print_logo_logged:{message}"
	try:
		if frappe.cache.get_value(key):
			return
		frappe.cache.set_value(key, 1, expires_in_sec=24 * 60 * 60)
		frappe.log_error(title="POS print logo left out", message=message)
	except Exception:
		pass


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@frappe.whitelist()
def get_print_bundle(pos_profile, since=None):
	"""Everything the device needs to render receipts for a POS Profile offline.

	Args:
		pos_profile: The POS Profile the device sells on
		since: The `modified` of the bundle the device already holds. When nothing changed
			after it, only {"unchanged": True, "modified": ...} comes back.

	Returns:
		dict: templates, default_template, company, pos_profile, modified
	"""
	_assert_profile_access(pos_profile)
	profile = frappe.get_doc("POS Profile", pos_profile)
	return build_print_bundle(profile, since=since)


@frappe.whitelist()
def get_print_context(invoice, doctype="Sales Invoice"):
	"""The context a template renders one invoice with: what the device builds for a sale.

	Desk preview uses it, and the device can use it to reprint online.
	"""
	if doctype not in INVOICE_DOCTYPES:
		frappe.throw(_("Document type {0} is not allowed here").format(doctype), frappe.PermissionError)

	if not invoice or not frappe.db.exists(doctype, invoice):
		frappe.throw(_("Invoice {0} does not exist").format(invoice or "-"), frappe.DoesNotExistError)

	doc = frappe.get_doc(doctype, invoice)
	if not frappe.has_permission(doctype, "read", doc=doc):
		frappe.throw(_("You don't have permission to view this invoice"), frappe.PermissionError)
	if doc.get("pos_profile"):
		_assert_profile_access(doc.pos_profile)

	profile = frappe.get_doc("POS Profile", doc.pos_profile) if doc.get("pos_profile") else None
	letter_head = doc.get("letter_head") or (profile and profile.get("letter_head"))

	return {
		"doc": _invoice_dict(doc),
		"company": _company_info(doc.company, letter_head),
		"pos_profile": _profile_info(profile) if profile else None,
		"cashier": _cashier_info(doc.owner),
		"customer": _customer_info(doc),
	}


@frappe.whitelist()
def get_preview_invoice(doctype="Sales Invoice"):
	"""The latest submitted POS invoice the user may read and print, for Desk preview. None if none."""
	if doctype not in INVOICE_DOCTYPES:
		frappe.throw(_("Document type {0} is not allowed here").format(doctype), frappe.PermissionError)

	filters = {"docstatus": 1}
	if doctype == "Sales Invoice":
		filters["is_pos"] = 1
	if not frappe.has_permission("POS Profile", "write"):
		profiles = frappe.get_all("POS Profile User", filters={"user": frappe.session.user}, pluck="parent")
		if not profiles:
			return None
		filters["pos_profile"] = ["in", profiles]

	rows = frappe.get_list(
		doctype, filters=filters, pluck="name", order_by="creation desc", limit_page_length=1
	)
	return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------


def has_print_templates(pos_profile_name):
	"""Whether a POS Profile has anything to print with. Bootstrap skips the bundle otherwise."""
	if frappe.db.get_value("POS Settings", {"pos_profile": pos_profile_name, "enabled": 1}, "print_template"):
		return True
	return bool(frappe.db.exists(TEMPLATE_DOCTYPE, {"enabled": 1}))


def build_print_bundle(profile, since=None):
	"""The bundle for a POS Profile document. The caller has checked the user's access."""
	settings = (
		frappe.db.get_value(
			"POS Settings",
			{"pos_profile": profile.name, "enabled": 1},
			["print_template", "modified"],
			as_dict=True,
		)
		or frappe._dict()
	)

	company_name = profile.company
	company_modified = frappe.db.get_value("Company", company_name, "modified")
	address_name = _company_address_name(company_name)
	letter_head = profile.get("letter_head")

	modified = _latest(
		_templates_changed_at(),
		company_modified,
		address_name and frappe.db.get_value("Address", address_name, "modified"),
		profile.modified,
		settings.get("modified"),
		letter_head and frappe.db.get_value("Letter Head", letter_head, "modified"),
	)

	if since and modified and get_datetime(since) >= get_datetime(modified):
		return {"unchanged": True, "modified": modified}

	templates = frappe.get_all(
		TEMPLATE_DOCTYPE,
		filters={"enabled": 1},
		fields=list(TEMPLATE_FIELDS),
		order_by="template_name asc",
	)
	for template in templates:
		template["copies"] = max(cint(template.get("copies")), 1)
		template["modified"] = cstr(template["modified"])

	enabled = {template["name"] for template in templates}
	default = settings.get("print_template")

	return {
		"templates": templates,
		"default_template": default if default in enabled else None,
		"company": _company_info(company_name, letter_head, address_name=address_name),
		"pos_profile": _profile_info(profile),
		"modified": modified,
	}


def _templates_changed_at():
	"""Last change to any template, disabled and deleted ones included, so a device drops them."""
	changed = frappe.db.sql(f"select max(modified) from `tab{TEMPLATE_DOCTYPE}`")[0][0]
	deleted = frappe.db.sql(
		"select max(creation) from `tabDeleted Document` where deleted_doctype = %s", (TEMPLATE_DOCTYPE,)
	)[0][0]
	return _latest(changed, deleted)


def _latest(*stamps):
	stamps = [get_datetime(stamp) for stamp in stamps if stamp]
	return cstr(max(stamps)) if stamps else None


# ---------------------------------------------------------------------------
# Context parts
# ---------------------------------------------------------------------------


def _profile_info(profile):
	return {
		"name": profile.name,
		"company": profile.company,
		"warehouse": profile.warehouse,
		"currency": profile.currency,
		"letter_head": profile.get("letter_head"),
		"selling_price_list": profile.get("selling_price_list"),
		"customer": profile.get("customer"),
	}


def _company_info(company_name, letter_head=None, address_name=None):
	company = frappe.db.get_value(
		"Company",
		company_name,
		[
			"name",
			"company_name",
			"tax_id",
			"phone_no",
			"email",
			"website",
			"company_logo",
			"default_currency",
		],
		as_dict=True,
	)
	if not company:
		return None

	address_name = address_name or _company_address_name(company_name)
	logo_url = company.company_logo or (
		letter_head and frappe.db.get_value("Letter Head", letter_head, "image")
	)

	return {
		"name": company.name,
		"company_name": company.company_name,
		"address": _format_address(address_name),
		"tax_id": company.tax_id,
		"phone": company.phone_no,
		"email": company.email,
		"website": company.website,
		"logo": logo_data_uri(logo_url),
		"currency": company.default_currency,
	}


def _company_address_name(company_name):
	"""The company's primary address, else any address it has. No permission check: it prints."""
	rows = frappe.db.sql(
		"""
		select addr.name
		from `tabAddress` addr
		join `tabDynamic Link` dl on dl.parent = addr.name and dl.parenttype = 'Address'
		where dl.link_doctype = 'Company' and dl.link_name = %s and ifnull(addr.disabled, 0) = 0
		order by addr.is_primary_address desc, addr.creation asc
		limit 1
		""",
		(company_name,),
	)
	return rows[0][0] if rows else None


def _format_address(address_name):
	"""An address as plain lines: street lines, then city with state and postcode, then country."""
	if not address_name:
		return None

	address = frappe.db.get_value("Address", address_name, list(ADDRESS_FIELDS), as_dict=True)
	if not address:
		return None

	place = " ".join(part for part in (address.city, address.state, address.pincode) if part)
	lines = [address.address_line1, address.address_line2, address.county, place, address.country]
	return "\n".join(cstr(line).strip() for line in lines if cstr(line).strip()) or None


def _cashier_info(user):
	return {"user": user, "full_name": frappe.db.get_value("User", user, "full_name") or user}


def _customer_info(doc):
	if not doc.get("customer"):
		return None

	customer = frappe.db.get_value(
		"Customer",
		doc.customer,
		["name", "customer_name", "tax_id", "mobile_no", "customer_primary_address"],
		as_dict=True,
	) or frappe._dict(name=doc.customer)

	return {
		"name": doc.customer,
		"customer_name": doc.get("customer_name") or customer.customer_name or doc.customer,
		"tax_id": doc.get("tax_id") or customer.tax_id,
		"mobile_no": doc.get("contact_mobile") or customer.mobile_no,
		"address": _format_address(doc.get("customer_address") or customer.customer_primary_address),
	}


def _invoice_dict(doc):
	"""The invoice with its items, taxes and payments, its time as HH:MM:SS like the device has it."""
	data = doc.as_dict(convert_dates_to_str=True)
	posting_time = doc.get("posting_time")
	if isinstance(posting_time, timedelta):
		seconds = int(posting_time.total_seconds())
		data["posting_time"] = f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
	elif posting_time:
		data["posting_time"] = cstr(posting_time).split(".")[0]
	data["doctype"] = doc.doctype
	return data


# ---------------------------------------------------------------------------
# Logo
# ---------------------------------------------------------------------------


def logo_data_uri(file_url):
	"""A site file as a data: URI so it prints offline. None when it is missing, remote or too big."""
	if not file_url:
		return None

	path = _site_file_path(file_url)
	if not path or not os.path.isfile(path):
		_log(f"Print logo {file_url} is not a file of this site, so receipts print without it")
		return None

	mime = mimetypes.guess_type(path)[0]
	if not mime or not mime.startswith("image/"):
		_log(f"Print logo {file_url} is not an image, so receipts print without it")
		return None

	size = os.path.getsize(path)
	if size > LOGO_MAX_BYTES:
		_log(
			f"Print logo {file_url} is {size // 1024} KB, over the {LOGO_MAX_BYTES // 1024} KB a device "
			"keeps, so receipts print without it. Upload a smaller logo."
		)
		return None

	with open(path, "rb") as handle:
		encoded = base64.b64encode(handle.read()).decode()
	return f"data:{mime};base64,{encoded}"


def _site_file_path(file_url):
	"""Where a /files or /private/files URL lives on disk, refusing anything outside those folders."""
	url = cstr(file_url).split("?", 1)[0].split("#", 1)[0]
	if url.startswith("/private/files/"):
		folder = os.path.abspath(frappe.get_site_path("private", "files"))
		relative = url[len("/private/files/") :]
	elif url.startswith("/files/"):
		folder = os.path.abspath(frappe.get_site_path("public", "files"))
		relative = url[len("/files/") :]
	else:
		return None

	path = os.path.realpath(os.path.join(folder, relative))
	if not path.startswith(os.path.realpath(folder) + os.sep):
		return None
	return path
