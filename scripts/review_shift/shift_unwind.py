"""Shift review: an outsider cancels a POS Invoice closing, and ERPNext's books are undone."""

import json
import uuid

import frappe
from lib import Session, check, connect, sale_payload, summary, wait_for
from pi_lib import COMPANY, close_shift, item, open_shift

PROF = "shift_Prof"
PIM = "PI Main"
SARA = "sara@real.local"
OMAR = "omar@real.local"

connect()

# Tidy the shift a refused closing left open on the throwaway profile
left = frappe.db.get_value("POS Opening Shift", {"pos_profile": PROF, "status": "Open", "docstatus": 1})
if left:
    from pos_next.pos_next.doctype.pos_closing_shift.pos_closing_shift import build_closing_shift, save_closing_shift

    closing = json.loads(json.dumps(build_closing_shift(json.dumps(frappe.get_doc("POS Opening Shift", left).as_dict(), default=str)), default=str))
    print("tidied", save_closing_shift(closing))
    frappe.db.commit()

sara, omar = Session(SARA), Session(OMAR)


def status(name):
    frappe.db.rollback()
    return frappe.db.get_value("POS Opening Shift", name, "status")


print("== H omar, off PI Main, cancels sara's PI Main closing")
busy = frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "pos_profile": PIM}, ["name", "user"])
if busy:
    print("PI Main is in use, skipped", busy)
else:
    p = open_shift(sara, PIM, 0)
    offline_id = f"pos_offline_{uuid.uuid4().hex}"
    payload = sale_payload(PIM, p, COMPANY, "POS Invoice", [item("ITEM-A", 1, 100)], "Walk-in", offline_id=offline_id)
    invoice = sara.call("pos_next.api.invoices.submit_invoice", invoice=payload, data={"offline_id": offline_id})["name"]
    close_shift(sara, p)
    frappe.db.rollback()
    cs, pce = frappe.db.get_value("POS Closing Shift", {"pos_opening_shift": p, "docstatus": 1}, ["name", "pos_closing_entry"])
    wait_for(lambda: frappe.db.get_value("POS Closing Entry", pce, "status") in ("Submitted", "Failed"), timeout=180, label="entry")
    merged = frappe.db.get_value("POS Invoice", invoice, "consolidated_invoice")
    print("closed:", cs, pce, frappe.db.get_value("POS Closing Entry", pce, "status"), "merged into", merged)
    res = omar.call("frappe.client.cancel", expect_error=True, doctype="POS Closing Shift", name=cs)
    print("omar cancel:", res if isinstance(res, dict) and res.get("status") else "ok")
    frappe.db.rollback()
    after = {
        "shift": status(p),
        "closing": frappe.db.get_value("POS Closing Shift", cs, "docstatus"),
        "entry": frappe.db.get_value("POS Closing Entry", pce, "docstatus"),
        "merged invoice": frappe.db.get_value("Sales Invoice", merged, "docstatus") if merged else None,
        "pos invoice": frappe.db.get_value("POS Invoice", invoice, ["status", "consolidated_invoice"]),
    }
    print("after:", after)
    check("omar undid PI Main's books and reopened sara's shift", after["entry"] == 2 and after["merged invoice"] == 2 and after["shift"] == "Open", after)
    if status(p) == "Open":
        close_shift(sara, p)

frappe.db.rollback()
print("left open by sara:", frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "user": SARA}, ["name", "pos_profile"]))
summary()
