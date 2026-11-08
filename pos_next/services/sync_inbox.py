# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""The server side of the sync queue.

Every queued record, sale or otherwise, is stored here in its own transaction before it
is processed. A failure therefore always leaves a record with the original payload,
which Frappe's rollback on error would otherwise erase. The transaction boundaries
below are the point of this module: the commits are deliberate.
"""

import hashlib
import json
import time
from collections import namedtuple
from contextlib import contextmanager
from zoneinfo import ZoneInfo

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, get_system_timezone, getdate, now_datetime
from frappe.utils.background_jobs import get_job_status
from rq.job import JobStatus
from rq.timeouts import JobTimeoutException

from pos_next.services import sync_classifier, sync_entities, sync_retention
from pos_next.services.sync_classifier import (
    CashierNotOnProfileError,
    CashierUnavailableError,
    ClockSkewError,
    EditConflictError,
    ReplacedByEditError,
    SaleOutsideShiftError,
    ShiftClosedError,
    TotalMismatchError,
    WaitingForDependencyError,
)
from pos_next.services.sync_entities import (
    DOCTYPE,
    ENTITY_CUSTOMER,
    ENTITY_INVOICE,
    ENTITY_PAYMENT,
    ENTITY_SHIFT_CLOSE,
    ENTITY_SHIFT_OPEN,
    FINAL_STATES,
)
from pos_next.utils import session_of

REVIEW = "Needs Review"

#: Rows left in Processing longer than this belong to a crashed worker
STALE_PROCESSING_MINUTES = 10

#: A device sends its queue in one go, so a dependency this late is not on its way
MISSING_DEPENDENCY_MINUTES = 30

#: How long one job may work through a profile's queue
QUEUE_JOB_SECONDS = 540

#: A job takes no new row this close to its limit, so the row in hand can finish
QUEUE_JOB_MARGIN_SECONDS = 120

#: How long the next turn waits for the job that asked for it to end
NEXT_TURN_WAIT_SECONDS = 30

#: Set by the client after the invoice is queued, so they are not part of the sale
VOLATILE_PAYLOAD_FIELDS = ("was_printed", "last_printed_at")

DEFAULT_TOTAL_TOLERANCE = 0.05
#: Past this a clock is wrong, not drifting: half a day can move a sale to another date.
MAX_CLOCK_SKEW_SECONDS = 12 * 60 * 60

#: How far outside its shift's hours a sale may be dated, for clocks that drift a little
SHIFT_WINDOW_TOLERANCE_MINUTES = 30

_NO_ERROR = {
    "error_class": None,
    "error_code": None,
    "error_message": None,
    "error_fingerprint": None,
    "traceback": None,
}


def compute_payload_hash(payload):
    """Hash a payload so a retry can be told from a changed invoice."""
    stable = {key: value for key, value in payload.items() if key not in VOLATILE_PAYLOAD_FIELDS}
    canonical = json.dumps(stable, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def validate_envelope(item):
    """Check the fields storing an item depends on.

    Returns:
        str | None: What is wrong, or None when it can be stored
    """
    if not isinstance(item, dict):
        return "Item is not an object"
    if not isinstance(item.get("offline_id"), str) or not item["offline_id"].strip():
        return "Missing offline_id"
    if not isinstance(item.get("payload"), dict):
        return "Missing payload"
    pos_profile = get_item_profile(item)
    if not pos_profile or not isinstance(pos_profile, str):
        return "Missing pos_profile"
    # The upload is checked against one, and an invoice posts under the other
    if item["payload"].get("pos_profile") not in (None, "", pos_profile):
        return _("The record and its payload name different POS Profiles")
    if (item.get("entity") or ENTITY_INVOICE) not in sync_entities.ENTITIES:
        return "Unknown entity"
    # Read as a plain push, a blank reason would post the record the device wants gone
    reason = item.get("void_reason")
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        return "A void needs a reason"

    # It moves a record's sales to someone else's shift, so only a manager's fix may set it
    if item["payload"].get("linked_shift"):
        return "A device cannot link a shift"
    return None


def get_item_profile(item):
    return item.get("pos_profile") or item["payload"].get("pos_profile")


def _link_or_none(doctype, name):
    """A sale must be stored even when its master record is gone."""
    return name if name and frappe.db.exists(doctype, name) else None


def _resolve_cashier(claimed, uploaded_by):
    """Who a record belongs to.

    A shared device can upload a colleague's sale, so the envelope may name someone else.
    The name is kept even when that person is not on the POS Profile, as when they have left
    it since: processing then holds the record for review (_as_cashier), instead of giving
    the sale to whoever uploaded it. Only a name counts, so a claim cannot become a filter.
    """
    return claimed.strip() if isinstance(claimed, str) and claimed.strip() else uploaded_by


def _envelope_fields(item, uploaded_by, device_id, client_version, protocol_version):
    """What a record takes from the envelope it arrived in."""
    payload = item["payload"]
    serialized = frappe.as_json(payload, indent=1)
    pos_profile = get_item_profile(item)
    totals = item.get("client_totals") or {}
    entity = item.get("entity") or ENTITY_INVOICE
    cashier = _resolve_cashier(item.get("cashier"), uploaded_by)

    return {
        "entity": entity,
        "invoice_doctype": payload.get("doctype") or "Sales Invoice",
        "pos_profile": _link_or_none("POS Profile", pos_profile),
        "customer": _link_or_none("Customer", payload.get("customer")),
        "shift": _link_or_none("POS Opening Shift", sync_entities.get_record_shift(entity, payload, cashier)),
        "cashier": cashier,
        "uploaded_by": uploaded_by,
        "device_id": device_id,
        "edited_from": _get_edited_from(item),
        "client_created_at": _parse_datetime(item.get("created_at_device")),
        "received_at": now_datetime(),
        "client_grand_total": flt(totals.get("grand_total", payload.get("grand_total"))),
        "client_paid_amount": flt(totals.get("paid", _sum_payments(payload))),
        "payload": serialized,
        "original_payload": serialized,
        "payload_hash": compute_payload_hash(payload),
        "coupon_code": payload.get("coupon_code"),
        "seq": cint(item.get("seq")),
        **_clock_fields(item),
        "client_version": client_version,
        "protocol_version": cint(protocol_version),
        "depends_on": "\n".join(sync_entities.get_dependencies(payload, item.get("depends_on"))),
    }


def _clock_fields(item):
    """What a record says about its sender's clock. A reading is zero or more, so none is its own value.

    With no reading, all that can be told is whether it claims a time still to come, which
    no correct clock can do. A claim in the past proves nothing, and is left unjudged.
    """
    reading = item.get("clock_skew_seconds")
    if reading is not None:
        return {"clock_skew_seconds": cint(reading), "clock_not_measured": 0}

    ahead = _seconds_ahead(item.get("created_at_device"))
    return {"clock_skew_seconds": ahead if ahead >= MAX_CLOCK_SKEW_SECONDS else 0, "clock_not_measured": 1}


def _seconds_ahead(created_at):
    """How far past the server's clock a time lies. Compared as moments, since a device
    in another time zone is not ahead."""
    try:
        moment = get_datetime(created_at) if created_at else None
    except (TypeError, ValueError, OverflowError):
        return 0

    if not moment:
        return 0
    if not moment.tzinfo:
        moment = moment.replace(tzinfo=ZoneInfo(get_system_timezone()))
    return max(cint(moment.timestamp() - time.time()), 0)


def _adopt_payload(name, fields):
    """Give a record stored without a payload the one its device sent again.

    Only what the record lacks is filled in, so it keeps the profile it was stored under,
    and a resend for a different profile is not the same sale.

    Returns:
        bool: Whether the record now holds this payload
    """
    row = _lock(name)
    adopted = not row.payload and row.pos_profile in (None, "", fields["pos_profile"])
    if adopted:
        values = {fieldname: value for fieldname, value in fields.items() if not row.get(fieldname)}
        if row.status == REVIEW:
            values.update(status="Received", next_retry_at=None, **_NO_ERROR)
        frappe.db.set_value(DOCTYPE, name, values)

    frappe.db.commit()  # nosemgrep: release the row lock, and keep the sale
    return adopted or row.payload_hash == fields["payload_hash"]


def _holds_sale(offline_id):
    """Whether a sale reached the server, as a record that stands or as an invoice."""
    status = frappe.db.get_value(DOCTYPE, {"offline_id": offline_id}, "status")
    return bool(status and status != "Voided") or bool(find_invoice_by_offline_id(offline_id))


def _get_edited_from(item):
    """The sale a record replaced. An edit that kept the original's id is the original."""
    original = item["payload"].get("edited_from")
    return original if original and isinstance(original, str) and original != item["offline_id"] else None


