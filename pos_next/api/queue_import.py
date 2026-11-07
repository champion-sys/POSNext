# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Brings in the queue of a device that cannot reach this server.

A manager uploads the file the device exported. Each row then takes the road a push takes,
so nothing about the file decides more than a push could, and the file is never kept.
"""

import json

import frappe
from frappe import _

from pos_next.api import sync
from pos_next.services import queue_file
from pos_next.services.sync_entities import DOCTYPE

#: How many refused rows the reply names. The counts cover all of them.
MAX_PROBLEMS = 100

STATUS_CONFLICT = "conflict"

#: Which count each refusal goes to. Any other answer took the row, as a void request does.
REFUSALS = {STATUS_CONFLICT: "conflicts", "rejected": "rejected"}

#: Sales that are not edits hold a null here, and a full payload scan must not load them
_HOLDS_AN_EDIT = '%"edited_from": "%'


def _edited_from(payload):
    # A manager can paste a payload into a record, and one bad record must not stop an import
    try:
        original = json.loads(payload).get("edited_from")
    except (ValueError, AttributeError):
        return None
    return original if isinstance(original, str) else None


def _get_held_edits():
    """Which sales the server already holds a later edit of.

    A file is a snapshot. A sale edited after it was exported is retired on the device, which
    sends the edit instead, so a file imported later would bring the original back beside it.
    Only the edit names the original, inside its payload.

    Returns:
        dict[str, str]: The offline_id of each edit, by the offline_id it replaced
    """
    rows = frappe.get_all(
        DOCTYPE,
        filters={"payload": ["like", _HOLDS_AN_EDIT], "status": ["!=", "Voided"]},
        fields=["offline_id", "payload"],
    )
    return {_edited_from(row.payload): row.offline_id for row in rows}


def _replaced_by_edit(offline_id, edit):
    return {
        "offline_id": offline_id,
        "status": STATUS_CONFLICT,
        "message": _(
            "This sale was edited after the file was exported. The server already holds the edit, {0}."
        ).format(edit),
    }


def _import_row(item, queue, uploader, edits):
    """Store one row of a file.

    Returns:
        tuple[str | None, dict | None, bool]: The record's name, or the answer to give instead,
            and whether the server already held it
    """
    offline_id = item.get("offline_id") if isinstance(item, dict) else None
    is_named = isinstance(offline_id, str)

    known = is_named and bool(frappe.db.get_value(DOCTYPE, {"offline_id": offline_id}))
    if is_named and not known and offline_id in edits:
        return None, _replaced_by_edit(offline_id, edits[offline_id]), False

    name, answer = sync.store_item(item, uploader, queue.device_id, queue.app_version, queue.protocol_version)
    return name, answer, known


@frappe.whitelist(methods=["POST"])
def import_queue_file():
    """Store the rows of an uploaded queue file. The file is read here and never saved.

    Returns:
        dict: stored, already_known, conflicts and rejected, the rows refused, and what the
            file says about where it came from
    """
    sync._assert_manager()

    upload = frappe.request.files.get("file")
    if not upload:
        frappe.throw(_("Choose a queue file to import"))

    queue = queue_file.read_queue_file(upload.stream.read(queue_file.MAX_FILE_BYTES + 1))
    uploader = frappe.session.user
    edits = _get_held_edits()

    names = []
    problems = []
    counts = {"stored": 0, "already_known": 0, "conflicts": 0, "rejected": 0}

    for item in queue.rows:
        name, answer, known = _import_row(item, queue, uploader, edits)
        refusal = REFUSALS.get(answer["status"]) if answer else None
        if refusal:
            counts[refusal] += 1
            problems.append(answer)
            continue

        counts["already_known" if known else "stored"] += 1
        if name:
            names.append(name)

    sync.enqueue_stored(names)

    return {
        **counts,
        "problems": problems[:MAX_PROBLEMS],
        "device_id": queue.device_id,
        "server": queue.server,
        "exported_at": queue.exported_at,
    }
