# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""The number a device gives an invoice: what the server keeps, tells the device, and finds by.

These run without a site. The real runs on MariaDB cover the same paths end to end.
"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import frappe
from frappe.query_builder.utils import get_query_builder

from pos_next.api import bootstrap, invoices, sales_invoice_hooks
from pos_next.services import local_numbering, sync_inbox
from pos_next.services.local_numbering import LocalNumberError

SALE_NUMBER = "LACC-SINV-2026-3-00001"
SHIFT = "POSA-OS-26-0000003"


def _raise(message, exc=frappe.ValidationError, **_kwargs):
	raise exc(message)


class NoSiteTestCase(unittest.TestCase):
	def setUp(self):
		for target, replacement in (
			("frappe.throw", _raise),
			("pos_next.services.local_numbering._", lambda text: text),
		):
			patcher = patch(target, replacement)
			patcher.start()
			self.addCleanup(patcher.stop)

		frappe.local.db = Mock()
		frappe.local.qb = get_query_builder("mariadb")
		frappe.local.flags = frappe._dict()
		self.addCleanup(setattr, frappe.local, "db", None)
		self.addCleanup(setattr, frappe.local, "qb", None)
		self.addCleanup(setattr, frappe.local, "flags", None)


class TestWhatIsKept(NoSiteTestCase):
	def test_a_number_is_kept_exactly_as_it_came(self):
		self.assertEqual(local_numbering.check(SALE_NUMBER), SALE_NUMBER)
		self.assertEqual(local_numbering.check("L x-00001 "), "L x-00001 ")

	def test_an_old_device_sends_none(self):
		self.assertIsNone(local_numbering.check(None))
		self.assertIsNone(local_numbering.check(""))

	def test_a_number_must_start_with_l(self):
		for value in ("ACC-SINV-2026-3-00001", "lACC-1", 12):
			with self.assertRaises(LocalNumberError):
				local_numbering.check(value)

	def test_a_number_fits_its_field(self):
		self.assertEqual(local_numbering.check("L" + "1" * 139), "L" + "1" * 139)
		with self.assertRaises(LocalNumberError):
			local_numbering.check("L" + "1" * 140)

	def test_the_queue_keeps_what_it_can_store_and_leaves_the_rest_to_the_invoice(self):
		self.assertEqual(local_numbering.of_payload({"posa_local_number": SALE_NUMBER}), SALE_NUMBER)
		self.assertEqual(local_numbering.of_payload({"posa_local_number": "X-1"}), "X-1")
		self.assertIsNone(local_numbering.of_payload({"posa_local_number": "L" * 141}))
		self.assertIsNone(local_numbering.of_payload({"posa_local_number": 7}))
		self.assertIsNone(local_numbering.of_payload({}))
		self.assertIsNone(local_numbering.of_payload(None))


class TestInvoiceHooks(NoSiteTestCase):
	def test_the_invoice_refuses_a_number_no_device_makes(self):
		doc = frappe._dict(posa_local_number="SINV-1")
		with self.assertRaises(LocalNumberError):
			sales_invoice_hooks.validate_local_number(doc)

	def test_the_invoice_keeps_a_good_number_and_clears_an_empty_one(self):
		doc = frappe._dict(posa_local_number=SALE_NUMBER)
		sales_invoice_hooks.validate_local_number(doc)
		self.assertEqual(doc.posa_local_number, SALE_NUMBER)

		doc = frappe._dict(posa_local_number="")
		sales_invoice_hooks.validate_local_number(doc)
		self.assertIsNone(doc.posa_local_number)

	def test_an_amendment_does_not_take_the_number_of_the_invoice_it_amends(self):
		doc = frappe._dict(amended_from="SINV-1", offline_id="pos_offline_1", posa_local_number=SALE_NUMBER)
		sales_invoice_hooks.free_offline_id_on_amend(doc)
		self.assertIsNone(doc.posa_local_number)
		self.assertIsNone(doc.offline_id)

	def test_a_new_invoice_keeps_its_number(self):
		doc = frappe._dict(amended_from=None, offline_id="pos_offline_1", posa_local_number=SALE_NUMBER)
		sales_invoice_hooks.free_offline_id_on_amend(doc)
		self.assertEqual(doc.posa_local_number, SALE_NUMBER)


