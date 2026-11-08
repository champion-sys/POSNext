# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Create and submit one POS invoice.

The single path behind the online checkout and the sync inbox. Everything here
runs in the caller's transaction and raises on any failure, so the caller either
commits a complete sale or rolls back all of it.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from pos_next.api.invoices import (
    DOCTYPE_SALES_INVOICE,
    FIELD_IS_RATE_MANUALLY_EDITED,
    FIELD_ITEM_CODE,
    FIELD_ORIGINAL_RATE,
    FIELD_PRICE_LIST_RATE,
    FIELD_RATE,
    _apply_write_off,
    _assert_invoice_write_access,
    _auto_set_return_batches,
    _set_payment_accounts,
    _validate_stock_on_invoice,
    log_manual_rate_edit,
    save_invoice_draft,
)


def process_invoice(invoice, data, doctype, pos_profile, offline_id=None, queued=False):
    """Create the draft if needed, then submit it.

    Args:
        invoice: Invoice payload, with or without a server name
        data: Submission extras such as write-off and customer credit
        doctype: Sales Invoice, POS Invoice or Sales Order
        pos_profile: POS Profile name
        offline_id: Stable id of the sale
        queued: The sale already happened offline. Only the sync queue passes this.

    Returns:
        dict: Summary of the submitted invoice
    """
    invoice_name = invoice.get("name")
    coupon_overrun = None

    # Get or create invoice
    if not invoice_name or not frappe.db.exists(doctype, invoice_name):
        created = save_invoice_draft(json.dumps(invoice), queued=queued)
        if not created or not isinstance(created, dict):
            frappe.throw(_("Failed to create invoice draft"))
        invoice_name = created.get("name")
        coupon_overrun = created.get("coupon_overrun")
        if not invoice_name:
            frappe.throw(_("Failed to get invoice name from draft"))
        invoice_doc = frappe.get_doc(doctype, invoice_name)
    else:
        invoice_doc = frappe.get_doc(doctype, invoice_name)
        _assert_invoice_write_access(doctype, invoice_doc.get("pos_profile"))
        invoice_doc.update(invoice)

    # Ensure update_stock is set for Sales/POS Invoice
    if doctype in ("Sales Invoice", "POS Invoice"):
        invoice_doc.update_stock = 1

        # The unique index is the last line of defence against a duplicate sale
        if offline_id:
            invoice_doc.offline_id = offline_id

    # For return invoices, set update_outstanding_for_self = 0
    # This ensures the GL entry's against_voucher points to the original invoice,
    # which properly reduces the original invoice's outstanding amount and
    # sets its status to "Credit Note Issued"
    if invoice_doc.get("is_return") and invoice_doc.get("return_against"):
        invoice_doc.update_outstanding_for_self = 0

    # Copy accounting dimensions from POS Profile if not already set
    if pos_profile and not invoice_doc.get("branch"):
        try:
            pos_profile_doc = frappe.get_cached_doc("POS Profile", pos_profile)
            if hasattr(pos_profile_doc, "branch") and pos_profile_doc.branch:
                invoice_doc.branch = pos_profile_doc.branch
                # Also set branch on all items for GL entries
                for item in invoice_doc.get("items", []):
                    if not item.get("branch"):
                        item.branch = pos_profile_doc.branch
        except Exception as e:
            # Branch is optional, log and continue
            frappe.log_error(
                f"Failed to set branch from POS Profile {pos_profile}: {e}",
                "POS Profile Branch"
            )

    # Set accounts for all payment methods before saving
    if doctype in ("Sales Invoice", "POS Invoice") and hasattr(invoice_doc, "payments"):
        _set_payment_accounts(invoice_doc.payments, invoice_doc.company)

    # Handle sales team (multiple sales persons)
    sales_team_data = invoice.get("sales_team") or data.get("sales_team")
    if sales_team_data and isinstance(sales_team_data, list):
        # Clear existing sales team entries
        invoice_doc.sales_team = []

        # Add new sales team entries
        for member in sales_team_data:
            if member and isinstance(member, dict):
                invoice_doc.append("sales_team", {
                    "sales_person": member.get("sales_person"),
                    "allocated_percentage": member.get("allocated_percentage", 0),
                })

    # Auto-set batch numbers for returns
    _auto_set_return_batches(invoice_doc)

    # Handle write-off amount if provided
    write_off_amount = flt(data.get("write_off_amount") or invoice.get("write_off_amount") or 0)
    if write_off_amount > 0 and doctype == "Sales Invoice":
        if pos_profile:
            _apply_write_off(invoice_doc, write_off_amount, pos_profile)

    # Validate stock availability before submission
    # _validate_stock_on_invoice checks _should_block internally
    # (global Stock Settings, POS Settings, and POS Profile flags)
    _validate_stock_on_invoice(invoice_doc)

    # Allow pure customer-credit POS sales to submit without a payment row.
    customer_credit_dict = data.get("customer_credit_dict") or invoice.get("customer_credit_dict")
    redeemed_customer_credit = data.get("redeemed_customer_credit") or invoice.get("redeemed_customer_credit")
    if redeemed_customer_credit and not invoice_doc.payments:
        invoice_doc.flags.pos_next_redeemed_customer_credit = flt(redeemed_customer_credit)

    # Save before submit
    invoice_doc.flags.ignore_permissions = True
    frappe.flags.ignore_account_permission = True
    invoice_doc.save()

    # Submit invoice
    invoice_doc.submit()
    # Everything below is part of the sale. A failure rolls back the invoice,
    # so the books can never hold an invoice with half of its effects.
    # _apply_coupon may have moved the code off coupon_code. A return inherits the field
    # from its sale, and redeems nothing.
    coupon_code = invoice_doc.get("pos_coupon_code") or invoice.get("coupon_code") or data.get("coupon_code")
    if coupon_code and not invoice_doc.get("is_return") and frappe.db.table_exists("POS Coupon"):
        from pos_next.pos_next.doctype.pos_coupon.pos_coupon import increment_coupon_usage

        increment_coupon_usage(coupon_code)

    if invoice_doc.get("is_return") and invoice_doc.get("return_against"):
        from pos_next.pos_next.doctype.wallet_transaction.wallet_transaction import (
            reverse_wallet_transactions_for_return,
        )

        reverse_wallet_transactions_for_return(
            original_invoice=invoice_doc.return_against,
            return_invoice=invoice_doc.name,
        )

    # Credit the return to the customer's wallet when "Add to Customer Credit Balance" is on
    if invoice_doc.get("is_return") and invoice.get("add_to_customer_balance"):
        from pos_next.pos_next.doctype.wallet_transaction.wallet_transaction import credit_return_to_wallet

        credit_return_to_wallet(
            return_invoice=invoice_doc.name,
            amount=abs(flt(invoice_doc.grand_total)),
        )

    # Redeeming credit is part of the payment
    if redeemed_customer_credit and customer_credit_dict:
        from pos_next.api.credit_sales import redeem_customer_credit

        redeem_customer_credit(invoice_doc.name, customer_credit_dict)

    # Log manual rate edits for audit trail (only after successful submission)
    if doctype == DOCTYPE_SALES_INVOICE:
        incoming_items = invoice.get("items") or []
        for item in incoming_items:
            if cint(item.get(FIELD_IS_RATE_MANUALLY_EDITED)):
                log_manual_rate_edit({
                    FIELD_ITEM_CODE: item.get(FIELD_ITEM_CODE),
                    "item_name": item.get("item_name"),
                    FIELD_RATE: flt(item.get(FIELD_RATE)),
                    FIELD_ORIGINAL_RATE: flt(item.get(FIELD_ORIGINAL_RATE) or item.get(FIELD_PRICE_LIST_RATE)),
                    FIELD_IS_RATE_MANUALLY_EDITED: 1
                }, invoice_doc.name)

    # Return complete invoice details
    result = {
        "name": invoice_doc.name,
        "status": invoice_doc.docstatus,
        "grand_total": invoice_doc.grand_total,
        "total": invoice_doc.total,
        "net_total": invoice_doc.net_total,
        "outstanding_amount": getattr(invoice_doc, "outstanding_amount", 0),
        "paid_amount": getattr(invoice_doc, "paid_amount", 0),
        "change_amount": getattr(invoice_doc, "change_amount", 0),
    }

    # Include offline_id in response for client-side tracking
    if offline_id:
        result["offline_id"] = offline_id

    if coupon_overrun:
        result["coupon_overrun"] = coupon_overrun

    return result

