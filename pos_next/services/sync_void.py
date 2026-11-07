# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""A device's request to void a record it queued.

The receipt may already be with the customer, and a push may have landed while its answer
was lost, so a void is never only local. The device keeps the record until the server
answers here, and the server keeps a record of the request. Where the POS Profile does not
allow voids it stores nothing: the void ends there, and the record goes up as usual.
"""

import frappe
from frappe import _
from frappe.utils import now_datetime

from pos_next.services import sync_inbox
from pos_next.services.sync_entities import DOCTYPE, ENTITY_SHIFT_CLOSE, ENTITY_SHIFT_OPEN

#: Marks a record that stands although its device asked to void it. A stable identifier:
#: the sync center, offline_invoice_sync.js and the device rely on it.
VOID_AFTER_POSTED = "VoidAfterPosted"

#: What a device hears where its POS Profile does not allow voids. A stable identifier: the
#: device gives the record back to the queue on it, and an import stores it as a sale.
VOID_REFUSED = "void_refused"

POSTED_STATES = ("Synced", "Resolved")


def _insert_unprocessed(item, fields):
    """Store a record the server never saw. Its status is settled before this commits.

    Returns:
        str: The record's name, also when another request stored it first
    """
    doc = frappe.get_doc({"doctype": DOCTYPE, "offline_id": item["offline_id"], "status": "Received", **fields})
    doc.flags.ignore_permissions = True
    doc.flags.ignore_links = True

    try:
        doc.insert()
    except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
        frappe.db.rollback()  # nosemgrep: another request stored it first
        return frappe.db.get_value(DOCTYPE, {"offline_id": item["offline_id"]})
    return doc.name


def _is_voiding_allowed(pos_profile):
    return frappe.db.get_value("POS Settings", {"pos_profile": pos_profile}, "allow_delete_offline_invoice")


def _stored_record(offline_id):
    return frappe.db.get_value(DOCTYPE, {"offline_id": offline_id}, ["name", "entity", "pos_profile"], as_dict=True)


def _get_refusing_profile(item, stored, assert_access):
    """Hold the request to the record itself, which may not be what the envelope claims.

    Args:
        item: The record's envelope
        stored: The record from _stored_record, if the server holds it
        assert_access: Raises unless they may work with the POS Profile it is given

    Returns:
        str | None: The POS Profile that does not allow this void. A push need not come from
            the app, so the setting cannot be left to the app.
    """
    if (stored.entity if stored else item.get("entity")) in (ENTITY_SHIFT_CLOSE, ENTITY_SHIFT_OPEN):
        frappe.throw(_("A shift cannot be voided from a device"), frappe.PermissionError)

    stored_profile = stored.pos_profile if stored else None
    if stored_profile:
        assert_access(stored_profile)

    for pos_profile in (sync_inbox.get_item_profile(item), stored_profile):
        if pos_profile and not _is_voiding_allowed(pos_profile):
            return pos_profile
    return None


def _flag_for_manager(row, reason, document):
    """A record stands against its device's wish, so a person decides what happens next."""
    if row.error_code == VOID_AFTER_POSTED:
        return

    message = _(
        "A device asked to void this, but {0} was already on the server, so it stands. Reason given: {1}"
    ).format(document, reason)
    frappe.db.set_value(DOCTYPE, row.name, {"error_code": VOID_AFTER_POSTED, "error_message": message})
    sync_inbox._log_attempt(row.name, "void refused", message=reason)
    sync_inbox._notify_managers(row.name, message)


def _void(row, item, fields, reason):
    """Void a record no job is working on. The caller holds its row lock."""
    # Crash safety, as in process: the document may exist while its status update was lost
    existing = sync_inbox._get_handler(row).find(row.offline_id)
    if existing:
        _flag_for_manager(sync_inbox._mark_synced(row.name, existing, "recovered"), reason, existing["name"])
        return

    values = {
        "status": "Voided",
        "next_retry_at": None,
        "processed_at": now_datetime(),
        "resolution": "Voided",
        "resolution_note": reason,
        "resolved_by": frappe.session.user,
        "resolved_at": now_datetime(),
    }
    if not row.payload:
        # This device holds the only copy, and it drops the record after this answer
        values = {**{key: value for key, value in fields.items() if not row.get(key)}, **values}

    frappe.db.set_value(DOCTYPE, {"name": row.name, "status": row.status}, values)
    if frappe.db.get_value(DOCTYPE, row.name, "status") != "Voided":
        return

    sync_inbox._log_attempt(row.name, "voided by device", message=reason)

    # Voiding an edit leaves the sale it replaced, which the device believes is gone
    if sync_inbox._get_edit_conflict(item):
        _flag_for_manager(row, reason, item["payload"]["edited_from"])


def request_void(item, uploaded_by, assert_access, device_id=None, client_version=None, protocol_version=1):
    """Settle a device's request to void a record, and keep what happened.

    Safe to repeat: the record says how the first request ended.

    Args:
        item: The record's envelope, with void_reason
        uploaded_by: Who is asking
        assert_access: Raises unless they may work with the POS Profile it is given
        device_id: The device asking
        client_version: App version
        protocol_version: Envelope version

    Returns:
        frappe._dict: The record, or a refusal that stands for it, for describe_void
    """
    reason = item["void_reason"].strip()
    fields = sync_inbox._envelope_fields(item, uploaded_by, device_id, client_version, protocol_version)

    stored = _stored_record(item["offline_id"])
    refusing_profile = _get_refusing_profile(item, stored, assert_access)

    if not refusing_profile and not stored:
        _insert_unprocessed(item, fields)
        # It may have lost to another request, and then the record is not what this one claims
        stored = _stored_record(item["offline_id"])
        refusing_profile = _get_refusing_profile(item, stored, assert_access)

    if refusing_profile:
        return frappe._dict(offline_id=item["offline_id"], refused_by=refusing_profile)

    name = stored.name

    # A plain read can answer from this transaction's snapshot, and a job may have moved on
    row = sync_inbox._lock(name)

    if row.status in POSTED_STATES:
        _flag_for_manager(row, reason, row.sales_invoice or row.offline_id)
    elif row.status not in ("Processing", "Voided"):
        _void(row, item, fields, reason)

    frappe.db.commit()  # nosemgrep: the device drops its record on this answer, so it must survive
    return frappe.db.get_value(DOCTYPE, name, "*", as_dict=True)


def describe_void(row):
    """What the device hears. Anything but voided, sale_stands or void_refused means ask
    again next sync."""
    if row.get("refused_by"):
        return {
            "offline_id": row.offline_id,
            "status": VOID_REFUSED,
            "message": _("Voiding queued records is turned off for POS Profile {0}").format(row.refused_by),
        }

    response = {"offline_id": row.offline_id, "server_status": row.status}
    if row.error_code == VOID_AFTER_POSTED:
        response.update(status="sale_stands", error_code=row.error_code, message=row.error_message)
        if row.sales_invoice:
            response["invoice"] = row.sales_invoice
    else:
        response["status"] = "voided" if row.status == "Voided" else "void_pending"
    return response
