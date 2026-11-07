# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Invoice sync API: the device pushes sales here and asks how they ended."""

import json
import time

import frappe
from frappe import _
from frappe.utils import cint

from pos_next.api.invoices import _assert_invoice_write_access
from pos_next.auth import assert_device_allows_profile
from pos_next.services import sync_inbox, sync_reconciliation, sync_void
from pos_next.services.sync_classifier import ReplacedByEditError
from pos_next.services.sync_entities import ENTITY_SHIFT_OPEN

PROTOCOL_VERSION = 1
MAX_BATCH_SIZE = 50
MANAGER_ROLES = ("Nexus POS Manager", "System Manager")
ITEM_SAVEPOINT = "pos_sync_item"

#: Server statuses as the device understands them
_CLIENT_STATUS = {
    "Received": "received",
    "Processing": "processing",
    "Retry Scheduled": "processing",
    "Blocked": "processing",
    "Needs Review": "needs_review",
    "Synced": "synced",
    "Resolved": "synced",
    "Voided": "voided",
}


def _parse_list(value):
    return json.loads(value) if isinstance(value, str) else value or []


def _assert_pos_user():
    """Open the sync API to POS users. What each of them may reach is checked per profile."""
    user = frappe.session.user
    if user == "Guest":
        frappe.throw(_("Please log in"), frappe.AuthenticationError)
    if frappe.db.exists("POS Profile User", {"user": user}) or frappe.has_permission("POS Profile", "write"):
        return
    frappe.throw(_("You are not assigned to a POS Profile"), frappe.PermissionError)


def _assert_profile_access(pos_profile):
    assert_device_allows_profile(pos_profile)
    _assert_invoice_write_access("Sales Invoice", pos_profile)


def _assert_may_upload(item):
    """Hold an item to the POS Profile it names. Its cashier is settled when it is stored."""
    _assert_profile_access(sync_inbox.get_item_profile(item))


def _clock_skew(device_time):
    """Seconds the device's clock is from the server's, or None when it did not say. Both are
    epoch based, so a device in another time zone is not off."""
    if not cint(device_time):
        return None
    return cint(cint(device_time) / 1000 - time.time())


def _rejected(item, message):
    return {
        "offline_id": item.get("offline_id") if isinstance(item, dict) else None,
        "status": "rejected",
        "message": message,
    }


def _discard_item(exc):
    """Undo a failed item, so the rest of the batch can still land.

    Returns:
        str: What to tell the device about this item
    """
    try:
        frappe.db.rollback(save_point=ITEM_SAVEPOINT)
    except Exception:
        # A deadlock ends the transaction and its savepoints. Earlier items have committed.
        frappe.db.rollback()

    frappe.clear_messages()
    if isinstance(exc, frappe.PermissionError):
        return str(exc)

    frappe.log_error(title="POS Sync Push Item")
    return _("The server could not store this record")


def _assert_manager():
    if not set(MANAGER_ROLES) & set(frappe.get_roles()):
        frappe.throw(_("Not permitted"), frappe.PermissionError)


def _recorded_device(claimed):
    """The device a batch is recorded under.

    A grant proves which device is sending, so what the body says does not count. Refusing
    instead would fail sales that are already paid for, over a label. A browser has no grant
    and names itself, but only a grant can speak for an enrolled device: without this, signing
    in with a cookie would get around the rule above.
    """
    device = getattr(frappe.local, "pos_device", None)
    if device:
        return device
    return None if claimed and frappe.db.exists("POS Device", claimed) else claimed


def _describe(row):
    """What the device needs to know about one record."""
    response = {
        "offline_id": row.offline_id,
        "status": _CLIENT_STATUS.get(row.status, "processing"),
        "server_status": row.status,
    }
    if row.sales_invoice:
        response["invoice"] = row.sales_invoice
        # A manager can link it to a colleague's shift, and the device must not sell into that
        if row.entity == ENTITY_SHIFT_OPEN:
            response["shift_user"] = frappe.db.get_value("POS Opening Shift", row.sales_invoice, "user")
    if row.status in ("Needs Review", "Retry Scheduled"):
        response["error_class"] = row.error_class
        response["error_code"] = row.error_code
        response["message"] = row.error_message
    return response


def store_item(item, uploader, device_id, client_version, protocol_version, clock_skew=None):
    """Check one item and store it, or settle its void. Whatever goes wrong stays with this item.

    Args:
        clock_skew: Seconds the sender's clock is off, None when it was not measured. Always
            ours, never what the item says

    Returns:
        tuple[str | None, dict | None]: The record's name, or what to tell the sender instead
    """
    problem = sync_inbox.validate_envelope(item)
    if problem:
        return None, _rejected(item, problem)

    try:
        # Not frappe.database.savepoint: ingest commits, and releasing one then raises
        frappe.db.savepoint(ITEM_SAVEPOINT)
        _assert_may_upload(item)
        item["clock_skew_seconds"] = clock_skew
        if item.get("void_reason"):
            row = sync_void.request_void(
                item, uploader, _assert_profile_access, device_id, client_version, protocol_version
            )
            return None, sync_void.describe_void(row)
        name, conflict = sync_inbox.ingest(item, uploader, device_id, client_version, protocol_version)
    except ReplacedByEditError as exc:
        return None, {"offline_id": item["offline_id"], "status": "conflict", "message": str(exc)}
    except Exception as exc:
        return None, _rejected(item, _discard_item(exc))

    if conflict:
        return None, {
            "offline_id": item["offline_id"],
            "status": "conflict",
            "message": "A different invoice was already stored under this offline_id",
        }

    return name, None


