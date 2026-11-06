# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Authenticates the desktop and Android apps, which have no cookies.

A device holds two secrets. The device token is long-lived, proves the device was
enrolled, and is sent only to sign a cashier in. The cashier grant is short-lived and
goes on every request as the bearer, so the server always knows who is working on the
device, and each request has that cashier's permissions and nothing more.

The device token cannot be the bearer: frappe.auth.validate_auth ends any request whose
bearer leaves the session as Guest, and cashier_login runs before there is a cashier.
"""

import hashlib
import secrets

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime

DEVICE_PREFIX = "posd_"
GRANT_PREFIX = "posg_"
DEVICE_TOKEN_HEADER = "X-POS-Device-Token"
LAST_SEEN_SECONDS = 300

_DEVICE_FIELDS = ("name", "device_code", "status", "token_expires", "cashier", "grant_expires")


class DeviceAccessError(frappe.AuthenticationError):
    """The device itself is refused, so a new sign-in would not help. The app reads this name."""


def hash_secret(value):
    """Tokens are random and long, so a fast hash is enough and they can be looked up by it."""
    return hashlib.sha256(value.encode()).hexdigest()


def new_device_token():
    return DEVICE_PREFIX + secrets.token_urlsafe(32)


def new_cashier_grant():
    return GRANT_PREFIX + secrets.token_urlsafe(32)


def is_expired(value):
    return not value or get_datetime(value) <= now_datetime()


def clear_grant(device):
    frappe.db.set_value(
        "POS Device",
        device,
        {"cashier": None, "grant_hash": None, "grant_expires": None},
        update_modified=False,
    )


def clear_device_access(device):
    """Revocation. The hashes go too, so reactivating cannot bring a leaked token back."""
    clear_grant(device)
    frappe.db.set_value(
        "POS Device", device, {"token_hash": None, "token_expires": None}, update_modified=False
    )


def require_device():
    """The enrolled device behind this request. Anything else is refused here.

    Returns:
        frappe._dict: The device's status and sign-in fields
    """
    token = frappe.get_request_header(DEVICE_TOKEN_HEADER) or ""
    device = None
    if token.startswith(DEVICE_PREFIX):
        device = _find_device("token_hash", token)

    if not _is_active(device):
        frappe.throw(
            _("This device is not enrolled. Ask a manager for a new enrollment code."),
            DeviceAccessError,
        )
    return device


def validate():
    """auth_hooks entry: turn a cashier grant into that cashier's session."""
    token = _bearer_token()
    if not token.startswith(GRANT_PREFIX):
        return

    device = _find_device("grant_hash", token)
    if not _grant_is_valid(device):
        raise frappe.AuthenticationError

    # set_user clears form_dict, and the request still needs it
    form_dict = frappe.local.form_dict
    frappe.set_user(device.cashier)
    frappe.local.form_dict = form_dict

    # Without this, Session.update writes the user's row after every request
    frappe.session.data.last_updated = now_datetime()

    frappe.local.pos_device = device.name
    _record_last_seen(device.name)


def _bearer_token():
    parts = frappe.get_request_header("Authorization", "").split(" ")
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else ""


def _find_device(hash_field, token):
    return frappe.db.get_value(
        "POS Device", {hash_field: hash_secret(token)}, list(_DEVICE_FIELDS), as_dict=True
    )


def _is_active(device):
    return bool(device) and device.status == "Active" and not is_expired(device.token_expires)


def _grant_is_valid(device):
    return (
        _is_active(device)
        and bool(device.cashier)
        and not is_expired(device.grant_expires)
        and bool(frappe.db.get_value("User", device.cashier, "enabled"))
    )


def _record_last_seen(device):
    key = f"pos_device_seen:{device}"
    if frappe.flags.read_only or frappe.cache.get_value(key, expires=True):
        return

    frappe.cache.set_value(key, 1, expires_in_sec=LAST_SEEN_SECONDS)
    frappe.request.after_response.add(lambda: _write_last_seen(device))


def _write_last_seen(device):
    frappe.db.set_value("POS Device", device, "last_seen", now_datetime(), update_modified=False)
    frappe.db.commit()
