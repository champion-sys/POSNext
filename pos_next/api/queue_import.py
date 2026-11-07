# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Brings in the queue of a device that cannot reach this server.

A manager uploads the file the device exported. Each row then takes the road a push takes,
so nothing about the file decides more than a push could, and the file is never kept.
"""

import frappe
from frappe import _

from pos_next.api import sync
from pos_next.services import queue_file, sync_void
from pos_next.services.sync_entities import DOCTYPE

#: How many refused rows the reply names. The counts cover all of them.
MAX_PROBLEMS = 100

STATUS_CONFLICT = "conflict"

#: Which count each refusal goes to. Any other answer took the row, as a void request does.
REFUSALS = {STATUS_CONFLICT: "conflicts", "rejected": "rejected"}


def _store_row(item, queue, uploader):
    """Store a row, as a sale if it asks for a void its POS Profile does not allow.

    A device told so sends the record again without the request. A file never hears the
    answer, and the paid sale would have no other way to the server.
    """
    name, answer = sync.store_item(item, uploader, queue.device_id, queue.app_version, queue.protocol_version)
    if not answer or answer["status"] != sync_void.VOID_REFUSED:
        return name, answer

    sale = {key: value for key, value in item.items() if key != "void_reason"}
    return sync.store_item(sale, uploader, queue.device_id, queue.app_version, queue.protocol_version)


def _import_row(item, queue, uploader):
    """Store one row of a file.

    Returns:
        tuple[str | None, dict | None, bool]: The record's name, or the answer to give instead,
            and whether the server already held it
    """
    offline_id = item.get("offline_id") if isinstance(item, dict) else None

    known = isinstance(offline_id, str) and bool(frappe.db.get_value(DOCTYPE, {"offline_id": offline_id}))
    name, answer = _store_row(item, queue, uploader)
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

    names = []
    problems = []
    counts = {"stored": 0, "already_known": 0, "conflicts": 0, "rejected": 0}

    for item in queue.rows:
        name, answer, known = _import_row(item, queue, uploader)
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
