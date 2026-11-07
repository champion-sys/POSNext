import frappe


def execute():
    """Apps read one warehouse's Bin rows by (modified, name), and its newest stamp every minute."""
    frappe.db.add_index("Bin", ["warehouse", "modified", "name"], index_name="pos_sync_stock")
