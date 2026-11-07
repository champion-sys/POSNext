# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Tell managers when a closed shift's sales did not reach the books.

ERPNext merges ten or more POS Invoices in a background job, after the cashier has been told
the shift closed. If that job fails or never runs, the invoices have no ledger entries and
nothing else says so.
"""

import frappe
from frappe import _
from frappe.utils import add_to_date, now_datetime

from pos_next.services.sync_inbox import _get_review_recipients

DOCTYPE = "POS Closing Entry"

#: Longer than this in the queue and the job is not coming
STUCK_QUEUED_MINUTES = 30


def notify(entry_name, pos_profile):
    from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification

    users = _get_review_recipients(pos_profile)
    if users:
        enqueue_create_notification(
            users,
            {
                "type": "Alert",
                "document_type": DOCTYPE,
                "document_name": entry_name,
                "subject": _(
                    "POS Closing Entry {0} did not finish, so its shift's sales are not in the books. "
                    "Fix the cause it shows, then press Retry."
                ).format(entry_name),
                "from_user": "Administrator",
            },
        )


def remind_about_closings():
    """Keep asking until a person has dealt with it. Runs every hour."""
    stuck_before = add_to_date(now_datetime(), minutes=-STUCK_QUEUED_MINUTES)
    entries = frappe.get_all(DOCTYPE, filters={"status": "Failed"}, fields=["name", "pos_profile"])
    entries += frappe.get_all(
        DOCTYPE,
        filters={"status": "Queued", "modified": ["<", stuck_before]},
        fields=["name", "pos_profile"],
    )
    for entry in entries:
        notify(entry.name, entry.pos_profile)