class TestParts(NoSiteTestCase):
	def test_the_shift_number_is_the_last_group_of_digits(self):
		self.assertEqual(local_numbering.shift_number(SHIFT), "3")
		self.assertEqual(local_numbering.shift_number("POS-OPEN-2026-00120"), "120")
		self.assertEqual(local_numbering.shift_number("SHIFT-0"), "0")
		self.assertIsNone(local_numbering.shift_number("pos_offline_shift"))
		self.assertIsNone(local_numbering.shift_number(None))

	def test_the_counter_is_the_digits_after_the_last_dash(self):
		self.assertEqual(local_numbering.counter_of(SALE_NUMBER), 1)
		self.assertEqual(local_numbering.counter_of("LACC-SINV-RET-2026-3-00042"), 42)
		self.assertIsNone(local_numbering.counter_of("LACC-SINV-2026-3-x"))
		self.assertIsNone(local_numbering.counter_of(None))


class FakeRule(SimpleNamespace):
	pass


class TestSeries(NoSiteTestCase):
	def _series(
		self,
		is_return,
		rules=(),
		default="ACC-SINV-.YYYY.-",
		options="ACC-SINV-.YYYY.-\nACC-SINV-RET-.YYYY.-",
	):
		probe = frappe._dict(doctype="Sales Invoice", naming_series=default)
		by_name = {rule.name: rule for rule in rules}
		with (
			patch("frappe.new_doc", return_value=probe),
			patch(
				"frappe.cache_manager.get_doctype_map",
				return_value=[frappe._dict(name=rule.name) for rule in rules],
			) as rule_map,
			patch("frappe.get_cached_doc", side_effect=lambda _doctype, name: by_name[name]),
			patch(
				"frappe.get_meta",
				return_value=Mock(
					get_naming_series_options=lambda: options.split("\n"),
					get_field=lambda fieldname: frappe._dict(fieldname=fieldname, fieldtype="Check"),
				),
			),
		):
			series = local_numbering.get_series("Sales Invoice", is_return, {"company": "Acme"})
		self.assertEqual(rule_map.call_args.kwargs["order_by"], "priority desc")
		return series

	def test_a_sale_takes_the_default_series(self):
		self.assertEqual(self._series(False), "ACC-SINV-.YYYY.-")

	def test_a_return_takes_the_same_series_as_erpnext_gives_no_return_its_own(self):
		self.assertEqual(self._series(True), "ACC-SINV-.YYYY.-")

	def test_the_default_document_naming_settings_set_is_used(self):
		self.assertEqual(self._series(False, default="SHOP-.YYYY.-"), "SHOP-.YYYY.-")

	def test_without_a_default_the_first_series_is_used(self):
		self.assertEqual(self._series(False, default="", options="\nINV-.YY.-\nRET-"), "INV-.YY.-")

	def test_a_naming_rule_the_return_meets_gives_its_prefix(self):
		rule = FakeRule(
			name="R1",
			document_type="Sales Invoice",
			prefix="RET-.YYYY.-",
			conditions=[SimpleNamespace(field="is_return", condition="=", value="1")],
		)
		self.assertEqual(self._series(True, [rule]), "RET-.YYYY.-")
		self.assertEqual(self._series(False, [rule]), "ACC-SINV-.YYYY.-")

	def test_a_naming_rule_without_conditions_names_every_invoice(self):
		rule = FakeRule(name="R1", document_type="Sales Invoice", prefix="ALL-", conditions=[])
		self.assertEqual(self._series(False, [rule]), "ALL-")
		self.assertEqual(self._series(True, [rule]), "ALL-")