def _get_edit_conflict(item):
    """Spot an edit of a sale that already reached the server.

    A device offers an edit while it thinks the sale is unsent. If the push landed and only
    its response was lost, the edit arrives under a new offline_id and both would post.
    """
    original = _get_edited_from(item)
    if original and _holds_sale(original):
        return EditConflictError(
            _("This edits sale {0}, which the server already holds. A manager must decide which one stands.").format(
                original
            )
        )
    return None


def _get_replacing_edit(offline_id):
    """The edit that replaced a sale, finished long ago or not.

    A voided edit counts. The device retired the sale when it was edited, so a cashier who
    voids the edit believes the sale is gone, and a copy from before must not bring it back.
    """
    return frappe.db.get_value(DOCTYPE, {"edited_from": offline_id}, "offline_id")


def _hold_edit_conflict(name, item):
    """Keep a record from posting beside the sale it replaced, or was replaced by."""
    edit = _get_replacing_edit(item["offline_id"])
    conflict = _get_edit_conflict(item) or (
        EditConflictError(_("Edit {0} replaced this sale. A manager must decide which one stands.").format(edit))
        if edit
        else None
    )
    if conflict and frappe.db.get_value(DOCTYPE, name, "status", for_update=True) == "Received":
        _handle_failure(name, 1, conflict, None, None)


