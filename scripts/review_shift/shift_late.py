"""Shift review: online sales into a shift that is closed, a colleague's, or another profile's."""

import time
import uuid

import frappe
from lib import Session, check, connect, gl_of, sale_payload, summary, wait_for
from pi_lib import COMPANY, close_shift, item, open_shift

SI = "SI Main"
PIM = "PI Main"
PIS = "PI Second"
SARA = "sara@real.local"
LINA = "lina@real.local"
OMAR = "omar@real.local"

connect()
sara, omar, lina = Session(SARA), Session(OMAR), Session(LINA)


def status(name):
    frappe.db.rollback()
    return frappe.db.get_value("POS Opening Shift", name, "status")


def sell(session, profile, shift, doctype, qty=1, rate=100, expect_error=False):
    offline_id = f"pos_offline_{uuid.uuid4().hex}"
    payload = sale_payload(profile, shift, COMPANY, doctype, [item("ITEM-A", qty, rate)], "Walk-in", offline_id=offline_id)
    result = session.call("pos_next.api.invoices.submit_invoice", expect_error=expect_error, invoice=payload, data={"offline_id": offline_id})
    return result.get("name") if isinstance(result, dict) and "name" in result else result


def closing_sales(session, shift):
    data = session.call("pos_next.api.shifts.get_closing_shift_data", opening_shift=shift)
    cash = next(r for r in data["payment_reconciliation"] if r["mode_of_payment"] == "Cash")
    return [r.get("sales_invoice") or r.get("pos_invoice") for r in data["pos_transactions"]], cash["expected_amount"]


print("== F1 a Sales Invoice sold online into a shift already closed")
s1 = open_shift(sara, SI, 10)
close_shift(sara, s1)
late = sell(sara, SI, s1, "Sales Invoice", expect_error=True)
frappe.db.rollback()
row = frappe.db.get_value("Sales Invoice", late, ["docstatus", "posa_pos_opening_shift", "grand_total"], as_dict=True) if isinstance(late, str) else None
check("posted into the closed shift, counted in no closing", row and row.docstatus == 1 and status(s1) == "Closed", (late, row, status(s1)))

print("== F3 lina sells into sara's open shift; omar, off this profile, too")
s2 = open_shift(sara, SI, 0)
own = sell(sara, SI, s2, "Sales Invoice")
colleague = sell(lina, SI, s2, "Sales Invoice", expect_error=True)
outsider = sell(omar, PIS, s2, "Sales Invoice", expect_error=True)
print("lina:", colleague, " omar:", outsider)
sales, expected = closing_sales(sara, s2)
print("sara's closing:", sales, "expected cash", expected)
check("lina's sale lands in sara's drawer", colleague in sales, colleague)
check("omar's sale (profile PI Second) lands in sara's SI Main drawer", outsider in sales, outsider)
close_shift(sara, s2)

print("== F2 a POS Invoice sold online into a closed shift, while the next is open")
frappe.db.rollback()
busy = frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "pos_profile": PIM}, ["name", "user"])
if busy:
    print("PI Main is in use, skipped", busy)
else:
    p1 = open_shift(sara, PIM, 0)
    close_shift(sara, p1)
    p2 = open_shift(sara, PIM, 0)
    stale = sell(sara, PIM, p1, "POS Invoice", expect_error=True)
    current = sell(sara, PIM, p2, "POS Invoice")
    print("stale:", stale, "current:", current)
    close_shift(sara, p2)
    frappe.db.rollback()
    entry = frappe.db.get_value("POS Closing Shift", {"pos_opening_shift": p2, "docstatus": 1}, "pos_closing_entry")
    if entry:
        wait_for(lambda: frappe.db.get_value("POS Closing Entry", entry, "status") in ("Submitted", "Failed"), timeout=180, label="closing entry")
    if isinstance(stale, str):
        row = frappe.db.get_value("POS Invoice", stale, ["docstatus", "status", "consolidated_invoice", "posa_pos_opening_shift"], as_dict=True)
        print("stale POS Invoice:", row, "GL rows:", len(gl_of("POS Invoice", stale)))
        check("stale POS Invoice submitted, never merged, no books", row.docstatus == 1 and not row.consolidated_invoice and status(p1) == "Closed" and status(p2) == "Closed", row)

frappe.db.rollback()
print("left open by sara:", frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "user": SARA}, ["name", "pos_profile"]))
summary()
