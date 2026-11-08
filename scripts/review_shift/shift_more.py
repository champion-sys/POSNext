"""Shift review: an outsider cancels a sale; a queued sale lands in a closed shift."""

import uuid

import frappe
from lib import Session, check, connect, sale_payload, summary
from pi_lib import COMPANY, close_shift, item, open_shift, push, queued_sale, wait_rows

SI = "SI Main"
SARA = "sara@real.local"
OMAR = "omar@real.local"

connect()
sara, omar = Session(SARA), Session(OMAR)

s = open_shift(sara, SI, 0)
offline_id = f"pos_offline_{uuid.uuid4().hex}"
payload = sale_payload(SI, s, COMPANY, "Sales Invoice", [item("ITEM-A", 1, 100)], "Walk-in", offline_id=offline_id)
sale = sara.call("pos_next.api.invoices.submit_invoice", invoice=payload, data={"offline_id": offline_id})["name"]

print("== I omar, off SI Main, cancels sara's sale through the standard API")
res = omar.call("frappe.client.cancel", expect_error=True, doctype="Sales Invoice", name=sale)
frappe.db.rollback()
state = frappe.db.get_value("Sales Invoice", sale, ["docstatus", "modified_by"], as_dict=True)
check("SI Main sale cancelled by omar", state.docstatus == 2 and state.modified_by == OMAR, (res if isinstance(res, dict) else "ok", state))

print("== J a queued Sales Invoice for a shift closed meanwhile")
close_shift(sara, s)
entry = queued_sale(SI, s, SARA, 1, [item("ITEM-A", 1, 100)], doctype="Sales Invoice")
push(sara, [entry])
row = wait_rows([entry["offline_id"]], timeout=120)[0]
frappe.db.rollback()
shift_status = frappe.db.get_value("POS Opening Shift", s, "status")
inv = frappe.db.get_value("Sales Invoice", row.sales_invoice, ["docstatus", "posa_pos_opening_shift"], as_dict=True) if row.sales_invoice else None
print(row.status, row.sales_invoice, inv, "shift", shift_status)
check("synced into the closed shift, with no warning", row.status == "Synced" and inv and inv.posa_pos_opening_shift == s and shift_status == "Closed", (row.status, row.error_code))
summary()