def ingest(item, uploaded_by, device_id=None, client_version=None, protocol_version=1):
    """Store one record and commit, before anything can fail on its contents.

    Returns:
        tuple[str, bool]: The record name, and whether this payload conflicts with
            a different one already stored under the same offline_id

    Raises:
        ReplacedByEditError: When this is a sale the server holds an edit of
    """
    offline_id = item["offline_id"]

    existing = frappe.db.get_value(
        DOCTYPE,
        {"offline_id": offline_id},
        ["name", "payload_hash", "payload", "original_payload"],
        as_dict=True,
    )
    # A cleared record is finished, not waiting for its payload, and its hash still answers
    if existing and not existing.payload and not sync_retention.is_cleared(existing):
        fields = _envelope_fields(item, uploaded_by, device_id, client_version, protocol_version)
        return existing.name, not _adopt_payload(existing.name, fields)
    if existing:
        # A manager can paste a payload into a record that has no hash to compare
        payload_hash = compute_payload_hash(item["payload"])
        conflict = bool(existing.payload_hash) and existing.payload_hash != payload_hash
        return existing.name, conflict

    edit = _get_replacing_edit(offline_id)
    if edit:
        raise ReplacedByEditError(_("Edit {0} replaced this sale, so it was not stored.").format(edit))

    doc = frappe.get_doc(
        {
            "doctype": DOCTYPE,
            "offline_id": offline_id,
            "status": "Received",
            **_envelope_fields(item, uploaded_by, device_id, client_version, protocol_version),
        }
    )
    doc.flags.ignore_permissions = True
    doc.flags.ignore_links = True

    try:
        doc.insert()
    except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
        frappe.db.rollback()  # nosemgrep: another request stored it first
        return frappe.db.get_value(DOCTYPE, {"offline_id": offline_id}), False

    # In this transaction, so no worker can see the row before it is held back
    _hold_edit_conflict(doc.name, item)
    frappe.db.commit()  # nosemgrep: the sale must survive anything that happens next

    # A sale and its edit stored at the same moment cannot see each other until both commit.
    # Whichever commits last sees the other here.
    _hold_edit_conflict(doc.name, item)
    frappe.db.commit()  # nosemgrep: release the row lock, and keep the hold
    return doc.name, False


def _parse_datetime(value):
    try:
        return get_datetime(value).replace(tzinfo=None) if value else None
    except (TypeError, ValueError):
        return None


def _sum_payments(payload):
    return sum(flt(row.get("amount")) for row in payload.get("payments") or [])


@contextmanager
def _as_cashier(row):
    """Run a block under the cashier's session, so what it creates is theirs.

    Only the handler runs here: the record itself is written under the session that
    processes it, so it never depends on the cashier's permissions.
    """
    if not row.cashier or not frappe.db.get_value("User", row.cashier, "enabled"):
        raise CashierUnavailableError(
            _("The cashier of this record is disabled or no longer exists: {0}").format(row.cashier or "-")
        )

    # A colleague's record runs as them only while they are on the profile. Having high roles
    # is not enough: the name comes from the request, and a role would let any POS user act
    # as its holder. The uploader's own access was checked when the record was stored.
    is_colleague = row.cashier != row.uploaded_by
    if is_colleague and not frappe.db.exists("POS Profile User", {"parent": row.pos_profile, "user": row.cashier}):
        raise CashierNotOnProfileError(
            _(
                "The cashier of this record, {0}, is no longer on POS Profile {1}, so it was not given to {2}. "
                "Add them back to the profile and press Reprocess, or void it."
            ).format(row.cashier, row.pos_profile or "-", row.uploaded_by or "-")
        )

    with session_of(row.cashier):
        yield


def process(name):
    """Turn one stored record into what it stands for on the server.

    The document and the Synced status commit together. On failure everything is
    rolled back first, and the failure is then written in a fresh transaction.
    """
    row = _lock(name)

    # Processing means another worker has it. The sweep frees the row if that worker died.
    if not row or row.status in (*FINAL_STATES, REVIEW, "Processing") or _is_blocked(row):
        frappe.db.commit()  # nosemgrep: release the row lock
        return row

    handler = _get_handler(row)

    # Crash safety: the document may exist while its status update was lost
    existing = handler.find(row.offline_id)
    if existing:
        recovered = _mark_synced(name, existing, "recovered")
        frappe.db.commit()  # nosemgrep: finish the update the crash interrupted
        return recovered

    attempts = cint(row.attempts) + 1
    frappe.db.set_value(DOCTYPE, name, {"status": "Processing", "attempts": attempts}, update_modified=True)
    frappe.db.commit()  # nosemgrep: show it as in progress, and keep the attempt count on a crash

    started = time.monotonic()
    try:
        with _as_cashier(row):
            result = handler.create(row)
        _mark_synced(name, result, "synced", started)
        frappe.db.commit()  # nosemgrep: the document and its Synced status commit as one
    except JobTimeoutException:
        _return_to_queue(name, attempts)
        raise
    except Exception as exc:
        traceback = frappe.get_traceback()
        frappe.db.rollback()  # nosemgrep: discard the partial document before recording why
        frappe.clear_messages()
        _handle_failure(name, attempts, exc, traceback, started)
        frappe.db.commit()  # nosemgrep: the failure survives, unlike a write inside the request

    frappe.clear_messages()
    return frappe.db.get_value(DOCTYPE, name, "*", as_dict=True)


def _return_to_queue(name, attempts):
    """Hand a record back when its job runs out of time. That says nothing about the record.

    Only from Processing, because the limit can land just after its commit went through.
    """
    # The limit can cut a query in half, which leaves the connection out of sync. Closing it
    # also discards the partial document.
    frappe.db.close()
    frappe.db.connect()
    frappe.clear_messages()
    frappe.db.set_value(
        DOCTYPE, {"name": name, "status": "Processing"}, {"status": "Received", "attempts": attempts - 1}
    )
    frappe.db.commit()  # nosemgrep: the job is ending, and the sweep needs to see this


def _lock(name):
    return frappe.db.get_value(DOCTYPE, name, "*", as_dict=True, for_update=True)


def _get_handler(row):
    return _ENTITIES.get(row.entity) or _ENTITIES[ENTITY_INVOICE]


