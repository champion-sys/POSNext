# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""What the queued records other than sales become on the server.

Everything here runs inside sync_inbox.process, in its transaction, and raises on any
failure, so the record and its Synced status commit together or not at all.
"""

import json

import frappe
from frappe import _

from pos_next.services.sync_classifier import DependencyError, SyncContractError

DOCTYPE = "Offline Invoice Sync"

ENTITY_INVOICE = "invoice"
ENTITY_CUSTOMER = "customer"

ENTITIES = (ENTITY_INVOICE, ENTITY_CUSTOMER)

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

    A device can leave one out of depends_on, and the record must still wait for it.

    Args:
        payload: The queued record
        declared: Offline IDs the device listed

    Returns:
        list[str]: Offline IDs, without repeats
    """
    implied = [payload.get(fieldname) for fieldname in LOCAL_NAME_FIELDS]
    candidates = [*(declared or []), *filter(is_local_name, implied)]
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
