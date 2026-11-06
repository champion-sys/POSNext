import frappe


def execute():
    """Map the old statuses. Old records have no payload, so they can only be reviewed."""
    table = frappe.qb.DocType("Offline Invoice Sync")

    for status in ("Pending", "Failed"):
        (
            frappe.qb.update(table)
            .set(table.status, "Needs Review")
            .set(table.error_class, "contract")
            .set(table.error_message, "Recorded before the sync log kept payloads")
            .where(table.status == status)
        ).run()

    (
        frappe.qb.update(table)
        .set(table.invoice_doctype, "Sales Invoice")
        .where(table.invoice_doctype.isnull() & table.sales_invoice.isnotnull())
    ).run()
