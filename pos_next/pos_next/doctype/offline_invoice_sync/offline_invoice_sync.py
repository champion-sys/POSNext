# Copyright (c) 2025, BrainWise and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class OfflineInvoiceSync(Document):
    """The server's record of one queued sale.

    Maps an offline_id to its invoice, and keeps the payload and the error of a
    sale that could not be processed, so a manager can correct it. See
    pos_next.services.sync_inbox.
    """

    def validate(self):
        if self.is_new():
            return

        before = self.get_doc_before_save()
        if before and before.original_payload != self.original_payload:
            frappe.throw(_("The original payload cannot be changed"))
        if before and before.payload != self.payload and before.status != "Needs Review":
            frappe.throw(_("The payload can only change while the invoice needs review"))

    @staticmethod
    def is_synced(offline_id):
        """
        Check if an offline_id has already become an invoice.

        Args:
            offline_id: The offline ID to check

        Returns:
            dict with 'synced' (bool), 'sales_invoice' (str or None) and 'status' (str or None)
        """
        if not offline_id:
            return {"synced": False, "sales_invoice": None, "status": None}

        existing = frappe.db.get_value(
            "Offline Invoice Sync",
            {"offline_id": offline_id},
            ["sales_invoice", "status"],
            as_dict=True,
        )
        if not existing:
            return {"synced": False, "sales_invoice": None, "status": None}

        is_synced = existing.status in ("Synced", "Resolved") and bool(existing.sales_invoice)
        return {
            "synced": is_synced,
            "sales_invoice": existing.sales_invoice if is_synced else None,
            "status": existing.status,
        }
