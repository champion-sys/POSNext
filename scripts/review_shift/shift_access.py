"""Shift review: what a one-role cashier can do to shifts outside their own, over real HTTP."""

import uuid

import frappe
from lib import Session, check, connect, sale_payload, summary
from pi_lib import COMPANY, close_shift, item, open_shift

SI = "SI Main"
PIM = "PI Main"
SARA = "sara@real.local"
LINA = "lina@real.local"
OMAR = "omar@real.local"

connect()
sara, omar, lina = Session(SARA), Session(OMAR), Session(LINA)
print("omar roles", [r for r in frappe.get_roles(OMAR) if r not in ("All", "Guest")])
print("omar on profiles", frappe.get_all("POS Profile User", {"user": OMAR}, pluck="parent"))


def status(name):
    frappe.db.rollback()
    return frappe.db.get_value("POS Opening Shift", name, "status")


def sell(session, profile, shift, doctype, qty=2, rate=100):
    offline_id = f"pos_offline_{uuid.uuid4().hex}"
    payload = sale_payload(profile, shift, COMPANY, doctype, [item("ITEM-A", qty, rate)], "Walk-in", offline_id=offline_id)
    return session.call("pos_next.api.invoices.submit_invoice", invoice=payload, data={"offline_id": offline_id})["name"]


print("== A omar reads every shift and closing through the standard API")
shifts = omar.call("frappe.client.get_list", doctype="POS Opening Shift", fields=["name", "user", "pos_profile", "status"], limit_page_length=0)
foreign = [s for s in shifts if s["pos_profile"] in (SI, PIM)]
check("omar lists shifts of profiles he is not on", len(foreign) > 0, f"{len(foreign)} of {len(shifts)}; e.g. {foreign[:2]}")
closings = omar.call("frappe.client.get_list", doctype="POS Closing Shift", fields=["name", "user", "pos_profile", "grand_total"], filters={"pos_profile": SI}, limit_page_length=3)
one = omar.call("frappe.client.get", doctype="POS Closing Shift", name=closings[0]["name"]) if closings else None
check("omar reads a SI Main closing with its cash count", bool(one), one and [(r["mode_of_payment"], r["expected_amount"], r["closing_amount"]) for r in one["payment_reconciliation"]])
refused = omar.call("pos_next.api.shifts.get_closing_shift_data", expect_error=True, opening_shift=foreign[0]["name"])
print("control: the POS API refuses him:", refused)

print("== B omar cancels sara's empty SI Main shift")
s0 = open_shift(sara, SI, 5)
res = omar.call("frappe.client.cancel", expect_error=True, doctype="POS Opening Shift", name=s0)
check("omar cancelled sara's open shift", status(s0) == "Cancelled", (res, status(s0)))
if status(s0) == "Open":
    close_shift(sara, s0)

print("== C omar closes sara's SI Main shift by inserting a POS Closing Shift")
s1 = open_shift(sara, SI, 30)
inv = sell(sara, SI, s1, "Sales Invoice")
print("sara sold", inv)
doc = {
    "doctype": "POS Closing Shift",
    "pos_opening_shift": s1,
    "pos_profile": SI,
    "company": COMPANY,
    "user": SARA,
    "period_start_date": frappe.utils.now(),
    "period_end_date": frappe.utils.now(),
    "posting_date": frappe.utils.nowdate(),
    "grand_total": 0,
    "payment_reconciliation": [{"mode_of_payment": "Cash", "opening_amount": 30, "expected_amount": 0, "closing_amount": 0}],
    "docstatus": 1,
}
res = omar.call("frappe.client.insert", expect_error=True, doc=doc)
print("insert:", res if isinstance(res, dict) and res.get("status") else (res or {}).get("name"))
frappe.db.rollback()
made = frappe.db.get_value("POS Closing Shift", {"pos_opening_shift": s1, "docstatus": 1}, ["name", "owner", "grand_total"], as_dict=True)
check("sara's shift closed by omar, with no sales and nothing expected", status(s1) == "Closed" and made and made.owner == OMAR, (status(s1), made))

print("== D omar cancels that closing, sara's shift opens again")
if made:
    res = omar.call("frappe.client.cancel", expect_error=True, doctype="POS Closing Shift", name=made.name)
    check("reopened by omar's cancel", status(s1) == "Open", (res, status(s1)))

print("== E lina (colleague) closes sara's shift, through the POS API, with her own totals")
if status(s1) == "Open":
    closing = lina.call("pos_next.api.shifts.get_closing_shift_data", opening_shift=s1)
    cash = next(r for r in closing["payment_reconciliation"] if r["mode_of_payment"] == "Cash")
    print("server says: expected", cash["expected_amount"], "grand_total", closing["grand_total"], "sales", [r.get("sales_invoice") for r in closing["pos_transactions"]])
    cash["expected_amount"] = 30
    cash["closing_amount"] = 30
    closing["grand_total"] = 0
    closing["net_total"] = 0
    closing["pos_transactions"] = []
    closing["taxes"] = []
    res = lina.call("pos_next.api.shifts.submit_closing_shift", expect_error=True, closing_shift=closing)
    print("submit:", res)
    frappe.db.rollback()
    name = frappe.db.get_value("POS Closing Shift", {"pos_opening_shift": s1, "docstatus": 1}, "name")
    stored = frappe.get_doc("POS Closing Shift", name) if name else None
    if stored:
        row = stored.payment_reconciliation[0]
        print("stored:", stored.name, "owner", stored.owner, "grand_total", stored.grand_total, "rows", len(stored.pos_transactions), "cash", row.expected_amount, row.closing_amount, row.difference)
        check("lina closed sara's shift", stored.owner == LINA and status(s1) == "Closed")
        check("stored closing hides the 230 sale and a 230 shortage", row.expected_amount == 30 and row.difference == 0 and not stored.pos_transactions, (row.expected_amount, row.difference))
        print("sale's pos_closing_entry:", frappe.db.get_value("Sales Invoice", inv, "pos_closing_entry"))

frappe.db.rollback()
print("left open by sara:", frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "user": SARA}, ["name", "pos_profile"]))
summary()
