# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Enrolling devices and signing cashiers in on them. See pos_next.auth."""

import hashlib
import json
import re
import secrets

import frappe
from frappe import _
from frappe.auth import validate_ip_address
from frappe.core.doctype.activity_log.activity_log import add_authentication_log
from frappe.rate_limiter import rate_limit
from frappe.twofactor import should_run_2fa
from frappe.utils import add_to_date, cint, cstr, now_datetime
from frappe.utils.password import check_password, get_decrypted_password, set_encrypted_password

from pos_next.auth import (
    clear_grant,
    hash_secret,
    is_expired,
    new_cashier_grant,
    new_device_token,
    require_device,
)
from pos_next.pos_next.doctype.pos_device.pos_device import CODE_ALPHABET

MANAGER_ROLES = ("Nexus POS Manager", "System Manager")
PLATFORMS = {"electron": "Electron", "android": "Android"}

ENROLLMENT_MINUTES = 15
ENROLLMENT_CODE_LENGTH = 10
DEVICE_TOKEN_DAYS = 365
GRANT_HOURS = 12
DEFAULT_MAX_OFFLINE_HOURS = 72

PIN_ITERATIONS = 100_000
PIN_FIELD = "pos_offline_pin"

_DEVICE_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
_PIN = re.compile(r"[0-9]{6,8}")


def _parse_list(value):
    return json.loads(value) if isinstance(value, str) else value or []


def _assert_manager():
    if not set(MANAGER_ROLES) & set(frappe.get_roles()):
        frappe.throw(_("Not permitted"), frappe.PermissionError)


def _normalize_code(code):
    return re.sub(r"[\s-]", "", cstr(code)).upper()


@frappe.whitelist(methods=["POST"])
def issue_enrollment_code(allowed_profiles=None):
    """Create a one-time code that enrolls one device.

    Args:
        allowed_profiles: POS Profiles the device may work with, as a list or JSON

    Returns:
        dict: The code, which is not stored and cannot be shown again, and its expiry
    """
    _assert_manager()

    profiles = _parse_list(allowed_profiles)
    if not profiles:
        frappe.throw(_("Choose at least one POS Profile for this device"))

    code = "".join(secrets.choice(CODE_ALPHABET) for _position in range(ENROLLMENT_CODE_LENGTH))
    expires_at = add_to_date(now_datetime(), minutes=ENROLLMENT_MINUTES)

    frappe.get_doc(
        {
            "doctype": "POS Enrollment Code",
            "code_hash": hash_secret(code),
            "expires_at": expires_at,
            "issued_by": frappe.session.user,
            "allowed_profiles": [{"pos_profile": profile} for profile in profiles],
        }
    ).insert(ignore_permissions=True)

    middle = ENROLLMENT_CODE_LENGTH // 2
    return {"code": f"{code[:middle]}-{code[middle:]}", "expires_at": expires_at}


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=30, seconds=60 * 60)
def enroll(enrollment_code=None, device_id=None, device_name=None, platform=None, app_version=None):
    """Exchange an enrollment code for a device token.

    Args:
        enrollment_code: The code from a manager
        device_id: The UUID the app created on first run
        device_name: A readable name for the device list
        platform: electron or android
        app_version: App version

    Returns:
        dict: The device token, which is shown this once, and the device's receipt code
    """
    if not _DEVICE_ID.fullmatch(cstr(device_id)) or platform not in PLATFORMS:
        frappe.throw(_("This app cannot be enrolled"))

    # The lock makes a second request with the same code wait, then see it used
    code = frappe.db.get_value(
        "POS Enrollment Code",
        {"code_hash": hash_secret(_normalize_code(enrollment_code))},
        ["name", "expires_at", "used_at"],
        as_dict=True,
        for_update=True,
    )
    if not code or code.used_at or is_expired(code.expires_at):
        frappe.throw(_("This enrollment code is not valid or has expired"), frappe.AuthenticationError)

    status = frappe.db.get_value("POS Device", device_id, "status")
    if status == "Revoked":
        frappe.throw(_("This device was revoked. A manager must reactivate it first."), frappe.PermissionError)

    device = frappe.get_doc("POS Device", device_id) if status else frappe.new_doc("POS Device")
    device.update(
        {
            "device_id": device_id,
            "device_name": cstr(device_name).strip()[:140] or device_id,
            "platform": PLATFORMS[platform],
            "app_version": cstr(app_version)[:140],
            "status": "Active",
        }
    )
    allowed = frappe.get_all(
        "POS Device Profile",
        filters={"parent": code.name, "parenttype": "POS Enrollment Code"},
        pluck="pos_profile",
    )
    device.set("allowed_profiles", [{"pos_profile": profile} for profile in allowed])
    device.save(ignore_permissions=True)

    now = now_datetime()
    token = new_device_token()
    token_expires = add_to_date(now, days=DEVICE_TOKEN_DAYS)
    clear_grant(device.name)
    frappe.db.set_value(
        "POS Device",
        device.name,
        {"token_hash": hash_secret(token), "token_expires": token_expires, "last_seen": now},
        update_modified=False,
    )
    frappe.db.set_value(
        "POS Enrollment Code", code.name, {"used_at": now, "device": device.name}, update_modified=False
    )

    return {
        "device_token": token,
        "device_code": device.device_code,
        "device_name": device.device_name,
        "token_expires": token_expires,
    }


