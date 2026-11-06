# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""What the queued records other than sales become on the server.

Everything here runs inside sync_inbox.process, in its transaction, and raises on any
failure, so the record and its Synced status commit together or not at all.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from pos_next.services.sync_classifier import DependencyError, SyncContractError

DOCTYPE = "Offline Invoice Sync"

FINAL_STATES = ("Synced", "Resolved", "Voided")

ENTITY_INVOICE = "invoice"
ENTITY_CUSTOMER = "customer"
ENTITY_PAYMENT = "payment"
ENTITY_SHIFT_CLOSE = "shift_close"

ENTITIES = (ENTITY_INVOICE, ENTITY_CUSTOMER, ENTITY_PAYMENT, ENTITY_SHIFT_CLOSE)

#: Names the device gives records the server has not seen yet
LOCAL_NAME_PREFIX = "pos_offline_"

#: Payload fields that may hold such a name
LOCAL_NAME_FIELDS = ("customer", "return_against")


def is_local_name(value):
    return isinstance(value, str) and value.startswith(LOCAL_NAME_PREFIX)


def load_payload(row):
    try:
        return json.loads(row.payload)
    except (TypeError, ValueError) as exc:
        raise SyncContractError(_("The stored payload is not valid JSON")) from exc


def get_dependencies(payload, declared=None):
    """Records this one needs, including those the payload itself refers to.

    A device can leave one out of depends_on, and the record must still wait for it. A
    shift close waits for its whole manifest, which is how a missing sale gets noticed.

    Args:
        payload: The queued record
        declared: Offline IDs the device listed

    Returns:
        list[str]: Offline IDs, without repeats
    """
    implied = [payload.get(fieldname) for fieldname in LOCAL_NAME_FIELDS]
    candidates = [*(declared or []), *(payload.get("manifest") or []), *filter(is_local_name, implied)]
    return list(dict.fromkeys(value for value in candidates if isinstance(value, str) and value))


def _get_server_name(local_name):
    row = frappe.db.get_value(DOCTYPE, {"offline_id": local_name}, ["status", "sales_invoice"], as_dict=True)
    if not row or row.status not in ("Synced", "Resolved") or not row.sales_invoice:
        raise DependencyError(_("Record {0} that this depends on was voided or never arrived").format(local_name))
    return row.sales_invoice


def resolve_local_names(payload):
    """Replace names that only exist on the device with what the server made of them.

    Only the copy being processed changes. The stored payload stays what the device
    sent, so a resend still matches its hash.
    """
    for fieldname in LOCAL_NAME_FIELDS:
        if is_local_name(payload.get(fieldname)):
            payload[fieldname] = _get_server_name(payload[fieldname])
            if fieldname == "customer":
                payload.pop("customer_name", None)


def _get_return_row_positions(doctype, invoice):
    """Item row names of an invoice by their position on it."""
    return dict(
        frappe.get_all(f"{doctype} Item", filters={"parent": invoice}, fields=["idx", "name"], as_list=True)
    )


def align_return(payload):
    """Hold a queued return to what an online return goes through.

    Preparing it applies every rule of the online path, on the day of the return. A return
    of a sale that was still in the queue also takes its item links and rates from there,
    because the device could not know them, and ERPNext ignores rows without a link.
    """
    from pos_next.api.invoices import _prepare_return_invoice

    prepared = _prepare_return_invoice(
        payload["return_against"],
        payload.get("posa_pos_opening_shift"),
        as_of=payload.get("posting_date"),
    )
    # A manager may have moved the original to another customer while it waited
    payload["customer"] = prepared["customer"]

    doctype = prepared["doctype"]
    link_field = "pos_invoice_item" if doctype == "POS Invoice" else "sales_invoice_item"
    unlinked = [item for item in payload.get("items") or [] if not item.get(link_field)]
    if not unlinked:
        return

    positions = _get_return_row_positions(doctype, payload["return_against"])
    prepared_rows = {row[link_field]: row for row in prepared["items"]}

    for item in unlinked:
        row = prepared_rows.get(positions.get(cint(item.pop("original_idx", 0))))
        if not row or row["item_code"] != item.get("item_code"):
            frappe.throw(
                _("Item {0} has nothing left to return on invoice {1}").format(
                    item.get("item_code"), payload["return_against"]
                )
            )

        item[link_field] = row[link_field]
        for fieldname in ("rate", "uom", "warehouse", "conversion_factor"):
            item[fieldname] = row[fieldname]


def has_pending_close(opening_shift):
    """Whether a shift was closed on a device and the server is still finishing it."""
    return bool(
        frappe.db.exists(
            DOCTYPE,
            {
                "entity": ENTITY_SHIFT_CLOSE,
                "shift": opening_shift,
                "status": ["not in", FINAL_STATES],
            },
        )
    )


def find_customer(offline_id):
    name = frappe.db.get_value("Customer", {"offline_id": offline_id}, "name")
    return {"name": name, "doctype": "Customer", "customer": name} if name else None


