# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Stock held by submitted POS Invoices that no closing has consolidated yet.

A POS Invoice moves no stock until its closing merges it into a Sales Invoice, so
until then the Bin still counts goods that have already left the shop. ERPNext's own
POS subtracts them (erpnext.accounts.doctype.pos_invoice.pos_invoice.get_pos_reserved_qty),
and so must every quantity POS Next shows a cashier or checks a sale against.
"""

import frappe
from frappe.query_builder.functions import IfNull, Sum
from frappe.utils import flt, now

#: The tables ERPNext counts, with the column that holds the stock quantity
_RESERVING_TABLES = (("POS Invoice Item", "stock_qty"), ("Packed Item", "qty"))


def get_reserved_qty_map(item_codes, warehouses):
    """The stock quantity of each item that unconsolidated POS Invoices hold.

    The bulk form of ERPNext's get_pos_reserved_qty: the same rows, for many items and
    warehouses in one query per table. A return holds a negative quantity, so it gives
    back what it took.

    Args:
        item_codes: Item codes
        warehouses: Warehouses whose stock is summed together

    Returns:
        dict: item_code -> reserved quantity in the stock UOM. Items holding none are left out.
    """
    item_codes = sorted({code for code in item_codes or [] if code})
    warehouses = sorted({warehouse for warehouse in warehouses or [] if warehouse})
    if not item_codes or not warehouses:
        return {}

    invoice = frappe.qb.DocType("POS Invoice")
    reserved = {}
    for child_table, qty_column in _RESERVING_TABLES:
        row = frappe.qb.DocType(child_table)
        query = (
            frappe.qb.from_(invoice)
            .from_(row)
            .select(row.item_code, Sum(row[qty_column]).as_("qty"))
            .where(invoice.name == row.parent)
            .where(IfNull(invoice.consolidated_invoice, "") == "")
            .where(row.docstatus == 1)
            .where(row.item_code.isin(item_codes))
            .where(row.warehouse.isin(warehouses))
            .groupby(row.item_code)
        )
        if child_table == "Packed Item":
            query = query.where(row.parenttype == "POS Invoice")

        for entry in query.run(as_dict=True):
            if flt(entry.qty):
                reserved[entry.item_code] = reserved.get(entry.item_code, 0) + flt(entry.qty)

    return reserved


def subtract_reserved(stock_map, warehouses):
    """Take what POS Invoices hold out of a map of Bin quantities, in place.

    Args:
        stock_map: item_code -> quantity read from the Bin
        warehouses: The warehouses those quantities were summed over

    Returns:
        dict: The same map
    """
    for item_code, qty in get_reserved_qty_map(list(stock_map), warehouses).items():
        stock_map[item_code] = flt(stock_map.get(item_code)) - qty
    return stock_map


def touch_reserving_bins(doc, method=None):
    """Stamp the Bins of a POS Invoice's items when it is submitted or cancelled.

    Its stock changed although no ledger entry moved, and the stock pull of the apps
    walks Bins by their modified stamp. Without this they would keep showing the goods
    until the closing consolidates the invoice.
    """
    by_warehouse = {}
    for table in ("items", "packed_items"):
        for row in doc.get(table) or []:
            if row.get("item_code") and row.get("warehouse"):
                by_warehouse.setdefault(row.warehouse, set()).add(row.item_code)

    stamp = now()
    for warehouse, item_codes in by_warehouse.items():
        codes = sorted(item_codes)
        marks = ", ".join(["%s"] * len(codes))
        frappe.db.sql(
            f"UPDATE `tabBin` SET modified = %s WHERE warehouse = %s AND item_code IN ({marks})",
            [stamp, warehouse, *codes],
        )