@frappe.whitelist(allow_guest=True, xss_safe=True, methods=["POST"])
@rate_limit(limit=30, seconds=5 * 60)
def cashier_login(usr=None, pwd=None):
    """Sign a cashier in on an enrolled device.

    The device proves itself with the X-POS-Device-Token header. xss_safe keeps Frappe
    from escaping a guest's arguments, which would change a password holding < or &.

    Args:
        usr: User, as for a normal login
        pwd: Password

    Returns:
        dict: The cashier's identity and profiles, the grant for their requests, the
            data to check an offline PIN, and how long the device may stay offline
    """
    device = require_device()
    frappe.form_dict.pop("pwd", None)

    if frappe.get_system_settings("disable_user_pass_login"):
        frappe.throw(_("Login with username and password is not allowed."), frappe.AuthenticationError)

    user = _authenticate(usr, pwd)
    profiles = _cashier_profiles(device.name, user)
    if not profiles:
        frappe.throw(_("You are not assigned to a POS Profile allowed on this device"), frappe.PermissionError)

    now = now_datetime()
    grant = new_cashier_grant()
    grant_expires = add_to_date(now, hours=GRANT_HOURS)
    # A device that keeps signing cashiers in must not stop on an anniversary
    frappe.db.set_value(
        "POS Device",
        device.name,
        {
            "cashier": user,
            "grant_hash": hash_secret(grant),
            "grant_expires": grant_expires,
            "token_expires": add_to_date(now, days=DEVICE_TOKEN_DAYS),
            "last_seen": now,
        },
        update_modified=False,
    )
    add_authentication_log(_("{0} signed in on device {1}").format(user, device.device_code), user)

    identity = frappe.db.get_value("User", user, ["full_name", "user_image"], as_dict=True)
    return {
        "user": user,
        "full_name": identity.full_name,
        "user_image": identity.user_image,
        "profiles": profiles,
        "grant": grant,
        "grant_expires": grant_expires,
        "pin": _pin_verifier(user),
        "max_offline_hours": _max_offline_hours([profile.name for profile in profiles]),
        "device_code": device.device_code,
    }


@frappe.whitelist(methods=["POST"])
def cashier_logout():
    """End the current sign-in on the server, so the grant cannot be used again."""
    device = getattr(frappe.local, "pos_device", None)
    if device:
        clear_grant(device)


