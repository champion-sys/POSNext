# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Erase what devices sent once a finished record has been kept long enough.

Nothing goes until POS Settings names a period. The row, its hash, its amounts and its
attempt log stay for audit, and depends_on stays so a shift can still be reconciled.
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, now_datetime

from pos_next.services.sync_entities import DOCTYPE, FINAL_STATES

ATTEMPT_DOCTYPE = "Offline Invoice Sync Attempt"

BATCH_SIZE = 500

OUTCOME_CLEARED = "payload cleared"


def is_cleared(row):
    """Whether retention emptied this record.

    A record stored without a payload has no hash either, and the original payload of any
    other record cannot be changed, so nothing else looks like this.
    """
    return bool(row.payload_hash and not row.original_payload)


def assert_not_cleared(row):
    if is_cleared(row):
        frappe.throw(
            _("The payload of this record was erased when its retention period ended, so it cannot be changed.")
        )


def clear_old_payloads():
    """Apply each POS Profile's retention period. Runs every day.

    A record with no POS Profile has no period, so it stays as it is. A run cut short loses
    nothing: batches already committed stay done, and the next run takes the rest.
    """
    settings = frappe.get_all(
        "POS Settings",
        filters={"sync_payload_retention_days": [">", 0]},
        fields=["pos_profile", "sync_payload_retention_days"],
    )
    for row in settings:
        try:
            _clear_profile(row.pos_profile, cint(row.sync_payload_retention_days))
        except Exception:
            frappe.db.rollback()  # nosemgrep: batches before this one are already committed
            frappe.log_error(title="POS Sync Payload Retention")
            frappe.db.commit()  # nosemgrep: keep the error for whoever looks into it


def _clear_profile(pos_profile, days):
    cutoff = add_days(now_datetime(), -days)
    start = None

    while batch := _find_expired(pos_profile, cutoff, start):
        names = [row.name for row in batch]
        frappe.db.set_value(
            DOCTYPE,
            {"name": ["in", names], "status": ["in", FINAL_STATES]},
            {"payload": None, "original_payload": None},
            update_modified=False,
        )
        _log_clearing(names, days)
        frappe.db.commit()  # nosemgrep: a batch boundary, so no run holds its locks for long
        start = batch[-1].creation


def _find_expired(pos_profile, cutoff, start):
    """Read a batch of finished records past the period, oldest first.

    modified is when a record last moved, so one that waited weeks in review gets its full
    period from when it finished. It has no index, while nothing can be modified before it
    was created, so creation narrows the scan. Starting from the last batch keeps a long
    backlog from walking over everything already cleared each time.
    """
    filters = [
        ["pos_profile", "=", pos_profile],
        ["status", "in", FINAL_STATES],
        ["creation", "<", cutoff],
        ["modified", "<", cutoff],
    ]
    if start:
        filters.append(["creation", ">=", start])

    return frappe.get_all(
        DOCTYPE,
        filters=filters,
        or_filters=[["payload", "is", "set"], ["original_payload", "is", "set"]],
        fields=["name", "creation"],
        order_by="creation asc",
        limit=BATCH_SIZE,
    )


def _log_clearing(names, days):
    """Add one attempt line per record, so an empty payload explains itself."""
    last_lines = frappe.get_all(
        ATTEMPT_DOCTYPE,
        filters={"parent": ["in", names]},
        fields=["parent", {"MAX": "idx", "as": "idx"}],
        group_by="parent",
    )
    last_idx = {row.parent: cint(row.idx) for row in last_lines}

    now = now_datetime()
    user = frappe.session.user
    message = _("Cleared after {0} day(s) of retention").format(days)

    frappe.db.bulk_insert(
        ATTEMPT_DOCTYPE,
        fields=[
            "name",
            "creation",
            "modified",
            "owner",
            "modified_by",
            "parent",
            "parenttype",
            "parentfield",
            "idx",
            "attempted_at",
            "performed_by",
            "outcome",
            "message",
        ],
        values=[
            (
                frappe.generate_hash(length=10),
                now,
                now,
                user,
                user,
                name,
                DOCTYPE,
                "attempt_log",
                last_idx.get(name, 0) + 1,
                now,
                user,
                OUTCOME_CLEARED,
                message,
            )
            for name in names
        ],
    )
