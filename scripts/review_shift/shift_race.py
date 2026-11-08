"""Shift review: two openings at the same moment. Does the one-shift rule hold?"""

import threading

import frappe
from lib import Session, check, connect, summary
from pi_lib import COMPANY, close_shift

SI = "SI Main"
PIM = "PI Main"
SARA = "sara@real.local"
MANAGER = "manager@real.local"

connect()
sessions = {SARA: Session(SARA), MANAGER: Session(MANAGER)}


def race(pairs):
    results = [None] * len(pairs)
    barrier = threading.Barrier(len(pairs))

    def run(i, user, profile):
        barrier.wait()
        results[i] = sessions[user].call("pos_next.api.shifts.create_opening_shift", expect_error=True, pos_profile=profile, company=COMPANY, balance_details=[{"mode_of_payment": "Cash", "opening_amount": 0}])

    threads = [threading.Thread(target=run, args=(i, u, p)) for i, (u, p) in enumerate(pairs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return [r["pos_opening_shift"]["name"] if isinstance(r, dict) and "pos_opening_shift" in r else (r or {}).get("error") for r in results]


def tidy():
    frappe.db.rollback()
    for row in frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "user": ["in", [SARA, MANAGER]]}, ["name", "user"]):
        close_shift(sessions[row.user], row.name)


worst = {"same cashier": 0, "pos invoice profile": 0}
for attempt in range(4):
    frappe.db.rollback()
    if frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "pos_profile": PIM}):
        print("PI Main in use, stop")
        break
    got = race([(SARA, SI), (SARA, SI)])
    opened = [g for g in got if isinstance(g, str) and g.startswith("POSA-OS")]
    print(attempt, "sara twice on SI Main:", got)
    worst["same cashier"] = max(worst["same cashier"], len(opened))
    tidy()

    got = race([(SARA, PIM), (MANAGER, PIM)])
    opened = [g for g in got if isinstance(g, str) and g.startswith("POSA-OS")]
    frappe.db.rollback()
    entries = frappe.db.count("POS Opening Entry", {"pos_profile": PIM, "status": "Open", "docstatus": 1})
    print(attempt, "sara and manager on PI Main:", got, "open POS Opening Entries:", entries)
    worst["pos invoice profile"] = max(worst["pos invoice profile"], len(opened))
    tidy()

check("one open shift per cashier holds under a double click", worst["same cashier"] <= 1, worst)
check("one open shift on a POS Invoice profile holds under a race", worst["pos invoice profile"] <= 1, worst)
summary()