def _get_unfinished_dependencies(row):
    """What a record still waits for.

    Returns:
        dict[str, str | None]: The status of each one, None when it never arrived
    """
    dependencies = [line.strip() for line in (row.depends_on or "").splitlines() if line.strip()]
    if not dependencies:
        return {}

    statuses = dict(
        frappe.get_all(
            DOCTYPE,
            filters={"offline_id": ["in", dependencies]},
            fields=["offline_id", "status"],
            as_list=True,
        )
    )
    return {
        offline_id: statuses.get(offline_id)
        for offline_id in dependencies
        if statuses.get(offline_id) not in FINAL_STATES
    }


def _is_blocked(row):
    """Hold a record until the records it depends on have finished."""
    if cint(row.accept_unfinished) or not _get_unfinished_dependencies(row):
        return False

    if row.status != "Blocked":
        frappe.db.set_value(DOCTYPE, row.name, "status", "Blocked")
        frappe.db.commit()  # nosemgrep: release the row lock while waiting
    return True


def _assert_shift_open(row, payload, pos_profile):
    """Refuse a sale its shift can no longer take, the same way as online.

    Its drawer was counted without it, and a POS Invoice would never reach the books: the
    closing takes only its own shift's invoices. A colleague's sale on a shared device goes
    into the shift the device has open, so the shift need not be the cashier's.
    """
    from pos_next.api.invoices import assert_shift_takes_sale

    shift = payload.get("posa_pos_opening_shift") or payload.get("pos_opening_shift") or row.shift
    assert_shift_takes_sale(shift, pos_profile, queued=True, offline_id=row.offline_id)


def _assert_device_clock(row):
    """A wrong clock puts a record on the wrong day, and nothing later would show it.

    The clock is read when a batch is sent, so a clock that was wrong when the sale was made
    and right by then passes that reading. The sale's date still has to fall in its shift.
    """
    if cint(row.accept_device_date):
        return

    _assert_within_shift(row)

    skew = abs(cint(row.clock_skew_seconds))
    if skew < MAX_CLOCK_SKEW_SECONDS:
        return

    if cint(row.clock_not_measured):
        raise ClockSkewError(
            _("This record says it was made {0} hour(s) ahead of the server, and no clock reading came with it").format(
                flt(skew / 3600, 1)
            )
        )
    raise ClockSkewError(
        _("The device clock was {0} hour(s) away from the server when this was sent").format(flt(skew / 3600, 1))
    )


def _get_shift_window(shift):
    """When a shift took sales: from its start to its close, or to now while it is open.

    Args:
        shift: Its name, or filters that find it

    Returns:
        tuple[str, datetime, datetime] | None: Its name, start and end. None when the
            server does not know it, or it says nothing usable
    """
    opening = frappe.db.get_value(
        "POS Opening Shift", shift, ["name", "period_start_date", "status", "pos_closing_shift"], as_dict=True
    )
    if not isinstance(opening, dict) or not opening.get("period_start_date"):
        return None

    end = None
    if opening.get("status") == "Closed" and opening.get("pos_closing_shift"):
        end = frappe.db.get_value("POS Closing Shift", opening["pos_closing_shift"], "period_end_date")
    start = get_datetime(opening["period_start_date"])
    return opening.get("name") or shift, start, get_datetime(end) if end else now_datetime()


def _get_sale_moment(payload):
    """When the sale says it was made, as it will post. None when the server picks the date.

    Returns:
        tuple[date, datetime | None] | None: The date, and the moment when it has a time
    """
    posting_date = payload.get("posting_date")
    if not posting_date:
        return None
    try:
        day = getdate(posting_date)
        moment = get_datetime(f"{day} {payload['posting_time']}") if payload.get("posting_time") else None
    except (TypeError, ValueError, OverflowError):
        return None
    return day, moment


def _named_shift(payload):
    return payload.get("posa_pos_opening_shift") or payload.get("pos_opening_shift")


def _assert_within_shift(row):
    """A sale dated outside the hours of the shift it was made in goes to a person.

    Only the shift the device named counts. A manager who moved the sale to another shift,
    or linked the shift it was made in to another one, has already decided where it goes.
    """
    if (row.get("entity") or ENTITY_INVOICE) != ENTITY_INVOICE or not row.get("payload"):
        return

    payload = sync_entities.load_payload(row)
    named = _named_shift(payload)
    sale = _get_sale_moment(payload)
    try:
        original = json.loads(row.get("original_payload") or row.payload)
    except ValueError:
        original = None
    moved = isinstance(original, dict) and _named_shift(original) != named
    if not named or not sale or moved:
        return

    # A shift opened on a device keeps the device's name. One linked to another was never created.
    window = _get_shift_window({"offline_id": named} if sync_entities.is_local_name(named) else named)
    if not window:
        return

    shift, opened, closed = window
    start = add_to_date(opened, minutes=-SHIFT_WINDOW_TOLERANCE_MINUTES)
    end = add_to_date(closed, minutes=SHIFT_WINDOW_TOLERANCE_MINUTES)
    day, moment = sale
    inside = start <= moment <= end if moment else start.date() <= day <= end.date()
    if not inside:
        raise SaleOutsideShiftError(
            _(
                "This sale is dated {0}, outside its shift {1}, which ran from {2} to {3}. "
                "The device clock may have been wrong when it was made."
            ).format(moment or day, shift, opened, closed)
        )


