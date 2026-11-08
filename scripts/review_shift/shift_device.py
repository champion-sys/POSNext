"""Shift review: a device enrolled for one POS Profile, used on another through the online API."""

import json
import time

import frappe
import requests
from lib import BASE, PASSWORD, Session, check, connect, errors_of, summary
from pi_lib import COMPANY, close_shift

ALLOWED = "SI Main"
OTHER = "PI Main"
SARA = "sara@real.local"
DEVICE_ID = "shift-probe-device-0001"

connect()
manager = Session("manager@real.local")
code = manager.call("pos_next.api.device.issue_enrollment_code", allowed_profiles=[ALLOWED])["code"]
enrolled = requests.post(f"{BASE}/api/method/pos_next.api.device.enroll", data={"enrollment_code": code, "device_id": DEVICE_ID, "device_name": "shift_probe", "platform": "android", "app_version": "t"}, timeout=60).json()["message"]
token = enrolled["device_token"]
login = requests.post(f"{BASE}/api/method/pos_next.api.device.cashier_login", data={"usr": SARA, "pwd": PASSWORD}, headers={"X-POS-Device-Token": token}, timeout=60).json()["message"]
print("device profiles for sara:", [p["name"] for p in login["profiles"]])
grant = login["grant"]


def call(method, **params):
    body = {k: (json.dumps(v) if isinstance(v, dict | list) else v) for k, v in params.items()}
    r = requests.post(f"{BASE}/api/method/{method}", data=body, headers={"Authorization": f"Bearer {grant}", "Accept": "application/json"}, timeout=120)
    data = r.json()
    return (r.status_code, data.get("message") if r.status_code == 200 else errors_of(data))


status, answer = call("pos_next.api.sync.push", items=[], device_id=DEVICE_ID, client_version="t", protocol_version=1, pos_profile=OTHER, device_time=int(time.time() * 1000))
print("control, sync push naming", OTHER, "->", status, str(answer)[:200])

frappe.db.rollback()
busy = frappe.get_all("POS Opening Shift", {"status": "Open", "docstatus": 1, "pos_profile": OTHER}, ["name", "user"])
if busy:
    print(OTHER, "in use, skipped", busy)
else:
    status, answer = call("pos_next.api.shifts.create_opening_shift", pos_profile=OTHER, company=COMPANY, balance_details=[{"mode_of_payment": "Cash", "opening_amount": 0}])
    shift = answer["pos_opening_shift"]["name"] if status == 200 else None
    check(f"a device enrolled for {ALLOWED} opens a shift on {OTHER}", status == 200, (status, shift or answer))
    if shift:
        close_shift(Session(SARA), shift)

call("pos_next.api.device.cashier_logout")
manager.call("pos_next.api.device.revoke_device", device=DEVICE_ID)
print("device revoked:", frappe.db.get_value("POS Device", DEVICE_ID, "status"))
summary()
