# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""What a device said a closed shift sold, against what the server holds for that shift."""

import frappe
from frappe import _
from frappe.utils import create_batch

from pos_next.services.sync_entities import (
    DOCTYPE,
    ENTITY_INVOICE,
    ENTITY_SHIFT_CLOSE,
)

INVOICE_DOCTYPES = ("Sales Invoice", "POS Invoice")

#: Ids per query, so a very long manifest stays within what one statement should carry
MANIFEST_CHUNK = 1000

RECORD_FIELDS = ["name", "offline_id", "status", "sales_invoice", "invoice_doctype"]

STATE_MISSING = "missing"
STATE_REVIEW = "review"
STATE_PROCESSING = "processing"
STATE_VOIDED = "voided"
STATE_FINISHED = "finished"

STATES = (STATE_MISSING, STATE_REVIEW, STATE_PROCESSING, STATE_VOIDED, STATE_FINISHED)

_STATE_OF_STATUS = {
    "Needs Review": STATE_REVIEW,
    "Voided": STATE_VOIDED,
    "Synced": STATE_FINISHED,
    "Resolved": STATE_FINISHED,
}


def _get_manifest(row):
    return list(dict.fromkeys(line.strip() for line in (row.depends_on or "").splitlines() if line.strip()))


def _read_chunks(doctype, fieldname, values, fields, **filters):
    rows = []
    for chunk in create_batch(values, MANIFEST_CHUNK):
        rows += frappe.get_all(doctype, filters={fieldname: ["in", chunk], **filters}, fields=fields)
    return rows


def _read_invoices(offline_ids):
    """Find the invoices of sales whose record is gone. The invoice is what counts."""
    return {
        invoice.offline_id: {"invoice": invoice.name, "invoice_doctype": doctype}
        for doctype in INVOICE_DOCTYPES
        for invoice in _read_chunks(doctype, "offline_id", offline_ids, ["name", "offline_id"], docstatus=1)
    }


def _describe_record(row):
    return {
        "offline_id": row.offline_id,
        "state": _STATE_OF_STATUS.get(row.status, STATE_PROCESSING),
        "status": row.status,
        "record": row.name,
        "invoice": row.sales_invoice,
        "invoice_doctype": (row.invoice_doctype or "Sales Invoice") if row.sales_invoice else None,
    }


def _describe_invoice(offline_id, invoice):
    return {
        "offline_id": offline_id,
        "state": STATE_FINISHED,
        "status": None,
        "record": None,
        **invoice,
    }


def _describe_missing(offline_id):
    return {
        "offline_id": offline_id,
        "state": STATE_MISSING,
        "status": None,
        "record": None,
        "invoice": None,
        "invoice_doctype": None,
    }


def _get_manifest_entries(manifest):
    records = {row.offline_id: row for row in _read_chunks(DOCTYPE, "offline_id", manifest, RECORD_FIELDS)}
    invoices = _read_invoices([offline_id for offline_id in manifest if offline_id not in records])

    entries = []
    for offline_id in manifest:
        if offline_id in records:
            entries.append(_describe_record(records[offline_id]))
        elif offline_id in invoices:
            entries.append(_describe_invoice(offline_id, invoices[offline_id]))
        else:
            entries.append(_describe_missing(offline_id))
    return entries


def _get_extras(shift, entries):
    """What the server holds for a shift that the manifest does not name.

    The manifest holds what was in the device's queue, so a sale made online is one of these
    and is no fault. A sale made online also has no shift on its record, which is why the
    invoices are read as well. A hand-entered invoice linked to a manifest entry keeps its
    own offline_id, or none, so entries are matched by invoice as well as by id.
    """
    if not shift:
        return []

    in_manifest = {entry["offline_id"] for entry in entries}
    seen_invoices = {entry["invoice"] for entry in entries if entry["invoice"]}
    extras = {}

    records = frappe.get_all(DOCTYPE, filters={"shift": shift, "entity": ENTITY_INVOICE}, fields=RECORD_FIELDS)
    for row in records:
        if row.offline_id not in in_manifest and row.sales_invoice not in seen_invoices:
            extras[row.offline_id] = _describe_record(row)
            if row.sales_invoice:
                seen_invoices.add(row.sales_invoice)

    for doctype in INVOICE_DOCTYPES:
        invoices = frappe.get_all(
            doctype,
            filters={"posa_pos_opening_shift": shift, "docstatus": 1},
            fields=["name", "offline_id"],
        )
        for invoice in invoices:
            if invoice.offline_id not in in_manifest and invoice.name not in seen_invoices:
                key = invoice.offline_id or invoice.name
                extras[key] = _describe_invoice(
                    invoice.offline_id, {"invoice": invoice.name, "invoice_doctype": doctype}
                )

    return list(extras.values())


def get_shift_reconciliation(name):
    """Compare a shift close record's manifest with what reached the server.

    It reads only depends_on, which outlives the payload, so a record that retention has
    emptied can still be checked. The number of queries does not grow with each id.

    Args:
        name: Offline Invoice Sync record of a shift close

    Returns:
        dict: shift, counts, entries for the manifest in its order, and extras
    """
    row = frappe.db.get_value(DOCTYPE, name, ["entity", "shift", "depends_on"], as_dict=True)
    if not row or row.entity != ENTITY_SHIFT_CLOSE:
        frappe.throw(_("Only a shift close record has a list of its invoices"))

    entries = _get_manifest_entries(_get_manifest(row))
    extras = _get_extras(row.shift, entries)

    counts = dict.fromkeys(STATES, 0)
    for entry in entries:
        counts[entry["state"]] += 1

    return {
        "shift": row.shift,
        "counts": {**counts, "manifest": len(entries), "extra": len(extras)},
        "entries": entries,
        "extras": extras,
    }
