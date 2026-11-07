# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Email the people each POS Profile names when its records need review.

Nothing goes out unless POS Settings lists recipients.
"""

import frappe
from frappe import _
from frappe.utils import (
    cstr,
    escape_html,
    format_datetime,
    get_url,
    get_url_to_form,
    now_datetime,
    split_emails,
    validate_email_address,
)

from pos_next.services.sync_entities import DOCTYPE

REVIEW = "Needs Review"

SYNC_CENTER_ROUTE = "/desk/pos-sync-center"


def _get_error_labels():
    return {
        "stock": _("Stock"),
        "business": _("Business Rule"),
        "dependency": _("Waiting For A Record"),
        "contract": _("Invalid Data"),
        "bug": _("System Error"),
        "transient_server": _("Server Busy"),
    }


def split_recipients(value):
    """Read the setting. split_emails turns a new line into a space before it splits, which
    would make a list typed one per line a single address that matches nothing."""
    return split_emails(cstr(value).replace("\n", ","))


def get_recipients(value):
    """One bad address must not cost the others their alert."""
    return [email for email in split_recipients(value) if validate_email_address(email)]


def email_review_summaries():
    """Mail each POS Profile that asked for it. Runs every hour, after the system reminders.

    Each profile commits on its own, so a failed send costs only that profile, and only
    until the next run: it records nothing, so what it held back counts as new then.
    """
    settings = frappe.get_all(
        "POS Settings",
        filters={"sync_alert_recipients": ["is", "set"]},
        fields=["name", "pos_profile", "sync_alert_recipients", "sync_alert_last_sent_at"],
    )
    if not settings:
        return

    frappe.db.commit()  # nosemgrep: a rollback below must not cost the reminders made before it

    for row in settings:
        try:
            _email_summary(row)
            frappe.db.commit()  # nosemgrep: the queued email and the time of the send are one fact
        except Exception:
            frappe.db.rollback()  # nosemgrep: discard a half-queued email
            frappe.clear_messages()
            frappe.log_error(title="POS Sync Alert Email")
            frappe.db.commit()  # nosemgrep: keep the error for whoever looks into it


def _email_summary(settings):
    recipients = get_recipients(settings.sync_alert_recipients)
    if not recipients or not _has_new_reviews(settings):
        return

    summary = _get_summary(settings.pos_profile)
    frappe.sendmail(
        recipients=recipients,
        subject=_("POS Sync: {0} record(s) need review on {1}").format(summary.total, settings.pos_profile),
        message=_render(settings.pos_profile, summary),
        delayed=True,
        reference_doctype="POS Settings",
        reference_name=settings.name,
    )
    # The newest record it covers, not the clock: a record that fails during this run is
    # stamped before now, and must still count as new next time.
    frappe.db.set_value(
        "POS Settings",
        settings.name,
        "sync_alert_last_sent_at",
        summary.newest or now_datetime(),
        update_modified=False,  # devices pull settings again when this table's modified moves
    )


def _has_new_reviews(settings):
    filters = {"pos_profile": settings.pos_profile, "status": REVIEW}
    if settings.sync_alert_last_sent_at:
        filters["processed_at"] = [">", settings.sync_alert_last_sent_at]
    return bool(frappe.db.exists(DOCTYPE, filters))


def _get_summary(pos_profile):
    filters = {"pos_profile": pos_profile, "status": REVIEW}
    groups = frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=[
            "error_class",
            "error_code",
            {"MAX": "error_message", "as": "message"},
            {"COUNT": "name", "as": "count"},
            {"MAX": "processed_at", "as": "newest"},
        ],
        group_by="error_fingerprint, error_class, error_code",
        order_by="count desc",
    )
    oldest = frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=["name", "offline_id", "creation"],
        order_by="creation asc",
        limit=1,
    )
    return frappe._dict(
        groups=groups,
        total=sum(group["count"] for group in groups),
        newest=max((group.newest for group in groups if group.newest), default=None),
        oldest=oldest[0] if oldest else None,
    )


def _render(pos_profile, summary):
    """Build the email. Error messages quote what devices sent, so everything is escaped."""
    labels = _get_error_labels()
    rows = "".join(
        f"""<tr>
            <td>{escape_html(labels.get(group.error_class) or group.error_class or _("Other"))}</td>
            <td>{escape_html(group.message or "")}</td>
            <td>{group["count"]}</td>
        </tr>"""
        for group in summary.groups
    )

    oldest = ""
    if summary.oldest:
        link = escape_html(get_url_to_form(DOCTYPE, summary.oldest.name))
        record = escape_html(summary.oldest.offline_id)
        oldest = (
            f'<p>{_("Oldest record:")} <a href="{link}">{record}</a>, '
            f"{format_datetime(summary.oldest.creation)}</p>"
        )

    return f"""<div dir="auto">
        <p>{_("{0} record(s) of {1} need review.").format(summary.total, escape_html(pos_profile))}</p>
        <table border="1" cellpadding="6" cellspacing="0">
            <thead>
                <tr><th>{_("Error Group")}</th><th>{_("Message")}</th><th>{_("Count")}</th></tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>
        {oldest}
        <p><a href="{escape_html(get_url(SYNC_CENTER_ROUTE))}">{_("Open the Sync Center")}</a></p>
    </div>"""