class TestNextCounters(NoSiteTestCase):
	def _counters(self, sales_invoices=(), pos_invoices=(), records=()):
		tables = {
			"Sales Invoice": [frappe._dict(row) for row in sales_invoices],
			"POS Invoice": [frappe._dict(row) for row in pos_invoices],
			"Offline Invoice Sync": [frappe._dict(row) for row in records],
		}
		with patch("frappe.get_all", side_effect=lambda doctype, **_kwargs: tables[doctype]) as get_all:
			counters = local_numbering.next_counters(SHIFT)
		for call in get_all.call_args_list:
			filters = call.kwargs["filters"]
			self.assertEqual(filters.get("posa_pos_opening_shift") or filters.get("shift"), SHIFT)
		return counters

	def test_a_new_shift_starts_at_one(self):
		self.assertEqual(self._counters(), {"sale": 1, "return": 1})

	def test_it_goes_on_after_the_highest_of_each_kind(self):
		counters = self._counters(
			sales_invoices=[
				{"posa_local_number": "LACC-SINV-2026-3-00007", "is_return": 0},
				{"posa_local_number": "LACC-SINV-2026-3-00002", "is_return": 0},
				{"posa_local_number": "LACC-SINV-2026-3-00003", "is_return": 1},
			],
			pos_invoices=[{"posa_local_number": "LACC-PSINV-2026-3-00009", "is_return": 0}],
		)
		self.assertEqual(counters, {"sale": 10, "return": 4})

	def test_a_sale_still_in_the_queue_counts(self):
		counters = self._counters(
			sales_invoices=[{"posa_local_number": "LACC-SINV-2026-3-00002", "is_return": 0}],
			records=[
				{"posa_local_number": "LACC-SINV-2026-3-00005", "payload": json.dumps({"is_return": 0})},
				{"posa_local_number": "LACC-SINV-2026-3-00006", "payload": json.dumps({"is_return": 1})},
			],
		)
		self.assertEqual(counters, {"sale": 6, "return": 7})

	def test_a_record_that_cannot_say_its_kind_counts_for_both(self):
		counters = self._counters(records=[{"posa_local_number": "LACC-SINV-2026-3-00004", "payload": None}])
		self.assertEqual(counters, {"sale": 5, "return": 5})

	def test_a_number_without_a_counter_is_ignored(self):
		counters = self._counters(sales_invoices=[{"posa_local_number": "Lodd", "is_return": 0}])
		self.assertEqual(counters, {"sale": 1, "return": 1})