def _create_invoice(row):
    from pos_next.services.invoice_processor import process_invoice

    _assert_device_clock(row)

    payload = sync_entities.load_payload(row)
    sync_entities.resolve_local_names(payload)

    pos_profile = payload.get("pos_profile") or row.pos_profile
    doctype = payload.get("doctype") or row.invoice_doctype or "Sales Invoice"
    payload.setdefault("doctype", doctype)
    _assert_shift_open(row, payload, pos_profile)

    from pos_next.api.invoices import _assert_invoice_write_access

    _assert_invoice_write_access(doctype, pos_profile, row.cashier)

    if payload.get("is_return") and payload.get("return_against"):
        sync_entities.align_return(payload)

    data = {"offline_id": row.offline_id}
    result = process_invoice(payload, data, doctype, pos_profile, offline_id=row.offline_id, queued=True)
    _assert_totals_match(row, result, pos_profile)
    return {**result, "doctype": doctype, "customer": payload.get("customer")}


def _assert_totals_match(row, result, pos_profile):
    """A sale the customer paid must not silently become a different amount."""
    client_total = flt(row.client_grand_total)
    if not client_total or cint(row.accept_total_difference):
        return

    tolerance = frappe.db.get_value("POS Settings", {"pos_profile": pos_profile}, "sync_total_tolerance")
    tolerance = flt(tolerance) if tolerance is not None else DEFAULT_TOTAL_TOLERANCE

    difference = abs(client_total - flt(result.get("grand_total")))
    if difference > tolerance:
        raise TotalMismatchError(
            _("The server total {0} differs from the device total {1}").format(
                flt(result.get("grand_total")), client_total
            )
        )


def _mark_synced(name, result, outcome, started=None):
    """Record what a row became.

    Args:
        name: Record name
        result: The document: name, doctype, and optionally grand_total, customer, note
            and coupon_overrun
        outcome: For the attempt log
        started: When the attempt began
    """
    values = {
        "status": "Synced",
        "sales_invoice": result["name"],
        "invoice_doctype": result["doctype"],
        "server_grand_total": flt(result.get("grand_total")),
        "processed_at": now_datetime(),
        "synced_at": now_datetime(),
        "next_retry_at": None,
        **_NO_ERROR,
    }
    if result.get("customer"):
        values["customer"] = result["customer"]
    if result.get("coupon_overrun"):
        values["coupon_overrun"] = result["coupon_overrun"]

    frappe.db.set_value(DOCTYPE, name, values)
    _log_attempt(name, outcome, message=result.get("note"), started=started)
    if result.get("coupon_overrun"):
        _log_attempt(name, "coupon overrun", message=result["coupon_overrun"])
    _notify_uploader(name)
    return frappe.db.get_value(DOCTYPE, name, "*", as_dict=True)


def _handle_failure(name, attempts, exc, traceback, started):
    result = sync_classifier.classify(exc)

    # The unique index caught a concurrent submission of the same sale
    if isinstance(exc, frappe.DuplicateEntryError | frappe.UniqueValidationError):
        row = frappe.db.get_value(DOCTYPE, name, ["offline_id", "entity"], as_dict=True)
        existing = _get_handler(row).find(row.offline_id)
        if existing:
            _mark_synced(name, existing, "recovered")
            return

    delay = sync_classifier.next_retry_minutes(result.error_class, attempts)
    needs_review = delay is None

    frappe.db.set_value(
        DOCTYPE,
        name,
        {
            "status": REVIEW if needs_review else "Retry Scheduled",
            "next_retry_at": None if needs_review else add_to_date(now_datetime(), minutes=delay),
            "error_class": result.error_class,
            "error_code": result.error_code,
            "error_message": result.message,
            "error_fingerprint": result.fingerprint,
            "traceback": traceback,
            "processed_at": now_datetime(),
        },
    )
    _log_attempt(name, "failed", result.error_class, result.message, started)
    _notify_uploader(name)
    if needs_review:
        _notify_managers(name, result.message)


def _log_attempt(name, outcome, error_class=None, message=None, started=None):
    doc = frappe.get_doc(
        {
            "doctype": "Offline Invoice Sync Attempt",
            "parent": name,
            "parenttype": DOCTYPE,
            "parentfield": "attempt_log",
            "idx": (frappe.db.count("Offline Invoice Sync Attempt", {"parent": name}) or 0) + 1,
            "attempted_at": now_datetime(),
            "performed_by": frappe.session.user,
            "outcome": outcome,
            "error_class": error_class,
            "duration_ms": int((time.monotonic() - started) * 1000) if started else 0,
            "message": (message or "")[:500],
        }
    )
    doc.flags.ignore_permissions = True
    doc.insert()


def _notify_uploader(name):
    row = frappe.db.get_value(DOCTYPE, name, ["offline_id", "status", "uploaded_by"], as_dict=True)
    if row and row.uploaded_by:
        frappe.publish_realtime(
            "pos_sync_status",
            {"offline_id": row.offline_id, "status": row.status},
            user=row.uploaded_by,
            after_commit=True,
        )


def _get_review_recipients(pos_profile):
    users = frappe.get_all(
        "Has Role",
        filters={"role": "Nexus POS Manager", "parenttype": "User"},
        pluck="parent",
    )
    if pos_profile:
        assigned = frappe.get_all("POS Profile User", filters={"parent": pos_profile}, pluck="user")
        users = [user for user in users if user in assigned] or users
    return [user for user in set(users) if user not in ("Administrator", "Guest")]


def _notify_managers(name, message):
    from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification

    pos_profile = frappe.db.get_value(DOCTYPE, name, "pos_profile")
    users = _get_review_recipients(pos_profile)
    if users:
        enqueue_create_notification(
            users,
            {
                "type": "Alert",
                "document_type": DOCTYPE,
                "document_name": name,
                "subject": _("An offline invoice needs review: {0}").format(message[:120]),
                "from_user": "Administrator",
            },
        )


