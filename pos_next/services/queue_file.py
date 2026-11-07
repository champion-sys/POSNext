# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Reads a queue file exported from a device.

The file has passed through someone's hands and may have been edited, so what it says is
only ever a claim. This decides whether it can be read at all. A file that fails here
stores nothing, and each row is then checked as a push would check it.
"""

import json
from collections import namedtuple

import frappe
from frappe import _
from frappe.utils import cint

FORMAT_VERSION = 1

#: Each row commits on its own inside the request, so a much larger file would outlast it
MAX_FILE_BYTES = 10 * 1024 * 1024

#: What a Data field holds
MAX_HEADER_LENGTH = 140

QueueFile = namedtuple(
    "QueueFile", "device_id app_version server exported_at protocol_version rows"
)


def _refuse_constant(name):
    raise ValueError(name)


def _parse(content):
    try:
        # A text editor on Windows leaves a BOM. NaN and Infinity are Python's, not JSON's.
        return json.loads(content.decode("utf-8-sig"), parse_constant=_refuse_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        frappe.throw(_("This file is not valid JSON. Nothing was imported."))


def _is_known_version(data):
    version = data.get("format_version")
    # True would otherwise pass as 1
    return type(version) is int and version == FORMAT_VERSION


def _header_text(data, fieldname):
    value = data.get(fieldname)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > MAX_HEADER_LENGTH:
        frappe.throw(_("This is not a queue file. Nothing was imported."))
    return value


def _in_queue_order(rows):
    """Rows as the device queued them, whatever order the file has them in.

    A sale stored before its edit is how the inbox holds the edit back for review.
    """
    return sorted(rows, key=lambda row: cint(row.get("seq")) if isinstance(row, dict) else 0)


def read_queue_file(content):
    """Read an uploaded queue file.

    Args:
        content: The file's bytes

    Returns:
        QueueFile: What it claims, with its rows in queue order

    Raises:
        frappe.ValidationError: When it cannot be imported at all
    """
    if len(content) > MAX_FILE_BYTES:
        frappe.throw(
            _("This file is larger than {0} MB. Nothing was imported.").format(
                MAX_FILE_BYTES // (1024 * 1024)
            )
        )

    data = _parse(content)
    if not isinstance(data, dict) or "format_version" not in data:
        frappe.throw(_("This is not a queue file. Nothing was imported."))
    if not _is_known_version(data):
        frappe.throw(_("This queue file has a format this server cannot read. Nothing was imported."))
    if not isinstance(data.get("rows"), list):
        frappe.throw(_("This is not a queue file. Nothing was imported."))

    return QueueFile(
        device_id=_header_text(data, "device_id"),
        app_version=_header_text(data, "app_version"),
        server=_header_text(data, "server"),
        exported_at=_header_text(data, "exported_at"),
        protocol_version=cint(data.get("protocol_version")) or 1,
        rows=_in_queue_order(data["rows"]),
    )