def create_customer(row):
    """Create the customer a device added while offline, as the cashier who added it."""
    from pos_next.api.customers import insert_customer

    payload = load_payload(row)
    if not payload.get("customer_name"):
        raise SyncContractError(_("The customer has no name"))

    if not frappe.has_permission("Customer", "create", user=row.cashier):
        frappe.throw(_("{0} is not allowed to create customers").format(row.cashier), frappe.PermissionError)

    customer = insert_customer(
        customer_name=payload["customer_name"],
        mobile_no=payload.get("mobile_no"),
        email_id=payload.get("email_id"),
        customer_group=payload.get("customer_group"),
        territory=payload.get("territory"),
        company=payload.get("company"),
        pos_profile=payload.get("pos_profile") or row.pos_profile,
        offline_id=row.offline_id,
        ignore_permissions=True,
    )
    return {"name": customer.name, "doctype": "Customer", "customer": customer.name}


def find_payment(offline_id):
    from pos_next.api.partial_payments import get_payment_key

    entry = frappe.db.get_value(
        "Payment Entry",
        {"offline_id": get_payment_key(offline_id), "docstatus": 1},
        ["name", "paid_amount"],
        as_dict=True,
    )
    if not entry:
        return None
    return {"name": entry.name, "doctype": "Payment Entry", "grand_total": entry.paid_amount}


def create_payment(row):
    """Post a payment taken offline on an invoice that already exists.

    Stored once under its offline_id and keyed by it on the Payment Entry, so a resend
    or a second worker cannot take the money twice.
    """
    from pos_next.api.invoices import _assert_invoice_write_access
    from pos_next.api.partial_payments import post_queued_payments
    from pos_next.api.utilities import get_wallet_payment_modes

    payload = load_payload(row)
    invoice_name = payload.get("invoice_name")
    payments = payload.get("payments")
    if not invoice_name or not payments:
        raise SyncContractError(_("The payment has no invoice or no amounts"))

    pos_profile = frappe.db.get_value("Sales Invoice", invoice_name, "pos_profile") or row.pos_profile
    _assert_invoice_write_access("Sales Invoice", pos_profile, row.cashier)

    wallet_modes = set(get_wallet_payment_modes())
    if any(payment.get("mode_of_payment") in wallet_modes for payment in payments):
        frappe.throw(_("A wallet balance cannot be spent offline"))

    entries = post_queued_payments(
        invoice_name,
        payments,
        payload.get("posting_date"),
        payload.get("posa_pos_opening_shift"),
        row.offline_id,
    )
    if not entries:
        raise SyncContractError(_("The payment has no amounts"))

    return {
        "name": entries[0],
        "doctype": "Payment Entry",
        "grand_total": sum(flt(payment.get("amount")) for payment in payments),
        "note": ", ".join(entries),
    }


def find_shift_close(_offline_id):
    """Always None. The closing commits with its row, and if someone else closed the
    shift, the cashier's count must reach a person rather than disappear."""
    return None


def _apply_counted_amounts(closing, counted):
    amounts = {row.get("mode_of_payment"): flt(row.get("closing_amount")) for row in counted or []}

    for detail in closing["payment_reconciliation"]:
        detail["closing_amount"] = amounts.pop(detail["mode_of_payment"], 0)

    # Counted money with nothing expected against it must still show up as a difference
    for mode_of_payment, amount in amounts.items():
        closing["payment_reconciliation"].append(
            {
                "mode_of_payment": mode_of_payment,
                "opening_amount": 0,
                "expected_amount": 0,
                "closing_amount": amount,
            }
        )


def close_shift(row):
    """Finalize a shift closed on a device, once everything it depends on has finished.

    The totals are worked out here, from what the server holds. The device only says
    what the cashier counted, and when.
    """
    from pos_next.api.invoices import _assert_invoice_write_access
    from pos_next.api.shifts import assert_may_close_shift
    from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import (
        make_closing_shift_from_opening,
        save_closing_shift,
    )

    payload = load_payload(row)
    opening_shift = payload.get("pos_opening_shift")
    if not opening_shift or not frappe.db.exists("POS Opening Shift", opening_shift):
        raise SyncContractError(_("Shift {0} does not exist").format(opening_shift))

    opening = frappe.get_doc("POS Opening Shift", opening_shift)
    _assert_invoice_write_access("Sales Invoice", opening.pos_profile, row.cashier)
    assert_may_close_shift(opening, row.cashier)

    closing = json.loads(
        json.dumps(make_closing_shift_from_opening(json.dumps(opening.as_dict(), default=str)), default=str)
    )
    _apply_counted_amounts(closing, payload.get("closing_amounts"))
    closing["period_end_date"] = payload.get("period_end_date") or closing["period_end_date"]
    closing["posting_date"] = payload.get("posting_date") or closing["posting_date"]

    name = save_closing_shift(closing)
    return {"name": name, "doctype": "POS Closing Shift", "grand_total": closing.get("grand_total")}
