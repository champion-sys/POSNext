# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import re
import unittest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, Mock, patch

import frappe

from pos_next import auth
from pos_next.api import device as api
from pos_next.pos_next.doctype.pos_device.pos_device import POSDevice

NOW = datetime(2026, 11, 6, 12, 0, 0)
LATER = NOW + timedelta(minutes=5)
EARLIER = NOW - timedelta(minutes=5)

#: Shared with the Vitest suite, so both ends are proven to derive the same hash
PIN_VECTOR = {
    "pin": "482915",
    "salt": "00112233445566778899aabbccddeeff",
    "iterations": 1000,
    "hash": "f9b42b8f13bdd376be45ffd3d89a6449f121a8ebd055d4bce84f25a68e1415ce",
}


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class NoSiteTestCase(unittest.TestCase):
    """Replace the helpers that need a site, so these run without a database."""

    def setUp(self):
        for target, replacement in (
            ("pos_next.api.device.now_datetime", lambda: NOW),
            ("pos_next.auth.now_datetime", lambda: NOW),
            ("pos_next.api.device.frappe.throw", _raise),
            ("pos_next.auth.frappe.throw", _raise),
            ("pos_next.api.device._", lambda text: text),
            ("pos_next.auth._", lambda text: text),
            ("pos_next.api.device.add_to_date", self._add_to_date),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        frappe.local.session = frappe._dict(user="manager@example.com")
        frappe.local.form_dict = frappe._dict()
        frappe.local.db = Mock()
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)

    @staticmethod
    def _add_to_date(date, **delta):
        return date + timedelta(**delta)

    def _patch(self, target, **kwargs):
        patcher = patch(target, **kwargs)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def _written(self, doctype=None):
        fields = {}
        for call in frappe.local.db.set_value.call_args_list:
            if doctype is None or call.args[0] == doctype:
                fields.update(call.args[2])
        return fields