class TestLocalNumbering(NoSiteTestCase):
	def _numbering(self, invoice_type=None, shift=SHIFT):
		profile = SimpleNamespace(name="Main", company="Acme", get=lambda _key: None)
		frappe.local.db.get_value.return_value = invoice_type
		with (
			patch(
				"pos_next.services.local_numbering.get_series", side_effect=["S-.YYYY.-", "R-.YYYY.-"]
			) as series,
			patch("pos_next.services.local_numbering.next_counters", return_value={"sale": 4, "return": 2}),
		):
			numbering = local_numbering.get_local_numbering(profile, shift)
		return numbering, series

	def test_shape(self):
		numbering, series = self._numbering()
		self.assertEqual(
			numbering,
			{
				"sale_series": "S-.YYYY.-",
				"return_series": "R-.YYYY.-",
				"shift_number": "3",
				"next": {"sale": 4, "return": 2},
			},
		)
		self.assertEqual(series.call_args_list[0].args[:2], ("Sales Invoice", False))
		self.assertEqual(series.call_args_list[1].args[:2], ("Sales Invoice", True))

	def _return_option(self, options):
		meta = Mock(get_field=lambda _fieldname: frappe._dict(options=options))
		with patch("frappe.get_meta", return_value=meta):
			return local_numbering._return_option("Sales Invoice", "ACC-SINV-.YYYY.-")

	def test_a_return_takes_erpnexts_ret_series_when_erpnext_gives_it_the_sales(self):
		"""ERPNext names returns by the sale's series; their local numbers read as returns."""
		self.assertEqual(self._return_option("ACC-SINV-.YYYY.-\nACC-SINV-RET-.YYYY.-"), "ACC-SINV-RET-.YYYY.-")
		self.assertIsNone(self._return_option("ACC-SINV-.YYYY.-\nOTHER-RET-.YYYY.-"))
		self.assertIsNone(self._return_option("ACC-SINV-.YYYY.-"))

	def test_the_ret_series_is_used_only_when_both_kinds_would_share_one(self):
		profile = SimpleNamespace(name="Main", company="Acme", get=lambda _key: None)
		frappe.local.db.get_value.return_value = None
		with (
			patch("pos_next.services.local_numbering.get_series", side_effect=["S-.YYYY.-", "S-.YYYY.-"]),
			patch("pos_next.services.local_numbering._return_option", return_value="S-RET-.YYYY.-"),
			patch("pos_next.services.local_numbering.next_counters", return_value={"sale": 1, "return": 1}),
		):
			numbering = local_numbering.get_local_numbering(profile, SHIFT)
		self.assertEqual(numbering["return_series"], "S-RET-.YYYY.-")

	def test_a_pos_invoice_profile_takes_the_series_of_pos_invoices(self):
		_numbering, series = self._numbering("POS Invoice")
		self.assertEqual(series.call_args_list[0].args[0], "POS Invoice")

	def test_no_shift_has_no_number(self):
		numbering, _series = self._numbering(shift=None)
		self.assertIsNone(numbering["shift_number"])
		self.assertEqual(numbering["next"], {"sale": 1, "return": 1})

	def test_a_failure_does_not_stop_the_answer(self):
		with (
			patch("pos_next.services.local_numbering.get_local_numbering", side_effect=RuntimeError("boom")),
			patch("frappe.log_error") as log_error,
		):
			self.assertIsNone(local_numbering.get_local_numbering_safely("Main", SHIFT))
		log_error.assert_called_once()

	def test_bootstrap_answers_with_it(self):
		profile = SimpleNamespace(
			name="Main",
			company="Acme",
			currency="SAR",
			warehouse="W",
			selling_price_list="Std",
			customer=None,
			write_off_account=None,
			write_off_cost_center=None,
			write_off_limit=0,
			ignore_pricing_rule=0,
			get=lambda _key, default=None: default,
		)
		shift = {
			"name": SHIFT,
			"pos_profile": "Main",
			"period_start_date": "2026-11-09",
			"status": "Open",
			"pos_profile_doc": profile,
		}
		with (
			patch("frappe.session", SimpleNamespace(user="cashier@example.com")),
			patch("frappe.get_roles", return_value=[]),
			patch("pos_next.api.bootstrap._get_user_language", return_value="ar"),
			patch("pos_next.api.bootstrap._get_precision_settings", return_value={}),
			patch("pos_next.api.bootstrap._get_open_shift", return_value=shift),
			patch("pos_next.api.bootstrap._get_pos_settings", return_value={}),
			patch("pos_next.api.bootstrap._get_payment_methods", return_value=[]),
			patch("pos_next.api.bootstrap._get_print_bundle", return_value=None),
			patch(
				"pos_next.api.bootstrap.get_local_numbering_safely", return_value={"shift_number": "3"}
			) as numbering,
		):
			self.addCleanup(setattr, frappe.local, "site", getattr(frappe.local, "site", None))
			frappe.local.site = "test.local"
			result = bootstrap.get_initial_data()
		numbering.assert_called_once_with(profile, SHIFT)
		self.assertEqual(result["local_numbering"], {"shift_number": "3"})


