"""Shift review: a profile with a closing role. Who can close a cashier's shift there?"""

import frappe
from lib import Session, check, connect, summary
from pi_lib import COMPANY, close_shift, open_shift

PROF = "shift_Prof"
SARA = "sara@real.local"
MANAGER = "manager@real.local"
ROLE = "Nexus POS Manager"

connect()
if not frappe.db.exists("POS Profile", PROF):
    profile = frappe.copy_doc(frappe.get_doc("POS Profile", "SI Main"))
    profile.name = PROF
    profile.set("applicable_for_users", [])
    profile.insert(set_name=PROF, ignore_permissions=True)
    settings = frappe.copy_doc(frappe.get_doc("POS Settings", {"pos_profile": "SI Main"}))
    settings.pos_profile = PROF
    settings.allow_offline_shift_open = 0
    settings.insert(ignore_permissions=True)
profile = frappe.get_doc("POS Profile", PROF)
profile.role_allowed_to_closing_shift = ROLE
profile.set("applicable_for_users", [{"user": SARA}, {"user": MANAGER}])
profile.save(ignore_permissions=True)
frappe.db.commit()
print("closing role:", ROLE, "| sara has it:", ROLE in frappe.get_roles(SARA), "| manager has it:", ROLE in frappe.get_roles(MANAGER))

sara, manager = Session(SARA), Session(MANAGER)


def status(name):
    frappe.db.rollback()
    return frappe.db.get_value("POS Opening Shift", name, "status")


frappe.db.rollback()
s = frappe.db.get_value("POS Opening Shift", {"user": SARA, "pos_profile": PROF, "status": "Open", "docstatus": 1}) or open_shift(sara, PROF, 10)
print("sara's shift", s)

print("== sara may not close it (as intended)")
own = sara.call("pos_next.api.shifts.get_closing_shift_data", expect_error=True, opening_shift=s)
check("sara refused", isinstance(own, dict) and own.get("status") == 403, own.get("error") if isinstance(own, dict) else own)

print("== the manager, who has the role, closes it")
closing, done = close_shift(manager, s)
check("manager can close a cashier's shift on a profile with a closing role", status(s) == "Closed", (done, status(s)))

if status(s) == "Open":
    # Undo the role on this throwaway profile only, close as the cashier, put it back
    frappe.db.set_value("POS Profile", PROF, "role_allowed_to_closing_shift", None)
    frappe.db.commit()
    close_shift(sara, s)
    frappe.db.set_value("POS Profile", PROF, "role_allowed_to_closing_shift", ROLE)
    frappe.db.commit()
    print("tidied, shift now", status(s))
summary()