@frappe.whitelist(methods=["POST"])
@rate_limit(limit=10, seconds=60 * 60, ip_based=False, user_based=True)
def set_cashier_pin(pin=None, pwd=None):
    """Set the PIN that signs this cashier in while a device is offline.

    It asks for the password because a PIN outlives the sign-in: someone at an unattended
    till must not be able to choose a PIN that signs them in as this cashier later.

    Args:
        pin: The new PIN, 6 to 8 digits
        pwd: The cashier's password

    Returns:
        dict: The data the device needs to check this PIN offline
    """
    frappe.form_dict.pop("pwd", None)
    frappe.form_dict.pop("pin", None)

    pin = cstr(pin)
    user = frappe.session.user
    if not frappe.db.exists("POS Profile User", {"user": user}):
        frappe.throw(_("You are not assigned to a POS Profile"), frappe.PermissionError)

    if not _is_acceptable_pin(pin):
        frappe.throw(_("Choose 6 to 8 digits that do not repeat or run in order"))

    try:
        check_password(user, pwd)
    except frappe.AuthenticationError:
        # Not a 401: the app reads that as a rejected grant and signs the cashier out
        frappe.throw(_("Incorrect password"))

    verifier = _make_pin_verifier(pin)
    set_encrypted_password("User", user, json.dumps(verifier), PIN_FIELD)
    return {"pin": verifier}


@frappe.whitelist(methods=["POST"])
def revoke_device(device=None):
    """Stop a device at once. What it already uploaded stays on the server.

    Args:
        device: POS Device name
    """
    _assert_manager()

    doc = frappe.get_doc("POS Device", device)
    doc.status = "Revoked"
    doc.save(ignore_permissions=True)


def _authenticate(usr, pwd):
    """Everything a normal login checks, except starting a session."""
    login_manager = frappe.local.login_manager
    login_manager.run_trigger("before_login")
    login_manager.authenticate(user=usr, pwd=pwd)

    user = login_manager.user
    if user in frappe.STANDARD_USERS:
        frappe.throw(_("This account cannot sign in on a device"), frappe.AuthenticationError)
    if should_run_2fa(user):
        frappe.throw(
            _("Accounts with two-factor authentication cannot sign in on a device"),
            frappe.AuthenticationError,
        )
    if login_manager.force_user_to_reset_password():
        frappe.throw(_("Your password has expired. Change it in the browser first."), frappe.AuthenticationError)

    validate_ip_address(user)
    login_manager.validate_hour()
    login_manager.run_trigger("on_login")
    return user


def _cashier_profiles(device, user):
    """The cashier's POS Profiles that this device may work with."""
    allowed = frappe.get_all(
        "POS Device Profile", filters={"parent": device, "parenttype": "POS Device"}, pluck="pos_profile"
    )
    if not allowed:
        return []

    assigned = frappe.get_all(
        "POS Profile User",
        filters={"user": user, "parent": ["in", allowed], "parenttype": "POS Profile"},
        pluck="parent",
    )
    if not assigned:
        return []

    return frappe.get_all(
        "POS Profile",
        filters={"name": ["in", assigned], "disabled": 0},
        fields=["name", "company", "currency", "warehouse"],
        order_by="name",
    )


def _max_offline_hours(profiles):
    """The strictest limit, since the cashier may sell under any of these profiles."""
    hours = frappe.get_all(
        "POS Settings", filters={"pos_profile": ["in", profiles]}, pluck="max_offline_hours"
    )
    return min((cint(value) for value in hours if cint(value) > 0), default=DEFAULT_MAX_OFFLINE_HOURS)


def _is_acceptable_pin(pin):
    if not _PIN.fullmatch(pin):
        return False

    # One repeated step is 111111, 123456 or 654321
    return len({int(after) - int(before) for before, after in zip(pin, pin[1:])}) > 1


def _hash_pin(pin, salt, iterations):
    """Must match derivePinHash in POS/src/platform/offlinePin.js."""
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), iterations).hex()


def _make_pin_verifier(pin):
    salt = secrets.token_hex(16)
    return {"salt": salt, "hash": _hash_pin(pin, salt, PIN_ITERATIONS), "iterations": PIN_ITERATIONS}


def _pin_verifier(user):
    stored = get_decrypted_password("User", user, PIN_FIELD, raise_exception=False)
    return json.loads(stored) if stored else None