def find_invoice_by_offline_id(offline_id):
    """Find the submitted invoice of a sale, on either invoice doctype."""
    for doctype in ("Sales Invoice", "POS Invoice"):
        row = frappe.db.get_value(
            doctype,
            {"offline_id": offline_id, "docstatus": 1},
            ["name", "grand_total"],
            as_dict=True,
        )
        if row:
            return {"name": row.name, "doctype": doctype, "grand_total": row.grand_total}
    return None


_Entity = namedtuple("_Entity", ["create", "find", "doctypes"])

_ENTITIES = {
    ENTITY_INVOICE: _Entity(_create_invoice, find_invoice_by_offline_id, ("Sales Invoice", "POS Invoice")),
    ENTITY_CUSTOMER: _Entity(sync_entities.create_customer, sync_entities.find_customer, ("Customer",)),
    ENTITY_PAYMENT: _Entity(sync_entities.create_payment, sync_entities.find_payment, ("Payment Entry",)),
    ENTITY_SHIFT_CLOSE: _Entity(
        sync_entities.close_shift, sync_entities.find_shift_close, ("POS Closing Shift",)
    ),
    # Nothing to link to from the general action: only the link_shift fix checks the shift is open
    ENTITY_SHIFT_OPEN: _Entity(sync_entities.open_shift, sync_entities.find_shift_open, ()),
}


def get_duplicate_response(offline_id):
    """The response for a sale already on the server, for the online checkout.

    Returns:
        dict | None: The existing invoice's summary, or None when it is new
    """
    existing = find_invoice_by_offline_id(offline_id)
    if not existing:
        return None

    doc = frappe.get_doc(existing["doctype"], existing["name"])
    return {
        "name": doc.name,
        "status": doc.docstatus,
        "grand_total": doc.grand_total,
        "total": doc.total,
        "net_total": doc.net_total,
        "outstanding_amount": doc.get("outstanding_amount") or 0,
        "paid_amount": doc.get("paid_amount") or 0,
        "change_amount": doc.get("change_amount") or 0,
        "duplicate_prevented": True,
        "offline_id": offline_id,
    }


def record_direct_sync(offline_id, invoice_name, doctype, invoice):
    """Record a sale that went straight through the online checkout."""
    if doctype not in ("Sales Invoice", "POS Invoice") or frappe.db.exists(DOCTYPE, {"offline_id": offline_id}):
        return

    doc = frappe.get_doc(
        {
            "doctype": DOCTYPE,
            "offline_id": offline_id,
            "status": "Synced",
            "sales_invoice": invoice_name,
            "invoice_doctype": doctype,
            "pos_profile": invoice.get("pos_profile"),
            "customer": invoice.get("customer"),
            "cashier": frappe.session.user,
            "uploaded_by": frappe.session.user,
            "received_at": now_datetime(),
            "processed_at": now_datetime(),
            "synced_at": now_datetime(),
        }
    )
    doc.flags.ignore_permissions = True
    doc.flags.ignore_links = True
    doc.insert()


def _queue_job_id(pos_profile):
    return f"pos_sync_queue:{frappe.local.site}:{pos_profile or 'none'}"


def enqueue_processing(pos_profile):
    """Process a profile's queue in the background, oldest sale first."""
    frappe.enqueue(
        "pos_next.services.sync_inbox.process_profile_queue",
        queue="short",
        timeout=QUEUE_JOB_SECONDS,
        job_id=_queue_job_id(pos_profile),
        deduplicate=True,
        enqueue_after_commit=True,
        pos_profile=pos_profile,
    )


def _due_rows(pos_profile=None):
    filters = {"status": "Received"}
    if pos_profile:
        filters["pos_profile"] = pos_profile

    rows = frappe.get_all(DOCTYPE, filters=filters, pluck="name", order_by="client_created_at asc, seq asc")
    retries = frappe.get_all(
        DOCTYPE,
        filters={
            "status": "Retry Scheduled",
            "next_retry_at": ["<=", now_datetime()],
            **({"pos_profile": pos_profile} if pos_profile else {}),
        },
        pluck="name",
        order_by="client_created_at asc, seq asc",
    )
    return rows + retries


def process_profile_queue(pos_profile=None):
    """Work through a profile's due invoices. Backdated stock depends on this order.

    It reads the queue again when it runs out, because a push during this job queues no
    other. A long backlog ends cleanly before the job's limit, and the next job goes behind
    whatever else is waiting. Each row is tried once per job: one that stays due is the
    sweep's to bring back.
    """
    deadline = time.monotonic() + QUEUE_JOB_SECONDS - QUEUE_JOB_MARGIN_SECONDS
    tried = set()
    while names := [name for name in _due_rows(pos_profile) if name not in tried]:
        for name in names:
            if time.monotonic() >= deadline:
                _queue_next_turn(pos_profile)
                return
            tried.add(name)
            process(name)


def _queue_next_turn(pos_profile):
    """A running job holds its own id, so it takes another job to queue the next one."""
    frappe.enqueue(
        "pos_next.services.sync_inbox.take_next_turn",
        queue="short",
        job_id=f"pos_sync_next_turn:{frappe.local.site}:{pos_profile or 'none'}",
        deduplicate=True,
        enqueue_after_commit=True,
        pos_profile=pos_profile,
    )


def take_next_turn(pos_profile):
    """Queue a profile's next job once its last one has ended. If it has not, the sweep will."""
    for _second in range(NEXT_TURN_WAIT_SECONDS):
        if get_job_status(_queue_job_id(pos_profile)) != JobStatus.STARTED:
            break
        time.sleep(1)
    enqueue_processing(pos_profile)


