# -*- coding: utf-8 -*-
# Copyright (c) 2020, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import cint
from frappe.model.document import Document


class POSOpeningShift(Document):
    def validate(self):
        self.validate_pos_profile_and_cashier()
        self.set_status()
        if self.docstatus == 1:
            self.validate_no_other_active_shift()

    def validate_no_other_active_shift(self):
        # Check for another open POS Opening Shift for this POS Profile
        existing_shift = frappe.db.get_value(
            "POS Opening Shift",
            {"pos_profile": self.pos_profile, "status": "Open", "name": ["!=", self.name], "docstatus": ["!=", 2]},
            ["name", "user"],
            as_dict=True
        )
        if existing_shift:
            frappe.throw(
                _("POS Profile {0} is already open in another POS Opening Shift ({1}).")
                .format(self.pos_profile, existing_shift.name, existing_shift.user)
            )

        # Check for an open POS Opening Entry for this POS Profile
        filters = {"pos_profile": self.pos_profile, "status": "Open"}
        if getattr(self, "pos_opening_entry", None):
            filters["name"] = ["!=", self.pos_opening_entry]

        existing_entry = frappe.db.get_value(
            "POS Opening Entry",
            filters,
            ["name", "user"],
            as_dict=True
        )
        if existing_entry:
            frappe.throw(
                _("POS Profile {0} has an open POS Opening Entry ({1}).")
                .format(self.pos_profile, existing_entry.name, existing_entry.user)
            )

    def validate_pos_profile_and_cashier(self):
        if self.company != frappe.db.get_value("POS Profile", self.pos_profile, "company"):
            frappe.throw(
                _("POS Profile {} does not belongs to company {}".format(self.pos_profile, self.company))
            )

        if not cint(frappe.db.get_value("User", self.user, "enabled")):
            frappe.throw(_("User {} has been disabled. Please select valid user/cashier".format(self.user)))

    def on_submit(self):
        self.set_status(update=True)
        invoice_type = frappe.db.get_value("POS Settings", {"pos_profile": self.pos_profile}, "invoice_type") or "Sales Invoice"
        if invoice_type == "POS Invoice":
            self.create_pos_opening_entry()

    def on_cancel(self):
        self.set_status(update=True)
        if getattr(self, "pos_opening_entry", None):
            if frappe.db.exists("POS Opening Entry", self.pos_opening_entry):
                poe_doc = frappe.get_doc("POS Opening Entry", self.pos_opening_entry)
                if poe_doc.docstatus == 1:
                    poe_doc.cancel()

    def create_pos_opening_entry(self):
        existing = frappe.db.get_value("POS Opening Entry", {"pos_profile": self.pos_profile, "status": "Open"}, "name")
        if existing:
            self.db_set("pos_opening_entry", existing)
            return

        poe = frappe.new_doc("POS Opening Entry")
        poe.pos_profile = self.pos_profile
        poe.user = self.user
        poe.company = self.company
        poe.posting_date = self.posting_date
        poe.period_start_date = self.period_start_date
        poe.set_posting_date = self.set_posting_date

        for row in self.balance_details:
            poe.append("balance_details", {
                "mode_of_payment": row.mode_of_payment,
                "opening_amount": row.amount
            })

        poe.insert(ignore_permissions=True)
        poe.submit()
        self.db_set("pos_opening_entry", poe.name)

    def set_status(self, update=False):
        """Set the status of the opening shift"""
        if self.docstatus == 0:
            status = "Draft"
        elif self.docstatus == 1:
            if self.pos_closing_shift:
                status = "Closed"
            else:
                status = "Open"
        else:
            status = "Cancelled"

        if update:
            frappe.db.set_value("POS Opening Shift", self.name, "status", status)
        else:
            self.status = status

