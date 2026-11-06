# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import hashlib
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe
from frappe.auth import validate_auth
from frappe.sessions import Session

from pos_next import auth

NOW = datetime(2026, 11, 6, 12, 0, 0)
LATER = NOW + timedelta(hours=1)
EARLIER = NOW - timedelta(hours=1)


def _device(**overrides):
    return frappe._dict(
        {
            "name": "device-1",
            "device_code": "ABCDE",
            "status": "Active",
            "token_expires": LATER,
            "cashier": "cashier@example.com",
            "grant_expires": LATER,
            **overrides,
        }
    )


def _raise(message, exc=frappe.ValidationError, **_kwargs):
    raise exc(message)


class NoSiteTestCase(unittest.TestCase):
    """Replace the helpers that need a site, so these run without a database."""

    def setUp(self):
        for target, replacement in (
            ("pos_next.auth.now_datetime", lambda: NOW),
            ("pos_next.auth.frappe.throw", _raise),
            ("pos_next.auth._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.headers = {}
        patcher = patch(
            "pos_next.auth.frappe.get_request_header",
            lambda key, default=None: self.headers.get(key, default),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        frappe.local.session = frappe._dict(user="Guest", data=frappe._dict())
        frappe.local.form_dict = frappe._dict(item="A")
        frappe.local.db = Mock()
        frappe.local.request = Mock()
        self.addCleanup(setattr, frappe.local, "session", None)
        self.addCleanup(setattr, frappe.local, "db", None)
        self.addCleanup(setattr, frappe.local, "request", None)
        self.addCleanup(setattr, frappe.local, "pos_device", None)


class TestSecrets(NoSiteTestCase):
    def test_hash_is_sha256_of_the_token(self):
        self.assertEqual(auth.hash_secret("abc"), hashlib.sha256(b"abc").hexdigest())

    def test_hash_does_not_contain_the_token(self):
        token = auth.new_device_token()
        self.assertNotIn(token, auth.hash_secret(token))

    def test_tokens_are_long_and_never_repeat(self):
        tokens = {auth.new_device_token() for _index in range(100)}
        self.assertEqual(len(tokens), 100)
        self.assertGreater(min(len(token) for token in tokens), 40)

    def test_device_token_is_never_mistaken_for_a_grant(self):
        self.assertFalse(auth.new_device_token().startswith(auth.GRANT_PREFIX))

    def test_expiry(self):
        self.assertTrue(auth.is_expired(EARLIER))
        self.assertTrue(auth.is_expired(NOW))
        self.assertFalse(auth.is_expired(LATER))

    def test_missing_expiry_counts_as_expired(self):
        self.assertTrue(auth.is_expired(None))


class TestRequireDevice(NoSiteTestCase):
    def _send(self, token):
        self.headers[auth.DEVICE_TOKEN_HEADER] = token

    def test_returns_an_active_device(self):
        frappe.local.db.get_value.return_value = _device()
        self._send("posd_token")

        self.assertEqual(auth.require_device().name, "device-1")

    def test_looks_up_only_the_hash(self):
        frappe.local.db.get_value.return_value = _device()
        self._send("posd_token")

        auth.require_device()

        filters = frappe.local.db.get_value.call_args.args[1]
        self.assertEqual(filters, {"token_hash": auth.hash_secret("posd_token")})

    def test_refuses_a_missing_token_without_asking_the_database(self):
        with self.assertRaises(auth.DeviceAccessError):
            auth.require_device()
        frappe.local.db.get_value.assert_not_called()

    def test_refuses_a_grant_used_as_a_device_token(self):
        self._send("posg_token")
        with self.assertRaises(auth.DeviceAccessError):
            auth.require_device()

    def test_refuses_an_unknown_token(self):
        frappe.local.db.get_value.return_value = None
        self._send("posd_token")
        with self.assertRaises(auth.DeviceAccessError):
            auth.require_device()

    def test_refuses_a_revoked_device(self):
        frappe.local.db.get_value.return_value = _device(status="Revoked")
        self._send("posd_token")
        with self.assertRaises(auth.DeviceAccessError):
            auth.require_device()

    def test_refuses_an_expired_token(self):
        frappe.local.db.get_value.return_value = _device(token_expires=EARLIER)
        self._send("posd_token")
        with self.assertRaises(auth.DeviceAccessError):
            auth.require_device()

    def test_refusal_is_a_401_the_app_can_tell_apart(self):
        self.assertEqual(auth.DeviceAccessError.http_status_code, 401)
        self.assertIsNot(auth.DeviceAccessError, frappe.AuthenticationError)


class TestValidate(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        for target in ("pos_next.auth.frappe.set_user", "pos_next.auth._record_last_seen"):
            patcher = patch(target)
            setattr(self, target.rsplit(".", 1)[1], patcher.start())
            self.addCleanup(patcher.stop)

    def _grant(self, device, enabled=1):
        self.headers["Authorization"] = "Bearer posg_token"
        frappe.local.db.get_value.side_effect = lambda doctype, *_args, **_kwargs: (
            device if doctype == "POS Device" else enabled
        )

    def test_ignores_a_request_without_a_bearer(self):
        auth.validate()

        self.set_user.assert_not_called()
        frappe.local.db.get_value.assert_not_called()

    def test_ignores_api_keys(self):
        self.headers["Authorization"] = "token key:secret"
        auth.validate()
        self.set_user.assert_not_called()

    def test_leaves_other_bearer_tokens_to_oauth(self):
        self.headers["Authorization"] = "Bearer oauth-token"
        auth.validate()
        self.set_user.assert_not_called()

    def test_a_device_token_alone_gives_no_user(self):
        self.headers["Authorization"] = "Bearer posd_token"
        auth.validate()

        self.set_user.assert_not_called()
        frappe.local.db.get_value.assert_not_called()

    def test_acts_as_the_cashier_of_the_grant(self):
        self._grant(_device())

        auth.validate()

        self.set_user.assert_called_once_with("cashier@example.com")
        self.assertEqual(frappe.local.pos_device, "device-1")

    def test_looks_up_only_the_hash(self):
        self._grant(_device())

        auth.validate()

        filters = frappe.local.db.get_value.call_args_list[0].args[1]
        self.assertEqual(filters, {"grant_hash": auth.hash_secret("posg_token")})

    def test_keeps_the_request_arguments(self):
        def clears_form_dict(_user):
            frappe.local.form_dict = frappe._dict()

        self.set_user.side_effect = clears_form_dict
        self._grant(_device())

        auth.validate()

        self.assertEqual(frappe.local.form_dict.item, "A")

    def test_stops_the_session_writing_the_user_on_every_request(self):
        self._grant(_device())

        auth.validate()

        self.assertEqual(frappe.session.data.last_updated, NOW)

    def test_records_last_seen(self):
        self._grant(_device())

        auth.validate()

        self._record_last_seen.assert_called_once_with("device-1")

    def _assert_refused(self):
        with self.assertRaises(frappe.AuthenticationError):
            auth.validate()
        self.set_user.assert_not_called()
        self.assertEqual(frappe.session.user, "Guest")

    def test_refuses_an_unknown_grant(self):
        self._grant(None)
        self._assert_refused()

    def test_refuses_a_revoked_device_at_once(self):
        self._grant(_device(status="Revoked"))
        self._assert_refused()

    def test_refuses_an_expired_device_token(self):
        self._grant(_device(token_expires=EARLIER))
        self._assert_refused()

    def test_refuses_an_expired_grant(self):
        self._grant(_device(grant_expires=EARLIER))
        self._assert_refused()

    def test_refuses_a_grant_without_a_cashier(self):
        self._grant(_device(cashier=None))
        self._assert_refused()

    def test_refuses_a_disabled_cashier(self):
        self._grant(_device(), enabled=0)
        self._assert_refused()

    def test_bearer_scheme_is_case_insensitive(self):
        self._grant(_device())
        self.headers["Authorization"] = "bearer posg_token"

        auth.validate()

        self.set_user.assert_called_once()


class TestThroughFrappeAuth(NoSiteTestCase):
    """The real frappe.auth.validate_auth with this hook, which the design depends on."""

    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, frappe.local, "login_manager", None)
        self.addCleanup(setattr, frappe.local, "flags", None)
        frappe.local.login_manager = Mock(user="Guest")
        # in_install keeps get_attr from asking the site which apps are installed
        frappe.local.flags = frappe._dict(in_install=True)
        frappe.local.request = Mock(
            url="https://shop.example.com/api/method/ping",
            method="GET",
            headers={},
            content_type=None,
            path="/api/method/ping",
        )
        frappe.local.request.get_data.return_value = b""
        frappe.local.db.get_value.side_effect = self._get_value
        self.device = _device()

        for target, replacement in (
            ("frappe.auth.validate_ip_address", Mock()),
            ("pos_next.auth._record_last_seen", Mock()),
            ("frappe.get_hooks", lambda *_args, **_kwargs: ["pos_next.auth.validate"]),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _get_value(self, doctype, *_args, **_kwargs):
        if doctype == "POS Device":
            return self.device
        return 1 if doctype == "User" else None

    def test_the_hook_is_registered(self):
        from pos_next import hooks

        self.assertIn("pos_next.auth.validate", hooks.auth_hooks)

    def test_a_grant_signs_the_request_in_as_the_cashier(self):
        self.headers["Authorization"] = "Bearer posg_token"

        validate_auth()

        self.assertEqual(frappe.session.user, "cashier@example.com")
        self.assertEqual(frappe.local.form_dict.item, "A")

    def test_a_device_token_as_bearer_is_ended_by_frappe(self):
        """Why cashier_login cannot read the device token from Authorization."""
        self.headers["Authorization"] = "Bearer posd_token"

        with self.assertRaises(frappe.AuthenticationError):
            validate_auth()

        self.assertEqual(frappe.session.user, "Guest")

    def test_the_device_token_header_leaves_guest_requests_alone(self):
        self.headers[auth.DEVICE_TOKEN_HEADER] = "posd_token"

        validate_auth()

        self.assertEqual(frappe.session.user, "Guest")

    def test_an_expired_grant_ends_the_request(self):
        self.device = _device(grant_expires=EARLIER)
        self.headers["Authorization"] = "Bearer posg_token"

        with self.assertRaises(frappe.AuthenticationError):
            validate_auth()

        self.assertEqual(frappe.session.user, "Guest")

    def test_a_cookie_session_is_not_disturbed_without_a_grant(self):
        frappe.local.session.user = "web@example.com"

        validate_auth()

        self.assertEqual(frappe.session.user, "web@example.com")

    def test_the_session_writes_nothing_after_a_device_request(self):
        self.headers["Authorization"] = "Bearer posg_token"
        validate_auth()

        session = Session.__new__(Session)
        session.data = frappe.local.session
        session.sid = "Guest"
        session._update_in_cache = False
        with (
            patch("frappe.utils.now_datetime", lambda: NOW),
            patch("frappe.sessions.get_expiry_in_seconds", return_value=3600),
            patch("frappe.sessions.update_user_metadata") as update_user_metadata,
        ):
            self.assertFalse(session.update())

        update_user_metadata.assert_not_called()


class TestLastSeen(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch("pos_next.auth.frappe.cache", Mock())
        self.cache = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch("pos_next.auth.frappe.flags", frappe._dict())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_writes_nothing_while_the_interval_runs(self):
        self.cache.get_value.return_value = 1

        auth._record_last_seen("device-1")

        frappe.local.request.after_response.add.assert_not_called()

    def test_writes_once_after_the_response_when_due(self):
        self.cache.get_value.return_value = None

        auth._record_last_seen("device-1")

        self.cache.set_value.assert_called_once_with(
            "pos_device_seen:device-1", 1, expires_in_sec=auth.LAST_SEEN_SECONDS
        )
        frappe.local.request.after_response.add.assert_called_once()
        frappe.local.db.set_value.assert_not_called()

        frappe.local.request.after_response.add.call_args.args[0]()

        frappe.local.db.set_value.assert_called_once_with(
            "POS Device", "device-1", "last_seen", NOW, update_modified=False
        )
        frappe.local.db.commit.assert_called_once()

    def test_writes_nothing_on_a_read_only_site(self):
        frappe.flags.read_only = True
        self.cache.get_value.return_value = None

        auth._record_last_seen("device-1")

        frappe.local.request.after_response.add.assert_not_called()


class TestClearingAccess(NoSiteTestCase):
    def _written(self):
        fields = {}
        for call in frappe.local.db.set_value.call_args_list:
            fields.update(call.args[2])
        return fields

    def test_clear_grant_keeps_the_device_token(self):
        auth.clear_grant("device-1")

        self.assertEqual(self._written(), {"cashier": None, "grant_hash": None, "grant_expires": None})

    def test_revocation_removes_every_credential(self):
        auth.clear_device_access("device-1")

        self.assertEqual(
            self._written(),
            {
                "cashier": None,
                "grant_hash": None,
                "grant_expires": None,
                "token_hash": None,
                "token_expires": None,
            },
        )


class TestDeviceProfiles(NoSiteTestCase):
    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, frappe.local, "pos_device", None)

    @patch("pos_next.auth.frappe.get_all")
    def test_a_browser_has_no_list_to_check(self, get_all):
        frappe.local.pos_device = None
        auth.assert_device_allows_profile("Main")
        get_all.assert_not_called()

    @patch("pos_next.auth.frappe.get_all", return_value=["Main"])
    def test_a_profile_on_the_list_passes(self, get_all):
        frappe.local.pos_device = "device-1"

        auth.assert_device_allows_profile("Main")

        self.assertEqual(get_all.call_args.kwargs["filters"], {"parent": "device-1", "parenttype": "POS Device"})

    @patch("pos_next.auth.frappe.get_all", return_value=["Main"])
    def test_a_profile_taken_off_the_list_is_refused(self, _get_all):
        frappe.local.pos_device = "device-1"
        with self.assertRaises(frappe.PermissionError):
            auth.assert_device_allows_profile("Other")


if __name__ == "__main__":
    unittest.main()