def get_review_blockers(row):
    """The records in review a record waits for. A person has to act before it can go on.

    Args:
        row: The record, with depends_on

    Returns:
        list[str]: Their offline_ids
    """
    return [offline_id for offline_id, status in _get_unfinished_dependencies(row).items() if status == REVIEW]


def _flag_if_stuck(row):
    """Hand a waiting record to a person once what it needs will not come by itself."""
    if get_datetime(row.received_at) > add_to_date(now_datetime(), minutes=-MISSING_DEPENDENCY_MINUTES):
        return

    unfinished = _get_unfinished_dependencies(row)
    missing = [offline_id for offline_id, status in unfinished.items() if status is None]
    in_review = [offline_id for offline_id, status in unfinished.items() if status == REVIEW]

    if missing:
        message = _("{0} record(s) this depends on never reached the server: {1}").format(
            len(missing), ", ".join(missing)
        )
    elif in_review and row.entity == ENTITY_SHIFT_CLOSE:
        message = _("{0} invoice(s) of this shift need review first: {1}").format(
            len(in_review), ", ".join(in_review)
        )
    elif in_review:
        # Nothing moves a review on but a person, so this record would wait unseen
        message = _("This waits for {0} record(s) in review: {1}. Settle them first, and this goes on by itself.").format(
            len(in_review), ", ".join(in_review)
        )
    else:
        return

    # A device can void a waiting record at any moment, and that must not turn back into a review
    if frappe.db.get_value(DOCTYPE, row.name, "status", for_update=True) == "Blocked":
        _handle_failure(row.name, cint(row.attempts) + 1, WaitingForDependencyError(message), None, None)


def _requeue(name, expected, **conditions):
    """Put a row back in the queue unless someone moved it since it was read.

    A write by name could turn a row a manager just voided or resolved into Received, and
    the job would post it.
    """
    frappe.db.set_value(DOCTYPE, {"name": name, "status": expected, **conditions}, "status", "Received")


def _release_arrived_rows():
    """A record held for a missing dependency continues when that dependency arrives."""
    waiting = frappe.get_all(
        DOCTYPE,
        filters={"status": REVIEW, "error_code": WaitingForDependencyError.__name__},
        fields=["name", "depends_on"],
    )
    for row in waiting:
        if not _get_unfinished_dependencies(row):
            _requeue(row.name, REVIEW, error_code=WaitingForDependencyError.__name__)


def sweep():
    """Recover work nothing else will pick up. Runs every minute."""
    stale_before = add_to_date(now_datetime(), minutes=-STALE_PROCESSING_MINUTES)
    stale = frappe.get_all(
        DOCTYPE,
        filters={"status": "Processing", "modified": ["<", stale_before]},
        pluck="name",
    )
    for name in stale:
        _requeue(name, "Processing", modified=["<", stale_before])

    for name in frappe.get_all(DOCTYPE, filters={"status": "Blocked"}, pluck="name"):
        row = frappe.db.get_value(DOCTYPE, name, "*", as_dict=True)
        if row.status != "Blocked":
            continue

        if not _is_blocked(row):
            _requeue(name, "Blocked")
        else:
            _flag_if_stuck(row)

    _release_arrived_rows()

    frappe.db.commit()  # nosemgrep: scheduled job boundary

    profiles = {
        frappe.db.get_value(DOCTYPE, name, "pos_profile") for name in _due_rows()
    }
    for pos_profile in profiles:
        enqueue_processing(pos_profile)


def remind_about_reviews():
    """Tell managers about invoices left waiting. Runs every hour."""
    older_than = add_to_date(now_datetime(), hours=-4)
    waiting = frappe.get_all(
        DOCTYPE,
        filters={"status": REVIEW, "processed_at": ["<", older_than]},
        fields=["name", "pos_profile"],
    )
    by_profile = {}
    for row in waiting:
        by_profile.setdefault(row.pos_profile, []).append(row.name)

    for _pos_profile, names in by_profile.items():
        _notify_managers(names[0], _("{0} invoice(s) have waited over 4 hours").format(len(names)))


# ---------------------------------------------------------------------------
# Review actions, called from the sync center
# ---------------------------------------------------------------------------


def _review_row(name):
    row = frappe.get_doc(DOCTYPE, name)
    sync_retention.assert_not_cleared(row)
    if row.status != REVIEW:
        frappe.throw(_("Only an invoice that needs review can be changed"))
    return row


def _stamp_resolution(row, resolution, note):
    row.resolution = resolution
    row.resolution_note = note
    row.resolved_by = frappe.session.user
    row.resolved_at = now_datetime()


def reprocess(name, note=None):
    """Send a reviewed invoice through processing again, right now."""
    row = _review_row(name)
    # Nothing can change until the device sends it again, and its review must stay open
    if not row.payload:
        return row.as_dict()

    _stamp_resolution(row, "Reprocessed", note)
    row.status = "Received"
    row.attempts = 0
    row.flags.ignore_links = True
    row.save(ignore_permissions=True)
    frappe.db.commit()  # nosemgrep: process() manages its own transactions
    return process(name)


def _is_usable_document(doctype, name):
    if frappe.get_meta(doctype).is_submittable:
        return frappe.db.get_value(doctype, name, "docstatus") == 1
    return bool(frappe.db.exists(doctype, name))