class TestFindingAnInvoice(NoSiteTestCase):
	def _rows(self, by_doctype):
		return patch(
			"frappe.get_all",
			side_effect=lambda doctype, **_kwargs: [frappe._dict(row) for row in by_doctype.get(doctype, [])],
		)

	def test_a_submitted_invoice_comes_before_a_draft_or_a_cancelled_one(self):
		rows = {
			"Sales Invoice": [
				{"name": "SINV-OLD", "docstatus": 2, "creation": "2026-11-09 10:00"},
				{"name": "SINV-NEW", "docstatus": 0, "creation": "2026-11-09 12:00"},
			],
			"POS Invoice": [{"name": "PSINV-1", "docstatus": 1, "creation": "2026-11-09 09:00"}],
		}
		with self._rows(rows):
			self.assertEqual(local_numbering.find_by_local_number(SALE_NUMBER), ("POS Invoice", "PSINV-1"))

	def test_the_sale_comes_before_the_return_that_shares_its_number(self):
		rows = {
			"Sales Invoice": [
				{"name": "SINV-SALE", "docstatus": 1, "is_return": 0, "creation": "2026-11-09 10:00"},
				{"name": "SINV-RET", "docstatus": 1, "is_return": 1, "creation": "2026-11-09 11:00"},
			],
		}
		with self._rows(rows):
			self.assertEqual(
				local_numbering.find_by_local_number(SALE_NUMBER), ("Sales Invoice", "SINV-SALE")
			)

	def test_an_unknown_number_finds_nothing(self):
		with self._rows({}):
			self.assertIsNone(local_numbering.find_by_local_number(SALE_NUMBER))
		self.assertIsNone(local_numbering.find_by_local_number(None))

	def test_a_name_stays_the_name(self):
		frappe.local.db.exists.side_effect = lambda doctype, name: (
			doctype == "Sales Invoice" and name == "SINV-1"
		)
		with patch("frappe.get_all") as get_all:
			self.assertEqual(local_numbering.resolve_invoice_name("SINV-1"), "SINV-1")
		get_all.assert_not_called()

	def test_a_local_number_becomes_the_server_name(self):
		frappe.local.db.exists.return_value = False
		with self._rows({"Sales Invoice": [{"name": "SINV-9", "docstatus": 1, "creation": "2026-11-09"}]}):
			self.assertEqual(local_numbering.resolve_invoice_name(SALE_NUMBER), "SINV-9")

	def test_what_names_nothing_is_left_for_the_caller_to_refuse(self):
		frappe.local.db.exists.return_value = False
		with self._rows({}):
			self.assertEqual(local_numbering.resolve_invoice_name("NOPE"), "NOPE")