class TestIssueEnrollmentCode(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.get_roles = self._patch(
            "pos_next.api.device.frappe.get_roles", return_value=["Nexus POS Manager"]
        )
        self.get_doc = self._patch("pos_next.api.device.frappe.get_doc")

    def test_refuses_anyone_but_a_manager(self):
        self.get_roles.return_value = ["POSNext Cashier"]

        with self.assertRaises(frappe.PermissionError):
            api.issue_enrollment_code(["Main"])
        self.get_doc.assert_not_called()

    def test_requires_a_profile(self):
        with self.assertRaises(frappe.ValidationError):
            api.issue_enrollment_code([])

    def test_stores_the_hash_and_never_the_code(self):
        result = api.issue_enrollment_code(["Main"])

        stored = self.get_doc.call_args.args[0]
        raw_code = result["code"].replace("-", "")
        self.assertEqual(stored["code_hash"], auth.hash_secret(raw_code))
        self.assertNotIn(raw_code, json.dumps(stored, default=str))
        self.assertNotIn(result["code"], json.dumps(stored, default=str))

    def test_code_is_short_lived_and_keeps_the_profiles(self):
        result = api.issue_enrollment_code(json.dumps(["Main", "Branch"]))

        stored = self.get_doc.call_args.args[0]
        self.assertEqual(stored["expires_at"], NOW + timedelta(minutes=api.ENROLLMENT_MINUTES))
        self.assertEqual(result["expires_at"], stored["expires_at"])
        self.assertEqual(
            stored["allowed_profiles"], [{"pos_profile": "Main"}, {"pos_profile": "Branch"}]
        )

    def test_code_can_be_read_aloud(self):
        code = api.issue_enrollment_code(["Main"])["code"]
        self.assertRegex(code, r"^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$")


class TestEnroll(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.code = frappe._dict(name="code-1", expires_at=LATER, used_at=None)
        self.device_status = None
        frappe.local.db.get_value.side_effect = self._get_value
        self.document = MagicMock(device_code="ABCDE", device_name="Till 1")
        self.document.name = "device-id-1"
        self._patch("pos_next.api.device.frappe.new_doc", return_value=self.document)
        self.get_doc = self._patch("pos_next.api.device.frappe.get_doc", return_value=self.document)
        self._patch("pos_next.api.device.frappe.get_all", return_value=["Main"])

    def _get_value(self, doctype, *_args, **_kwargs):
        return self.code if doctype == "POS Enrollment Code" else self.device_status

    def _enroll(self, **overrides):
        args = {
            "enrollment_code": "abcde-fghjk",
            "device_id": "device-id-1",
            "device_name": "Till 1",
            "platform": "electron",
            "app_version": "1.0",
            **overrides,
        }
        return api.enroll(**args)

    def _assert_refused(self, exc=frappe.AuthenticationError):
        with self.assertRaises(exc):
            self._enroll()
        self.assertNotIn("used_at", self._written("POS Enrollment Code"))
        self.assertNotIn("token_hash", self._written("POS Device"))

    def test_refuses_an_unknown_code(self):
        self.code = None
        self._assert_refused()

    def test_refuses_an_expired_code(self):
        self.code.expires_at = EARLIER
        self._assert_refused()

    def test_refuses_a_used_code(self):
        self.code.used_at = EARLIER
        self._assert_refused()

    def test_every_bad_code_reads_the_same(self):
        messages = set()
        for code in (None, frappe._dict(expires_at=EARLIER, used_at=None), frappe._dict(expires_at=LATER, used_at=NOW)):
            self.code = code
            try:
                self._enroll()
            except frappe.AuthenticationError as error:
                messages.add(str(error))
        self.assertEqual(len(messages), 1)

    def test_refuses_a_revoked_device_and_keeps_the_code(self):
        self.device_status = "Revoked"
        self._assert_refused(frappe.PermissionError)

    def test_refuses_a_bad_device_id(self):
        with self.assertRaises(frappe.ValidationError):
            self._enroll(device_id="short")
        with self.assertRaises(frappe.ValidationError):
            self._enroll(device_id="has spaces in it")

    def test_refuses_an_unknown_platform(self):
        with self.assertRaises(frappe.ValidationError):
            self._enroll(platform="ios")

    def test_locks_the_code_row(self):
        self._enroll()

        call = frappe.local.db.get_value.call_args_list[0]
        self.assertEqual(call.args[0], "POS Enrollment Code")
        self.assertTrue(call.kwargs["for_update"])

    def test_normalizes_how_the_code_was_typed(self):
        self._enroll(enrollment_code=" abcde-fghjk ")

        filters = frappe.local.db.get_value.call_args_list[0].args[1]
        self.assertEqual(filters, {"code_hash": auth.hash_secret("ABCDEFGHJK")})

    def test_returns_the_token_and_stores_only_its_hash(self):
        result = self._enroll()

        token = result["device_token"]
        self.assertTrue(token.startswith(auth.DEVICE_PREFIX))
        stored = self._written("POS Device")
        self.assertEqual(stored["token_hash"], auth.hash_secret(token))
        self.assertNotIn(token, json.dumps(stored, default=str))
        self.assertEqual(stored["token_expires"], NOW + timedelta(days=api.DEVICE_TOKEN_DAYS))

    def test_the_code_works_once(self):
        self._enroll()
        written = self._written("POS Enrollment Code")
        self.assertEqual(written, {"used_at": NOW, "device": "device-id-1"})

        self.code.used_at = written["used_at"]
        with self.assertRaises(frappe.AuthenticationError):
            self._enroll()

    def test_device_gets_the_profiles_of_the_code(self):
        self._enroll()

        self.document.set.assert_called_once_with("allowed_profiles", [{"pos_profile": "Main"}])
        self.document.save.assert_called_once_with(ignore_permissions=True)

    def test_new_device_is_created(self):
        self._enroll()
        self.get_doc.assert_not_called()

    def test_enrolling_again_replaces_the_token_and_ends_the_sign_in(self):
        self.device_status = "Active"

        self._enroll()

        self.get_doc.assert_called_once_with("POS Device", "device-id-1")
        stored = self._written("POS Device")
        self.assertIsNone(stored["grant_hash"])
        self.assertIsNone(stored["cashier"])


class TestCashierLogin(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.device = frappe._dict(name="device-1", device_code="ABCDE")
        self.require_device = self._patch(
            "pos_next.api.device.require_device", return_value=self.device
        )
        frappe.local.login_manager = MagicMock(user="cashier@example.com")
        frappe.local.login_manager.force_user_to_reset_password.return_value = False
        self.addCleanup(setattr, frappe.local, "login_manager", None)
        self._patch("pos_next.api.device.frappe.get_system_settings", return_value=0)
        self.two_factor = self._patch("pos_next.api.device.should_run_2fa", return_value=False)
        self.check_ip = self._patch("pos_next.api.device.validate_ip_address")
        self.log = self._patch("pos_next.api.device.add_authentication_log")
        self.verifier = self._patch("pos_next.api.device.get_decrypted_password", return_value=None)
        self.profile = frappe._dict(name="Main", company="Co", currency="SAR", warehouse="Stores")
        self.tables = {
            "POS Device Profile": ["Main", "Branch"],
            "POS Profile User": ["Main"],
            "POS Profile": [self.profile],
            "POS Settings": [0],
        }
        self.get_all = self._patch(
            "pos_next.api.device.frappe.get_all",
            side_effect=lambda doctype, **_kwargs: self.tables[doctype],
        )
        frappe.local.db.get_value.return_value = frappe._dict(full_name="A Cashier", user_image="/a.png")

    def _assert_no_grant(self):
        self.assertNotIn("grant_hash", self._written("POS Device"))

    def test_refuses_without_a_device_before_touching_the_password(self):
        self.require_device.side_effect = auth.DeviceAccessError("no")

        with self.assertRaises(auth.DeviceAccessError):
            api.cashier_login("cashier@example.com", "secret")

        frappe.local.login_manager.authenticate.assert_not_called()
        self._assert_no_grant()

    def test_wrong_password_gives_no_grant(self):
        frappe.local.login_manager.authenticate.side_effect = frappe.AuthenticationError

        with self.assertRaises(frappe.AuthenticationError):
            api.cashier_login("cashier@example.com", "wrong")

        self._assert_no_grant()

    def test_uses_the_framework_login_checks(self):
        api.cashier_login("cashier@example.com", "secret")

        manager = frappe.local.login_manager
        manager.authenticate.assert_called_once_with(user="cashier@example.com", pwd="secret")
        manager.validate_hour.assert_called_once()
        self.check_ip.assert_called_once_with("cashier@example.com")

    def test_password_leaves_the_request_arguments(self):
        frappe.local.form_dict.pwd = "secret"

        api.cashier_login("cashier@example.com", "secret")

        self.assertNotIn("pwd", frappe.local.form_dict)

    def test_refuses_when_password_login_is_disabled(self):
        frappe.get_system_settings.return_value = 1

        with self.assertRaises(frappe.AuthenticationError):
            api.cashier_login("cashier@example.com", "secret")
        frappe.local.login_manager.authenticate.assert_not_called()

    def test_refuses_standard_users(self):
        frappe.local.login_manager.user = "Administrator"

        with self.assertRaises(frappe.AuthenticationError):
            api.cashier_login("Administrator", "secret")
        self._assert_no_grant()

    def test_refuses_accounts_with_two_factor(self):
        self.two_factor.return_value = True

        with self.assertRaises(frappe.AuthenticationError):
            api.cashier_login("cashier@example.com", "secret")
        self._assert_no_grant()

    def test_refuses_an_expired_password(self):
        frappe.local.login_manager.force_user_to_reset_password.return_value = True

        with self.assertRaises(frappe.AuthenticationError):
            api.cashier_login("cashier@example.com", "secret")
        self._assert_no_grant()

    def test_refuses_a_user_outside_the_allowed_profiles(self):
        self.tables["POS Profile User"] = []

        with self.assertRaises(frappe.PermissionError):
            api.cashier_login("cashier@example.com", "secret")
        self._assert_no_grant()

    def test_refuses_a_device_with_no_allowed_profiles(self):
        self.tables["POS Device Profile"] = []

        with self.assertRaises(frappe.PermissionError):
            api.cashier_login("cashier@example.com", "secret")
        self._assert_no_grant()

    def test_only_a_profile_allowed_on_this_device_counts(self):
        api.cashier_login("cashier@example.com", "secret")

        calls = {call.args[0]: call.kwargs["filters"] for call in self.get_all.call_args_list}
        self.assertEqual(calls["POS Profile User"]["parent"], ["in", ["Main", "Branch"]])
        self.assertEqual(calls["POS Profile"]["name"], ["in", ["Main"]])
        self.assertEqual(calls["POS Profile"]["disabled"], 0)

    def test_returns_identity_profiles_and_grant(self):
        result = api.cashier_login("cashier@example.com", "secret")

        self.assertEqual(result["user"], "cashier@example.com")
        self.assertEqual(result["full_name"], "A Cashier")
        self.assertEqual(result["user_image"], "/a.png")
        self.assertEqual(result["profiles"], [self.profile])
        self.assertEqual(result["device_code"], "ABCDE")
        self.assertIsNone(result["pin"])

    def test_stores_the_grant_as_a_hash_tied_to_the_cashier(self):
        result = api.cashier_login("cashier@example.com", "secret")

        stored = self._written("POS Device")
        self.assertTrue(result["grant"].startswith(auth.GRANT_PREFIX))
        self.assertEqual(stored["grant_hash"], auth.hash_secret(result["grant"]))
        self.assertEqual(stored["cashier"], "cashier@example.com")
        self.assertNotIn(result["grant"], json.dumps(stored, default=str))

    def test_grant_is_short_lived(self):
        api.cashier_login("cashier@example.com", "secret")

        self.assertEqual(self._written("POS Device")["grant_expires"], NOW + timedelta(hours=api.GRANT_HOURS))

    def test_a_working_device_keeps_its_token_alive(self):
        api.cashier_login("cashier@example.com", "secret")

        self.assertEqual(
            self._written("POS Device")["token_expires"], NOW + timedelta(days=api.DEVICE_TOKEN_DAYS)
        )

    def test_returns_the_pin_verifier(self):
        verifier = {"salt": "aa", "hash": "bb", "iterations": 1000}
        self.verifier.return_value = json.dumps(verifier)

        self.assertEqual(api.cashier_login("cashier@example.com", "secret")["pin"], verifier)

    def test_sign_in_is_logged(self):
        api.cashier_login("cashier@example.com", "secret")
        self.log.assert_called_once()

    def test_default_offline_period(self):
        result = api.cashier_login("cashier@example.com", "secret")
        self.assertEqual(result["max_offline_hours"], api.DEFAULT_MAX_OFFLINE_HOURS)

    def test_strictest_offline_period_applies(self):
        self.tables["POS Settings"] = [48, 0, 24]

        result = api.cashier_login("cashier@example.com", "secret")

        self.assertEqual(result["max_offline_hours"], 24)


class TestCashierLogout(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, frappe.local, "pos_device", None)

    def test_ends_the_grant_of_this_device(self):
        frappe.local.pos_device = "device-1"

        api.cashier_logout()

        self.assertEqual(
            self._written("POS Device"), {"cashier": None, "grant_hash": None, "grant_expires": None}
        )

    def test_does_nothing_for_a_browser_session(self):
        api.cashier_logout()
        frappe.local.db.set_value.assert_not_called()


class TestSetCashierPin(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        frappe.local.session.user = "cashier@example.com"
        frappe.local.db.exists.return_value = "row-1"
        self.check_password = self._patch("pos_next.api.device.check_password")
        self.store = self._patch("pos_next.api.device.set_encrypted_password")

    def test_refuses_a_user_without_a_profile(self):
        frappe.local.db.exists.return_value = None

        with self.assertRaises(frappe.PermissionError):
            api.set_cashier_pin("482915", "secret")
        self.store.assert_not_called()

    def test_refuses_weak_or_malformed_pins(self):
        for pin in ("1234", "111111", "123456", "654321", "12345678", "12a456", "", None, "123456789"):
            with self.subTest(pin=pin), self.assertRaises(frappe.ValidationError):
                api.set_cashier_pin(pin, "secret")
        self.store.assert_not_called()

    def test_wrong_password_is_not_a_401(self):
        self.check_password.side_effect = frappe.AuthenticationError

        with self.assertRaises(frappe.ValidationError) as caught:
            api.set_cashier_pin("482915", "wrong")

        self.assertNotIsInstance(caught.exception, frappe.AuthenticationError)
        self.store.assert_not_called()

    def test_stores_a_verifier_and_never_the_pin(self):
        result = api.set_cashier_pin("482915", "secret")

        doctype, user, stored, field = self.store.call_args.args
        self.assertEqual((doctype, user, field), ("User", "cashier@example.com", api.PIN_FIELD))
        self.assertNotIn("482915", stored)
        self.assertEqual(json.loads(stored), result["pin"])

    def test_verifier_matches_the_pin_with_a_fresh_salt(self):
        first = api.set_cashier_pin("482915", "secret")["pin"]
        second = api.set_cashier_pin("482915", "secret")["pin"]

        self.assertNotEqual(first["salt"], second["salt"])
        self.assertEqual(first["iterations"], api.PIN_ITERATIONS)
        self.assertEqual(api._hash_pin("482915", first["salt"], first["iterations"]), first["hash"])

    def test_secrets_leave_the_request_arguments(self):
        frappe.local.form_dict.update(pin="482915", pwd="secret")

        api.set_cashier_pin("482915", "secret")

        self.assertEqual(frappe.local.form_dict, {})

    def test_derives_the_same_hash_as_the_app(self):
        self.assertEqual(
            api._hash_pin(PIN_VECTOR["pin"], PIN_VECTOR["salt"], PIN_VECTOR["iterations"]),
            PIN_VECTOR["hash"],
        )


class TestRevokeDevice(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.get_roles = self._patch(
            "pos_next.api.device.frappe.get_roles", return_value=["System Manager"]
        )
        self.get_doc = self._patch("pos_next.api.device.frappe.get_doc")

    def test_refuses_anyone_but_a_manager(self):
        self.get_roles.return_value = ["POSNext Cashier"]

        with self.assertRaises(frappe.PermissionError):
            api.revoke_device("device-1")
        self.get_doc.assert_not_called()

    def test_marks_the_device_revoked(self):
        api.revoke_device("device-1")

        document = self.get_doc.return_value
        self.assertEqual(document.status, "Revoked")
        document.save.assert_called_once_with(ignore_permissions=True)


class TestPOSDevice(NoSiteTestCase):
    @staticmethod
    def _document(**fields):
        document = POSDevice.__new__(POSDevice)
        document.__dict__.update(fields)
        return document

    def test_revoking_from_the_form_removes_every_credential(self):
        document = self._document(name="device-1", status="Revoked")

        document.on_update()

        self.assertIsNone(self._written("POS Device")["token_hash"])
        self.assertIsNone(self._written("POS Device")["grant_hash"])

    def test_saving_an_active_device_keeps_its_credentials(self):
        self._document(name="device-1", status="Active").on_update()
        frappe.local.db.set_value.assert_not_called()

    def test_gets_a_short_receipt_code(self):
        frappe.local.db.exists.return_value = None
        document = self._document(device_code=None)

        document.before_insert()

        self.assertTrue(re.fullmatch(r"[A-HJ-NP-Z2-9]{5}", document.device_code))

    def test_receipt_code_skips_one_in_use(self):
        frappe.local.db.exists.side_effect = ["taken", None]
        document = self._document(device_code=None)

        document.before_insert()

        self.assertEqual(frappe.local.db.exists.call_count, 2)


class TestEndpointRegistration(unittest.TestCase):
    def test_only_enrolling_and_signing_in_are_open_to_guests(self):
        for method in (api.enroll, api.cashier_login):
            self.assertIn(method, frappe.guest_methods)
        for method in (
            api.issue_enrollment_code,
            api.cashier_logout,
            api.set_cashier_pin,
            api.revoke_device,
        ):
            self.assertNotIn(method, frappe.guest_methods)

    def test_a_password_with_html_characters_reaches_the_check_unescaped(self):
        """Frappe escapes a guest's arguments, which would break a password holding < or &."""
        self.assertIn(api.cashier_login, frappe.xss_safe_methods)

    def test_a_guest_device_name_is_still_escaped(self):
        self.assertNotIn(api.enroll, frappe.xss_safe_methods)

    def test_every_endpoint_takes_post_only(self):
        for method in (
            api.issue_enrollment_code,
            api.enroll,
            api.cashier_login,
            api.cashier_logout,
            api.set_cashier_pin,
            api.revoke_device,
        ):
            self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[method], ["POST"])


class TestDocTypeDefinitions(unittest.TestCase):
    @staticmethod
    def _definition(name):
        folder = frappe.scrub(name)
        base = __file__.rsplit("/api/", 1)[0]
        with open(f"{base}/pos_next/doctype/{folder}/{folder}.json") as definition:
            return json.load(definition)

    def test_only_managers_reach_devices_and_codes(self):
        for name in ("POS Device", "POS Enrollment Code"):
            roles = {row["role"] for row in self._definition(name)["permissions"]}
            self.assertEqual(roles, {"System Manager", "Nexus POS Manager"})

    def test_hashes_are_hidden_above_every_role(self):
        for name, fieldnames in (
            ("POS Device", ("token_hash", "grant_hash")),
            ("POS Enrollment Code", ("code_hash",)),
        ):
            fields = {field["fieldname"]: field for field in self._definition(name)["fields"]}
            for fieldname in fieldnames:
                self.assertEqual(fields[fieldname]["permlevel"], 1)
                self.assertEqual(fields[fieldname]["hidden"], 1)
                self.assertEqual(fields[fieldname]["unique"], 1)

    def test_field_order_lists_every_field(self):
        for name in ("POS Device", "POS Device Profile", "POS Enrollment Code"):
            definition = self._definition(name)
            self.assertEqual(
                definition["field_order"], [field["fieldname"] for field in definition["fields"]]
            )


if __name__ == "__main__":
    unittest.main()
