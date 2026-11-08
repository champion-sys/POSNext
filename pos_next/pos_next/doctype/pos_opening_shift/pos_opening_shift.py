# Copyright (c) 2020, Youssef Restom and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, getdate, nowdate

from pos_next.services.sync_classifier import ShiftConflictError


class POSOpeningShift(Document):
    def validate(self):
        self.validate_pos_profile_and_cashier()
        self.set_status()
        if self.docstatus == 1:
            self.validate_no_other_active_shift()

    def takes_pos_invoices(self):
        return frappe.db.get_value("POS Settings", {"pos_profile": self.pos_profile}, "invoice_type") == "POS Invoice"

    def validate_no_other_active_shift(self):
        """One open shift for each cashier on a POS Profile, so colleagues can work it together.

        A POS Invoice profile keeps one for everyone: ERPNext takes a single open POS Opening
        Entry on a POS Profile, and with a second it refuses the sales of both.
        """
        from pos_next.api.shifts import lock_profile_for_opening

        pos_invoices = self.takes_pos_invoices()

        # Wait for any other opening on this POS Profile to finish, then read past this
        # transaction's snapshot, which a shift opened in the meantime is not in
        lock_profile_for_opening(self.pos_profile)

        filters = {"pos_profile": self.pos_profile, "status": "Open", "name": ["!=", self.name], "docstatus": ["!=", 2]}
        if not pos_invoices:
            filters["user"] = self.user

        existing_shift = frappe.db.get_value(
            "POS Opening Shift", filters, ["name", "user"], as_dict=True, for_update=True
        )
        if existing_shift:
            frappe.throw(
                _("POS Profile {0} is already open by {1} in shift {2}. Close that shift before opening yours.")
                .format(self.pos_profile, frappe.utils.get_fullname(existing_shift.user), existing_shift.name),
                ShiftConflictError,
            )

        # Sales Invoice shifts never touch the standard entry
        if not pos_invoices:
            return

        # Check for an open POS Opening Entry for this POS Profile
        filters = {"pos_profile": self.pos_profile, "status": "Open"}
        if getattr(self, "pos_opening_entry", None):
            filters["name"] = ["!=", self.pos_opening_entry]

        existing_entry = frappe.db.get_value(
            "POS Opening Entry",
            filters,
            ["name", "user", "period_start_date"],
            as_dict=True
        )
        if existing_entry and self.is_blocked_by_opening_entry(existing_entry):
            frappe.throw(
                _("POS Opening Entry {0} by {1} from {2} is still open for POS Profile {3}. Close it first.")
                .format(
                    existing_entry.name,
                    existing_entry.user,
                    frappe.utils.formatdate(existing_entry.period_start_date),
                    self.pos_profile,
                ),
                ShiftConflictError,
            )

    def is_blocked_by_opening_entry(self, entry):
        """Whether an open standard POS entry conflicts with this POS Invoice shift.

        POS Invoice sales depend on the entry, and ERPNext refuses them once it is from an
        earlier day, so only the user's own entry from today can be reused.
        """
        opened_today = getdate(entry.period_start_date) == getdate(self.period_start_date or nowdate())
        return not (entry.user == self.user and opened_today)

    def validate_pos_profile_and_cashier(self):
        if self.company != frappe.db.get_value("POS Profile", self.pos_profile, "company"):
            frappe.throw(
                _("POS Profile {0} does not belong to company {1}").format(self.pos_profile, self.company)
            )

        if not cint(frappe.db.get_value("User", self.user, "enabled")):
            frappe.throw(_("User {0} has been disabled. Please select valid user/cashier").format(self.user))

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