class TestSearches(NoSiteTestCase):
	"""The queries the search endpoints send, read as SQL."""

	def _sql(self):
		"""Each query with its values written in, as the database reads it."""
		queries = []
		for call in frappe.local.db.sql.call_args_list:
			query = str(call.args[0])
			values = call.args[1] if len(call.args) > 1 else call.kwargs.get("values")
			for key, value in sorted((values or {}).items(), key=lambda entry: -len(entry[0])):
				query = query.replace(f"%({key})s", repr(value))
			queries.append(query)
		return queries

	def test_search_by_number_matches_the_local_number_too(self):
		frappe.local.db.get_value.return_value = "Sales Invoice"
		frappe.local.db.sql.return_value = []
		invoices.search_invoice_by_number("SINV-2026-3", "Main")

		query = self._sql()[0]
		self.assertIn("`posa_local_number` LIKE '%SINV-2026-3%'", query)
		self.assertIn("`name` LIKE '%SINV-2026-3%'", query)
		self.assertIn("`posa_local_number`", query.split("FROM")[0])

	def test_search_for_return_matches_the_local_number_in_rows_and_count(self):
		frappe.local.db.sql.return_value = []
		invoices.search_invoices_for_return(invoice_name="00001")

		query = self._sql()[0]
		self.assertIn("`posa_local_number` LIKE '%00001%'", query)
		self.assertIn("`posa_local_number`", query.split("FROM")[0])

	def test_returnable_invoices_carry_the_local_number(self):
		frappe.local.db.get_value.return_value = None
		frappe.local.db.sql.return_value = []
		invoices.get_returnable_invoices(10, None)
		self.assertIn("`posa_local_number`", self._sql()[0].split("FROM")[0])

	def test_the_invoice_list_carries_the_local_number(self):
		frappe.local.db.exists.return_value = True
		frappe.local.db.get_value.return_value = None
		frappe.local.db.sql.return_value = []
		with patch("frappe.session", SimpleNamespace(user="cashier@example.com")):
			invoices.get_invoices("Main")
		self.assertIn("posa_local_number", self._sql()[0].split("FROM")[0])

	def test_a_return_can_start_from_the_local_number(self):
		with (
			patch("pos_next.api.invoices.resolve_invoice_name", return_value="SINV-9") as resolve,
			patch("pos_next.api.invoices._prepare_return_invoice", return_value={"name": "draft"}) as prepare,
		):
			invoices.prepare_return_invoice(SALE_NUMBER, SHIFT)
		resolve.assert_called_once_with(SALE_NUMBER)
		prepare.assert_called_once_with("SINV-9", SHIFT)

	def test_offline_return_documents_carry_the_sales_local_number(self):
		trimmed = invoices._trim_return_document(
			{"_original_invoice": {"name": "SINV-9", "posa_local_number": SALE_NUMBER}, "items": []}, {}
		)
		self.assertEqual(trimmed["_original_invoice"]["posa_local_number"], SALE_NUMBER)

	def test_the_return_check_answers_for_the_invoice_it_found(self):
		frappe.local.db.exists.return_value = True
		frappe.local.db.sql.return_value = [frappe._dict(pos_profile=None, posting_date="2026-11-09")]
		with patch("pos_next.api.invoices.resolve_invoice_name", return_value="SINV-9"):
			result = invoices.check_invoice_return_validity(SALE_NUMBER)
		self.assertEqual(result, {"valid": True, "invoice_name": "SINV-9"})
		self.assertIn("'SINV-9'", self._sql()[0])


class TestQueue(NoSiteTestCase):
	def _fields(self, payload, entity="invoice"):
		item = {"offline_id": "pos_offline_1", "entity": entity, "payload": payload, "client_totals": {}}
		with (
			patch("pos_next.services.sync_inbox._link_or_none", side_effect=lambda _doctype, name: name),
			patch("pos_next.services.sync_entities.get_record_shift", return_value=SHIFT),
			patch("pos_next.services.sync_inbox.now_datetime", return_value="2026-11-09 12:00:00"),
		):
			return sync_inbox._envelope_fields(item, "cashier@example.com", "dev-1", "1.0", 1)

	def test_a_record_keeps_the_number_of_its_invoice(self):
		self.assertEqual(self._fields({"posa_local_number": SALE_NUMBER})["posa_local_number"], SALE_NUMBER)

	def test_a_record_of_an_old_device_has_none(self):
		self.assertIsNone(self._fields({})["posa_local_number"])

	def test_only_an_invoice_record_has_one(self):
		self.assertIsNone(self._fields({"posa_local_number": SALE_NUMBER}, "payment")["posa_local_number"])

	def test_a_sale_made_online_records_its_number(self):
		frappe.local.db.exists.return_value = False
		document = Mock()
		with (
			patch("frappe.get_doc", return_value=document) as get_doc,
			patch("frappe.session", SimpleNamespace(user="cashier@example.com")),
			patch("pos_next.services.sync_inbox.now_datetime", return_value="2026-11-09 12:00:00"),
		):
			sync_inbox.record_direct_sync(
				"pos_offline_1",
				"SINV-1",
				"Sales Invoice",
				{"pos_profile": "Main", "posa_local_number": SALE_NUMBER},
			)
		self.assertEqual(get_doc.call_args.args[0]["posa_local_number"], SALE_NUMBER)
		document.insert.assert_called_once()