def enqueue_stored(names):
    """Hand stored records to the queue jobs of their POS Profiles."""
    for pos_profile in {frappe.db.get_value("Offline Invoice Sync", name, "pos_profile") for name in names}:
        sync_inbox.enqueue_processing(pos_profile)


@frappe.whitelist(methods=["POST"])
def push(items=None, device_id=None, client_version=None, protocol_version=PROTOCOL_VERSION, wait_for_result=0, device_time=None):
    """Store a batch of queued sales.

    Each item is committed on its own, so one bad invoice cannot lose the others.

    Args:
        items: Envelopes, as a list or JSON. One with void_reason asks to void its record
        device_id: The browser's own id. A device with a grant is known without it
        client_version: App version
        protocol_version: Envelope version
        wait_for_result: Process inside this request, for a cashier who is waiting
        device_time: The device's clock as it sent this, in milliseconds since the epoch

    Returns:
        dict: server_time and one result per item
    """
    _assert_pos_user()

    items = _parse_list(items)
    if len(items) > MAX_BATCH_SIZE:
        frappe.throw(_("A batch cannot have more than {0} invoices").format(MAX_BATCH_SIZE))

    wait = cint(wait_for_result)
    clock_skew = _clock_skew(device_time)
    uploader = frappe.session.user
    device_id = _recorded_device(device_id)
    results = []
    stored = []

    for item in items:
        name, answer = store_item(item, uploader, device_id, client_version, protocol_version, clock_skew)
        if answer:
            results.append(answer)
        else:
            stored.append(name)

    for name in stored:
        if wait:
            sync_inbox.process(name)
        results.append(_describe(frappe.db.get_value("Offline Invoice Sync", name, "*", as_dict=True)))

    if not wait:
        enqueue_stored(stored)

    return {"server_time": frappe.utils.now(), "results": results}


@frappe.whitelist()
def get_status(offline_ids=None):
    """Report how sales already handed to the server have ended.

    Args:
        offline_ids: Ids as a list or JSON

    Returns:
        list[dict]: One entry per known id
    """
    _assert_pos_user()

    offline_ids = _parse_list(offline_ids)[: MAX_BATCH_SIZE * 4]
    if not offline_ids:
        return []

    rows = frappe.get_all(
        "Offline Invoice Sync",
        filters={"offline_id": ["in", offline_ids]},
        fields=["offline_id", "entity", "status", "sales_invoice", "error_class", "error_code", "error_message"],
    )
    return [_describe(row) for row in rows]


# ---------------------------------------------------------------------------
# Sync center actions
# ---------------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
def reprocess(name, note=None):
    _assert_manager()
    return sync_inbox.reprocess(name, note)


@frappe.whitelist(methods=["POST"])
def reprocess_group(fingerprint):
    """Retry every invoice that failed the same way, once its cause is fixed."""
    _assert_manager()

    names = frappe.get_all(
        "Offline Invoice Sync",
        filters={"status": sync_inbox.REVIEW, "error_fingerprint": fingerprint},
        pluck="name",
        order_by="client_created_at asc",
        limit=200,
    )
    return [{"name": name, "status": sync_inbox.reprocess(name).status} for name in names]


@frappe.whitelist(methods=["POST"])
def apply_fix(name, fix, values=None):
    _assert_manager()
    values = json.loads(values) if isinstance(values, str) else values or {}
    return sync_inbox.apply_fix(name, fix, values).as_dict()


@frappe.whitelist(methods=["POST"])
def link_existing_invoice(name, invoice_name, doctype, note):
    _assert_manager()
    return sync_inbox.link_existing_invoice(name, invoice_name, doctype, note).as_dict()


@frappe.whitelist(methods=["POST"])
def void(name, note):
    _assert_manager()
    return sync_inbox.void(name, note).as_dict()


@frappe.whitelist()
def get_shift_reconciliation(name):
    """Which invoices of a shift closed offline reached the server."""
    _assert_manager()
    frappe.has_permission("Offline Invoice Sync", "read", doc=name, throw=True)
    return sync_reconciliation.get_shift_reconciliation(name)


@frappe.whitelist()
def get_center_summary():
    """Counts and failure groups for the sync center page."""
    _assert_manager()

    counts = frappe.get_all(
        "Offline Invoice Sync",
        fields=["status", {"COUNT": "name", "as": "count"}],
        group_by="status",
    )
    groups = frappe.get_all(
        "Offline Invoice Sync",
        filters={"status": sync_inbox.REVIEW},
        fields=[
            "error_fingerprint",
            "error_class",
            "error_code",
            {"MAX": "error_message", "as": "message"},
            {"COUNT": "name", "as": "count"},
            {"MIN": "client_created_at", "as": "oldest"},
        ],
        group_by="error_fingerprint, error_class, error_code",
        order_by="count desc",
        limit=100,
    )
    coupon_overruns = frappe.db.count("Offline Invoice Sync", {"coupon_overrun": ["is", "set"]})
    refused_voids = frappe.db.count("Offline Invoice Sync", {"error_code": sync_void.VOID_AFTER_POSTED})
    return {
        "counts": counts,
        "groups": groups,
        "coupon_overruns": coupon_overruns,
        "refused_voids": refused_voids,
    }
