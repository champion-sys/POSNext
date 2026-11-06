import frappe


def execute():
    """Pull pages by (modified, name). These doctypes sort by creation, so nothing indexes it."""
    for doctype in ("Item", "Item Price", "Customer"):
        frappe.db.add_index(doctype, ["modified", "name"], index_name="pos_sync_cursor")