def link_existing_invoice(name, invoice_name, doctype, note):
    """Close a review because the record was entered by hand.

    Records waiting for this one continue with the linked document.
    """
    if not note:
        frappe.throw(_("A note is required"))

    row = _review_row(name)
    if doctype not in _get_handler(row).doctypes:
        frappe.throw(_("Document type {0} is not allowed here").format(doctype))

    if not _is_usable_document(doctype, invoice_name):
        frappe.throw(_("{0} {1} does not exist or is not submitted").format(doctype, invoice_name))

    _stamp_resolution(row, "Linked to existing invoice", note)
    row.status = "Resolved"
    row.sales_invoice = invoice_name
    row.invoice_doctype = doctype
    row.save(ignore_permissions=True)
    _notify_uploader(name)
    return row


def void(name, note):
    """Close a review without an invoice, for the audit trail."""
    if not note:
        frappe.throw(_("A reason is required"))

    row = _review_row(name)
    _stamp_resolution(row, "Voided", note)
    row.status = "Voided"
    row.flags.ignore_links = True
    row.save(ignore_permissions=True)
    _notify_uploader(name)
    return row


def apply_fix(name, fix, values):
    """Correct the payload of a record under review.

    The original payload never changes, and every fix leaves a line in the attempt log.

    Args:
        name: Record name
        fix: One of the keys in _FIXES for the record's entity
        values: The fix's inputs

    Returns:
        Document: The updated record
    """
    row = _review_row(name)
    fixes = _FIXES[row.entity or ENTITY_INVOICE]
    if fix not in fixes:
        frappe.throw(_("Unknown fix {0}").format(fix))

    if fixes[fix] is None:
        row.set(fix, 1)
    else:
        payload = sync_entities.load_payload(row)
        named = sync_entities.get_local_names(payload)
        fixes[fix](payload, values)
        row.payload = frappe.as_json(payload, indent=1)
        replaced = set(named) - set(sync_entities.get_local_names(payload))
        if replaced:
            _forget_dependencies(row, replaced)
        # The date is now a person's, so the clock it came from no longer matters
        if fix == "posting_date":
            row.accept_device_date = 1
        # Closing a shift reads the row, so it must stay on the shift its payload now names
        if fix == "shift":
            row.shift = values["shift"]

    row.flags.ignore_links = True
    row.save(ignore_permissions=True)
    _log_attempt(name, f"fix: {fix}", message=frappe.as_json(values))
    return row


def _forget_dependencies(row, replaced):
    """Stop waiting for what a fix replaced. It may never arrive, which is why it was fixed."""
    lines = [line for line in (row.depends_on or "").splitlines() if line.strip() not in replaced]
    row.depends_on = "\n".join(lines)


def _fix_posting_date(payload, values):
    payload["posting_date"] = str(values["posting_date"])
    payload["set_posting_time"] = 1


def _fix_customer(payload, values):
    payload["customer"] = values["customer"]
    payload.pop("customer_name", None)


def _fix_warehouse(payload, values):
    for item in _items_matching(payload, values.get("item_code")):
        item["warehouse"] = values["warehouse"]


def _fix_replace_item(payload, values):
    for item in _items_matching(payload, values["item_code"]):
        item["item_code"] = values["new_item_code"]
        item.pop("item_name", None)


def _fix_batch(payload, values):
    for item in _items_matching(payload, values["item_code"]):
        item["batch_no"] = values["batch_no"]
        item["use_serial_batch_fields"] = 1


def _fix_payment_mode(payload, values):
    for row in payload.get("payments") or []:
        if row.get("mode_of_payment") == values["mode_of_payment"]:
            row["mode_of_payment"] = values["new_mode_of_payment"]
            row.pop("account", None)


def _fix_shift(payload, values):
    payload["posa_pos_opening_shift"] = values["shift"]


def _fix_link_shift(payload, values):
    sync_entities.assert_can_take_sales(values["shift"], payload.get("pos_profile"))
    payload["linked_shift"] = values["shift"]


def _items_matching(payload, item_code):
    return [
        item for item in payload.get("items") or [] if not item_code or item.get("item_code") == item_code
    ]


def _fix_remove_coupon(payload, _values):
    """The sale stays as it was paid. Only the coupon's usage is no longer counted."""
    payload.pop("coupon_code", None)
    payload.pop("pos_coupon_code", None)


def _fix_payment_amount(payload, values):
    for row in payload.get("payments") or []:
        if row.get("mode_of_payment") == values["mode_of_payment"]:
            row["amount"] = flt(values["amount"])


def _fix_customer_group(payload, values):
    payload["customer_group"] = values["customer_group"]


def _fix_territory(payload, values):
    payload["territory"] = values["territory"]


#: None marks a manager's approval, kept in the row's field of the same name
_FIXES = {
    ENTITY_INVOICE: {
        "posting_date": _fix_posting_date,
        "customer": _fix_customer,
        "warehouse": _fix_warehouse,
        "replace_item": _fix_replace_item,
        "batch": _fix_batch,
        "payment_mode": _fix_payment_mode,
        "shift": _fix_shift,
        "remove_coupon": _fix_remove_coupon,
        "accept_total_difference": None,
        "accept_device_date": None,
    },
    ENTITY_CUSTOMER: {
        "customer_group": _fix_customer_group,
        "territory": _fix_territory,
    },
    ENTITY_PAYMENT: {
        "posting_date": _fix_posting_date,
        "payment_mode": _fix_payment_mode,
        "payment_amount": _fix_payment_amount,
        "shift": _fix_shift,
        "accept_device_date": None,
    },
    ENTITY_SHIFT_CLOSE: {
        "accept_unfinished": None,
    },
    ENTITY_SHIFT_OPEN: {
        "link_shift": _fix_link_shift,
    },
}
