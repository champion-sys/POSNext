# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import base64
import os
import re
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

import frappe

from pos_next import print_templates as shipped_formats
from pos_next.api import bootstrap, print_templates

PNG = base64.b64decode(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _raise(message, exc=frappe.ValidationError, **_kwargs):
	raise exc(message)


def keep_local(case, *names):
	"""Put back what the site runner had in frappe.local once the test ends."""
	for name in names:
		case.addCleanup(setattr, frappe.local, name, getattr(frappe.local, name, None))


def _matches(actual, wanted):
	if isinstance(wanted, list) and len(wanted) == 2 and wanted[0] == "in":
		return actual in wanted[1]
	return actual == wanted


class FakeDb:
	"""Rows by doctype, answering the reads these modules make."""

	def __init__(self, tables, company_address=None, deleted=None):
		self.tables = tables
		self.company_address = company_address
		self.deleted = deleted

	def rows(self, doctype, filters=None):
		table = self.tables.get(doctype, {})
		if isinstance(filters, str):
			return [table[filters]] if filters in table else []
		return [
			row
			for row in table.values()
			if all(_matches(row.get(key), value) for key, value in (filters or {}).items())
		]

	def get_value(self, doctype, filters, fields="name", as_dict=False, **_kwargs):
		rows = self.rows(doctype, filters)
		if not rows:
			return None
		if isinstance(fields, list | tuple):
			values = {field: rows[0].get(field) for field in fields}
			return frappe._dict(values) if as_dict else tuple(values.values())
		return rows[0].get(fields)

	def exists(self, doctype, filters=None):
		rows = self.rows(doctype, filters)
		return rows[0].get("name", True) if rows else None

	def sql(self, query, values=None, **_kwargs):
		if "tabDynamic Link" in query:
			return [[self.company_address]] if self.company_address else []
		if "Deleted Document" in query:
			return [[self.deleted]]
		if "max(modified)" in query:
			assert "tabPrint Format" in query and "doc_type in" in query, query
			stamps = [
				row["modified"]
				for row in self.tables.get("Print Format", {}).values()
				if row["doc_type"] in values[0]
			]
			return [[max(stamps) if stamps else None]]
		raise AssertionError(f"unexpected query {query}")


def _template(name, offline=1, modified="2026-11-01 10:00:00", **values):
	return {
		"name": name,
		"doc_type": "Sales Invoice",
		"pos_next_offline": offline,
		"disabled": 0,
		"custom_format": 1,
		"print_format_type": "Jinja",
		"paper_size": "Receipt 80 mm",
		"html": "<p>{{ doc.name }}</p>",
		"css": "p{}",
		"pos_next_copies": 1,
		"modified": datetime.fromisoformat(modified),
		**values,
	}


def site_tables():
	return {
		"POS Profile User": {"row-1": {"name": "row-1", "parent": "Main", "user": "lina@example.com"}},
		"POS Settings": {
			"S1": {
				"name": "S1",
				"pos_profile": "Main",
				"enabled": 1,
				"print_template": "Receipt",
				"modified": datetime(2026, 11, 2, 9, 0),
			}
		},
		"Print Format": {
			"Receipt": _template("Receipt", pos_next_copies=2),
			"Old": _template("Old", offline=0, modified="2026-11-03 12:00:00"),
			"Order": _template("Order", doc_type="Sales Order", modified="2026-11-20 00:00:00"),
			"A5 Sheet": _template("A5 Sheet", paper_size="A5", disabled=1),
		},
		"Company": {
			"Co": {
				"name": "Co",
				"company_name": "Co Ltd",
				"tax_id": "300000000000003",
				"phone_no": "011 000",
				"email": "info@co.test",
				"website": "co.test",
				"company_logo": None,
				"default_currency": "SAR",
				"modified": datetime(2026, 10, 1),
			}
		},
		"Address": {
			"Co-Billing": {
				"name": "Co-Billing",
				"address_line1": "King Fahd Road",
				"address_line2": "",
				"city": "Riyadh",
				"county": None,
				"state": "Riyadh Province",
				"pincode": "12211",
				"country": "Saudi Arabia",
				"modified": datetime(2026, 10, 5),
			}
		},
		"User": {"lina@example.com": {"name": "lina@example.com", "full_name": "Lina Cashier"}},
		"Customer": {
			"Walk In": {
				"name": "Walk In",
				"customer_name": "Walk In",
				"tax_id": None,
				"mobile_no": "0500000000",
				"customer_primary_address": None,
			}
		},
	}


class PrintTestCase(unittest.TestCase):
	def setUp(self):
		self.db = FakeDb(site_tables(), company_address="Co-Billing")
		self.profile = frappe._dict(
			name="Main",
			company="Co",
			warehouse="Stores",
			currency="SAR",
			letter_head=None,
			selling_price_list="Retail",
			customer="Walk In",
			modified=datetime(2026, 9, 1),
		)
		self.has_permission = Mock(return_value=False)
		self.docs = {("POS Profile", "Main"): self.profile}

		for target, replacement in (
			("frappe.throw", _raise),
			("pos_next.api.print_templates._", lambda text: text),
			("pos_next.api.sync_pull._", lambda text: text),
			("frappe.has_permission", self.has_permission),
			("frappe.get_all", self.get_all),
			("frappe.get_doc", lambda doctype, name=None: self.docs[(doctype, name)]),
			("pos_next.api.print_templates._log", Mock()),
		):
			patcher = patch(target, replacement)
			patcher.start()
			self.addCleanup(patcher.stop)

		keep_local(self, "session", "db", "pos_device")
		frappe.local.session = Mock(user="lina@example.com")
		frappe.local.db = self.db
		frappe.local.pos_device = None

	def get_all(self, doctype, filters=None, fields=None, order_by=None, pluck=None, **_kwargs):
		rows = self.db.rows(doctype, filters)
		if pluck:
			return [row[pluck] for row in rows]
		rows = sorted(rows, key=lambda row: row["name"])
		return [frappe._dict({field: row.get(field) for field in fields}) for row in rows]


class TestPrintBundle(PrintTestCase):
	def test_shape(self):
		bundle = print_templates.get_print_bundle("Main")

		self.assertEqual(set(bundle), {"templates", "default_template", "company", "pos_profile", "modified"})
		self.assertEqual(
			set(bundle["company"]),
			{"name", "company_name", "address", "tax_id", "phone", "email", "website", "logo", "currency"},
		)
		self.assertEqual(set(bundle["templates"][0]), set(print_templates.TEMPLATE_FIELDS))
		self.assertEqual(bundle["pos_profile"]["warehouse"], "Stores")
		self.assertEqual(bundle["default_template"], "Receipt")

	def test_only_enabled_templates_go_to_the_device(self):
		bundle = print_templates.get_print_bundle("Main")

		self.assertEqual([template["name"] for template in bundle["templates"]], ["Receipt"])
		self.assertEqual(bundle["templates"][0]["copies"], 2)
		self.assertEqual(bundle["templates"][0]["paper"], "80mm")
		self.assertEqual(bundle["templates"][0]["template_name"], "Receipt")

	def test_paper_sizes_become_the_device_names(self):
		self.assertEqual(
			[print_templates.device_paper(size) for size in ("Receipt 80 mm", "Receipt 58 mm", "A4", "A5")],
			["80mm", "58mm", "A4", "A5"],
		)

	def test_the_address_is_plain_lines(self):
		address = print_templates.get_print_bundle("Main")["company"]["address"]

		self.assertEqual(address, "King Fahd Road\nRiyadh Riyadh Province 12211\nSaudi Arabia")

	def test_modified_counts_a_disabled_template_so_the_device_drops_it(self):
		self.assertEqual(print_templates.get_print_bundle("Main")["modified"], "2026-11-03 12:00:00")

	def test_modified_counts_a_deleted_template(self):
		self.db.deleted = datetime(2026, 11, 5, 8, 0)

		self.assertEqual(print_templates.get_print_bundle("Main")["modified"], "2026-11-05 08:00:00")

	def test_nothing_newer_than_the_device_holds_sends_only_the_stamp(self):
		bundle = print_templates.get_print_bundle("Main", since="2026-11-03 12:00:00")

		self.assertEqual(bundle, {"unchanged": True, "modified": "2026-11-03 12:00:00"})

	def test_a_disabled_default_is_not_named(self):
		self.db.tables["Print Format"]["Receipt"]["pos_next_offline"] = 0

		bundle = print_templates.get_print_bundle("Main")

		self.assertEqual(bundle["templates"], [])
		self.assertIsNone(bundle["default_template"])

	def test_a_profile_without_templates_gets_an_empty_bundle(self):
		self.db.tables["Print Format"] = {}
		self.db.tables["POS Settings"]["S1"]["print_template"] = None

		bundle = print_templates.get_print_bundle("Main")

		self.assertEqual(bundle["templates"], [])
		self.assertIsNone(bundle["default_template"])
		self.assertFalse(print_templates.has_print_templates("Main"))

	def test_refuses_a_user_outside_the_profile(self):
		frappe.local.session = Mock(user="other@example.com")

		with self.assertRaises(frappe.PermissionError):
			print_templates.get_print_bundle("Main")

	def test_a_profile_manager_may_read_it(self):
		frappe.local.session = Mock(user="manager@example.com")
		self.has_permission.return_value = True

		self.assertIn("templates", print_templates.get_print_bundle("Main"))

	def test_refuses_without_a_profile(self):
		with self.assertRaises(frappe.PermissionError):
			print_templates.get_print_bundle(None)


class TestBootstrapBundle(PrintTestCase):
	def test_no_bundle_when_there_is_nothing_to_print_with(self):
		self.db.tables["Print Format"] = {}
		self.db.tables["POS Settings"]["S1"]["print_template"] = None

		self.assertIsNone(bootstrap._get_print_bundle(self.profile))

	def test_the_bundle_of_the_shift_profile(self):
		bundle = bootstrap._get_print_bundle(self.profile)

		self.assertEqual(bundle["default_template"], "Receipt")

	def test_a_failure_does_not_stop_the_pos_from_starting(self):
		with (
			patch("pos_next.api.print_templates.build_print_bundle", side_effect=RuntimeError("boom")),
			patch("frappe.log_error") as log_error,
		):
			self.assertIsNone(bootstrap._get_print_bundle(self.profile))
		log_error.assert_called_once()


class FakeInvoice(frappe._dict):
	def as_dict(self, **_kwargs):
		return {key: value for key, value in self.items()}


class TestPrintContext(PrintTestCase):
	def setUp(self):
		super().setUp()
		self.invoice = FakeInvoice(
			doctype="Sales Invoice",
			name="ACC-SINV-0001",
			company="Co",
			pos_profile="Main",
			owner="lina@example.com",
			customer="Walk In",
			customer_name="Walk In",
			posting_date="2026-11-08",
			posting_time=timedelta(hours=9, minutes=5, seconds=7, microseconds=12),
			items=[{"item_code": "TEA", "qty": 1}],
			taxes=[{"description": "VAT", "rate": 15}],
			payments=[{"mode_of_payment": "Cash", "amount": 10}],
		)
		self.db.tables["Sales Invoice"] = {"ACC-SINV-0001": {"name": "ACC-SINV-0001"}}
		self.docs[("Sales Invoice", "ACC-SINV-0001")] = self.invoice

	def allow_reading(self):
		self.has_permission.side_effect = lambda doctype, ptype="read", **_kwargs: doctype == "Sales Invoice"

	def test_shape(self):
		self.allow_reading()

		context = print_templates.get_print_context("ACC-SINV-0001")

		self.assertEqual(set(context), {"doc", "company", "pos_profile", "cashier", "customer"})
		self.assertEqual(context["cashier"], {"user": "lina@example.com", "full_name": "Lina Cashier"})
		self.assertEqual(
			set(context["customer"]), {"name", "customer_name", "tax_id", "mobile_no", "address"}
		)
		self.assertEqual(context["customer"]["mobile_no"], "0500000000")
		self.assertEqual(context["doc"]["items"], [{"item_code": "TEA", "qty": 1}])
		self.assertEqual(context["company"]["tax_id"], "300000000000003")

	def test_the_time_is_hours_minutes_seconds(self):
		self.allow_reading()

		self.assertEqual(
			print_templates.get_print_context("ACC-SINV-0001")["doc"]["posting_time"], "09:05:07"
		)

	def test_refuses_an_invoice_the_user_may_not_read(self):
		with self.assertRaises(frappe.PermissionError):
			print_templates.get_print_context("ACC-SINV-0001")

	def test_refuses_an_invoice_of_a_profile_the_user_is_not_on(self):
		self.allow_reading()
		self.db.tables["POS Profile User"] = {}

		with self.assertRaises(frappe.PermissionError):
			print_templates.get_print_context("ACC-SINV-0001")

	def test_refuses_other_doctypes(self):
		with self.assertRaises(frappe.PermissionError):
			print_templates.get_print_context("PINV-0001", doctype="Purchase Invoice")

	def test_a_missing_invoice(self):
		with self.assertRaises(frappe.DoesNotExistError):
			print_templates.get_print_context("ACC-SINV-9999")


class TestPreviewInvoice(PrintTestCase):
	def test_only_invoices_of_the_users_profiles(self):
		with patch("frappe.get_list", return_value=["ACC-SINV-0002"]) as get_list:
			self.assertEqual(print_templates.get_preview_invoice(), "ACC-SINV-0002")

		filters = get_list.call_args.kwargs["filters"]
		self.assertEqual(filters, {"docstatus": 1, "is_pos": 1, "pos_profile": ["in", ["Main"]]})

	def test_a_profile_manager_sees_every_profile(self):
		self.has_permission.return_value = True

		with patch("frappe.get_list", return_value=[]) as get_list:
			self.assertIsNone(print_templates.get_preview_invoice("POS Invoice"))

		self.assertEqual(get_list.call_args.kwargs["filters"], {"docstatus": 1})

	def test_a_user_on_no_profile_gets_none(self):
		frappe.local.session = Mock(user="other@example.com")

		with patch("frappe.get_list") as get_list:
			self.assertIsNone(print_templates.get_preview_invoice())
		get_list.assert_not_called()

	def test_refuses_other_doctypes(self):
		with self.assertRaises(frappe.PermissionError):
			print_templates.get_preview_invoice("Purchase Invoice")


class TestLogo(unittest.TestCase):
	def setUp(self):
		self.site = tempfile.mkdtemp()
		self.addCleanup(shutil.rmtree, self.site)
		os.makedirs(os.path.join(self.site, "public", "files"))
		os.makedirs(os.path.join(self.site, "private", "files"))
		with open(os.path.join(self.site, "site_config.json"), "w") as handle:
			handle.write("{}")

		self.log = Mock()
		for target, replacement in (
			("frappe.get_site_path", lambda *parts: os.path.join(self.site, *parts)),
			("pos_next.api.print_templates._log", self.log),
		):
			patcher = patch(target, replacement)
			patcher.start()
			self.addCleanup(patcher.stop)

	def write(self, folder, name, data):
		with open(os.path.join(self.site, folder, "files", name), "wb") as handle:
			handle.write(data)

	def test_a_logo_is_embedded_so_it_prints_offline(self):
		self.write("public", "logo.png", PNG)

		uri = print_templates.logo_data_uri("/files/logo.png")

		self.assertEqual(uri, "data:image/png;base64," + base64.b64encode(PNG).decode())

	def test_a_private_logo_is_read_too(self):
		self.write("private", "logo.png", PNG)

		self.assertTrue(
			print_templates.logo_data_uri("/private/files/logo.png?fid=1").startswith("data:image/png")
		)

	def test_a_logo_over_the_cap_is_left_out_and_logged(self):
		self.write("public", "big.png", PNG + b"\0" * print_templates.LOGO_MAX_BYTES)

		self.assertIsNone(print_templates.logo_data_uri("/files/big.png"))
		self.assertIn("big.png", self.log.call_args.args[0])

	def test_a_logo_at_the_cap_is_kept(self):
		self.write("public", "edge.png", PNG + b"\0" * (print_templates.LOGO_MAX_BYTES - len(PNG)))

		self.assertIsNotNone(print_templates.logo_data_uri("/files/edge.png"))

	def test_no_logo(self):
		self.assertIsNone(print_templates.logo_data_uri(None))
		self.log.assert_not_called()

	def test_files_outside_the_site_files_are_refused(self):
		self.assertIsNone(print_templates.logo_data_uri("/files/../../site_config.json"))
		self.assertIsNone(print_templates.logo_data_uri("https://example.com/logo.png"))

	def test_a_file_that_is_not_an_image(self):
		self.write("public", "notes.txt", b"hello")

		self.assertIsNone(print_templates.logo_data_uri("/files/notes.txt"))


class TestDefaultTemplates(unittest.TestCase):
	def setUp(self):
		self.db = FakeDb({"Print Format": {}, "Deleted Document": {}})
		self.inserted = []

		def make(values):
			doc = Mock()
			doc.insert.side_effect = lambda **_kwargs: (
				self.db.tables["Print Format"].__setitem__(values["name"], dict(values))
				or self.inserted.append(values)
			)
			return doc

		patcher = patch("frappe.get_doc", make)
		patcher.start()
		self.addCleanup(patcher.stop)
		keep_local(self, "db")
		frappe.local.db = self.db

	def test_the_three_are_made_once(self):
		first = shipped_formats.ensure_default_formats()
		second = shipped_formats.ensure_default_formats()

		self.assertEqual(first, ["POS Next Receipt 80mm", "POS Next Receipt 58mm", "POS Next A4 Tax Invoice"])
		self.assertEqual(second, [])
		self.assertEqual(len(self.inserted), 3)

	def test_an_edited_format_is_left_as_it_is(self):
		self.db.tables["Print Format"]["POS Next Receipt 80mm"] = {
			"name": "POS Next Receipt 80mm",
			"html": "mine",
		}

		made = shipped_formats.ensure_default_formats()

		self.assertNotIn("POS Next Receipt 80mm", made)
		self.assertEqual(self.db.tables["Print Format"]["POS Next Receipt 80mm"]["html"], "mine")

	def test_a_deleted_format_stays_deleted(self):
		self.db.tables["Deleted Document"]["D1"] = {
			"name": "D1",
			"deleted_doctype": "Print Format",
			"deleted_name": "POS Next A4 Tax Invoice",
		}

		self.assertNotIn("POS Next A4 Tax Invoice", shipped_formats.ensure_default_formats())

	def test_each_is_a_jinja_invoice_format_ticked_for_devices(self):
		shipped_formats.ensure_default_formats()

		papers = {values["name"]: values["paper_size"] for values in self.inserted}
		self.assertEqual(
			papers,
			{
				"POS Next Receipt 80mm": "Receipt 80 mm",
				"POS Next Receipt 58mm": "Receipt 58 mm",
				"POS Next A4 Tax Invoice": "A4",
			},
		)
		for values in self.inserted:
			self.assertEqual(values["doc_type"], "Sales Invoice")
			self.assertEqual((values["custom_format"], values["print_format_type"]), (1, "Jinja"))
			self.assertEqual((values["pos_next_offline"], values["standard"]), (1, "No"))
			self.assertIn("pos_print_context(doc)", values["html"])
			self.assertIn("doc.items", values["html"])
			self.assertIn("@page", values["css"])
			self.assertEqual(print_templates.template_problems(values["html"]), [])

	def test_migrate_and_install_make_them(self):
		from pos_next import install

		frappe.local.db = Mock()
		with (
			patch("pos_next.install.ensure_default_print_templates") as ensure,
			patch.multiple(
				"pos_next.install",
				ensure_cashier_permissions=Mock(),
				add_sync_pull_indexes=Mock(),
				add_stock_pull_index=Mock(),
			),
			patch("frappe.clear_cache"),
		):
			install.after_migrate()
			install.after_install()

		self.assertEqual(ensure.call_count, 2)


class TestPrintFormatValidation(unittest.TestCase):
	def setUp(self):
		patcher = patch("frappe.throw", _raise)
		patcher.start()
		self.addCleanup(patcher.stop)

	def fmt(self, **values):
		base = {
			"pos_next_offline": 1,
			"custom_format": 1,
			"print_format_type": "Jinja",
			"raw_printing": 0,
			"doc_type": "Sales Invoice",
			"paper_size": "Receipt 80 mm",
			"pos_next_copies": 1,
			"html": "{% set pos = pos_print_context(doc) %}{{ pos.company.name }}",
		}
		return frappe._dict({**base, **values})

	def test_an_unticked_format_is_not_checked(self):
		print_templates.validate_print_format(
			self.fmt(pos_next_offline=0, html="{{ frappe.db.get_value('x') }}")
		)

	def test_a_format_the_device_can_print_passes(self):
		doc = self.fmt(pos_next_copies=0)
		print_templates.validate_print_format(doc)
		self.assertEqual(doc.pos_next_copies, 1)

	def test_database_reads_are_refused(self):
		for html in (
			"{{ frappe.db.get_value('Company', doc.company, 'tax_id') }}",
			"{% set c = frappe.get_doc('Customer', doc.customer) %}",
			"{{ frappe.session.user }}",
			"{% include 'templates/x.html' %}",
		):
			with self.subTest(html=html), self.assertRaises(frappe.ValidationError):
				print_templates.validate_print_format(self.fmt(html=html))

	def test_the_formatting_parts_of_frappe_pass(self):
		html = "{{ frappe.utils.fmt_money(doc.grand_total) }} {{ frappe.format_date(doc.posting_date) }} {{ frappe._('x') }}"
		self.assertEqual(print_templates.template_problems(html), [])

	def test_the_problems_are_named(self):
		self.assertEqual(
			print_templates.template_problems(
				"{{ frappe.db.sql('x') }}{{ frappe.db.sql('y') }}{{ frappe.get_url() }}"
			),
			["frappe.db.sql", "frappe.get_url"],
		)

	def test_only_jinja_invoice_formats_with_a_device_paper(self):
		for values in (
			{"custom_format": 0},
			{"print_format_type": "JS"},
			{"raw_printing": 1},
			{"doc_type": "Sales Order"},
			{"paper_size": "Letter"},
			{"paper_size": None},
		):
			with self.subTest(values=values), self.assertRaises(frappe.ValidationError):
				print_templates.validate_print_format(self.fmt(**values))


def as_objects(value):
	if isinstance(value, dict):
		return SimpleNamespace(**{key: as_objects(item) for key, item in value.items()})
	if isinstance(value, list):
		return [as_objects(item) for item in value]
	return value


HELPERS = {
	"_",
	"format_currency",
	"format_date",
	"format_datetime",
	"format_number",
	"qr",
	"barcode",
	"money_in_words",
	"pos_print_context",
	"format_time",
}
KEYWORDS = {"and", "or", "not", "in", "is", "if", "else", "elif"}
CONTEXT = {
	"pos",
	"doc",
	"company",
	"pos_profile",
	"cashier",
	"customer",
	"print",
	"loop",
	"item",
	"tax",
	"payment",
}


class TestDefaultTemplateSource(unittest.TestCase):
	"""The device renders these with Nunjucks, so they keep to the names and helpers it has."""

	def sources(self):
		for spec in shipped_formats.DEFAULT_FORMATS:
			yield spec["name"], shipped_formats._read(spec["html"])

	def code(self, html, pattern):
		"""The code inside the tags, without the text of string literals."""
		blocks = (
			" ".join(parts) if isinstance(parts, tuple) else parts
			for parts in re.findall(pattern, html, re.S)
		)
		return [re.sub(r"'[^']*'|\"[^\"]*\"", "''", block) for block in blocks]

	def test_only_the_helpers_of_the_plan_are_called(self):
		for name, html in self.sources():
			calls = set()
			for block in self.code(html, r"{{(.*?)}}|{%(.*?)%}"):
				calls |= set(re.findall(r"(?<![\w.])([A-Za-z_]\w*)\s*\(", block))
			self.assertLessEqual(calls - KEYWORDS, HELPERS, name)

	def test_only_the_context_names_of_the_plan_are_read(self):
		for name, html in self.sources():
			roots = set()
			for block in self.code(html, r"{{(.*?)}}|{%(.*?)%}"):
				roots |= set(re.findall(r"(?<![\w.])([A-Za-z_]\w*)\.", block))
			self.assertLessEqual(roots, CONTEXT, name)

	def test_they_render_and_follow_the_direction(self):
		import jinja2

		environment = jinja2.Environment(autoescape=True, undefined=jinja2.Undefined)
		helpers = {
			"_": lambda text: text,
			"format_currency": lambda value, currency=None: f"{currency} {value}",
			"format_date": str,
			"format_datetime": str,
			"format_number": str,
			"qr": lambda text: "data:image/png;base64,QR",
			"barcode": lambda text: "data:image/png;base64,BAR",
			"money_in_words": lambda value, currency=None: f"{value} in words",
			"format_time": str,
		}
		context = {
			"doc": {
				"name": "SINV-1",
				"currency": "SAR",
				"posting_date": "2026-11-08",
				"posting_time": "09:05:07",
				"items": [{"item_name": "Tea", "qty": 2, "rate": 5, "amount": 10, "discount_amount": 1}],
				"taxes": [{"description": "VAT", "rate": 15, "tax_amount": 1.5}],
				"payments": [{"mode_of_payment": "Cash", "amount": 20}],
				"total": 10,
				"grand_total": 11.5,
				"change_amount": 8.5,
			},
			"company": {
				"company_name": "Co Ltd",
				"address": "Line 1\nLine 2",
				"tax_id": "300",
				"logo": "data:image/png;base64,X",
			},
			"pos_profile": {"name": "Main"},
			"cashier": {"user": "lina@example.com", "full_name": "Lina"},
			"customer": {"name": "Walk In", "customer_name": "Walk In"},
			"print": {"rtl": True, "lang": "ar", "paper": "80mm", "copy": 1},
		}
		objects = {key: as_objects(value) for key, value in context.items()}
		# What Frappe's renderer and the device both answer pos_print_context(doc) with
		pos = SimpleNamespace(
			**helpers,
			**{key: objects[key] for key in ("company", "pos_profile", "cashier", "customer", "print")},
		)
		for name, html in self.sources():
			# Attributes like Nunjucks reads them: doc.items is the rows, not dict.items
			output = environment.from_string(html).render(
				doc=objects["doc"], _=helpers["_"], pos_print_context=lambda doc: pos
			)
			self.assertIn('dir="rtl"', output, name)
			for expected in ("SINV-1", "Tea", "VAT", "Cash", "Lina", "Co Ltd", "data:image/png;base64,QR"):
				self.assertIn(expected, output, name)
