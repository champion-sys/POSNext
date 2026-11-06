# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Incremental pull: the device asks what changed instead of downloading the catalog again."""

import hashlib
import json
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, now, now_datetime, nowdate

from pos_next.api.customers import CUSTOMER_RESULT_FIELDS, _get_profile_customer_filters
from pos_next.api.items import (
    _build_item_base_conditions,
    _enrich_items_bulk,
    _get_allowed_profile_brands,
    _get_item_group_with_descendants,
    _select_item_rows,
)
from pos_next.api.offers import _get_offers
from pos_next.api.pos_profile import _get_tax_rows, get_payment_methods, get_pos_profile_data
from pos_next.api.sync import _assert_pos_user

DEFAULT_PAGE_SIZE = 500
MAX_PAGE_SIZE = 2000

#: `modified` is stamped before commit, so a slow transaction can land behind a cursor
#: that has already passed it. A finished walk steps back this far to read it next time.
COMMIT_LAG = timedelta(minutes=5)

_BEGINNING = "2000-01-01 00:00:00"


def _assert_profile_access(pos_profile):
    """Reject users outside the POS Profile. get_all skips permissions, so this is the only check."""
    if not pos_profile:
        frappe.throw(_("POS Profile is required"), frappe.PermissionError)

    user = frappe.session.user
    is_assigned = frappe.db.exists("POS Profile User", {"parent": pos_profile, "user": user})
    if not is_assigned and not frappe.has_permission("POS Profile", "write", user=user):
        frappe.throw(
            _("You do not have access to POS Profile {0}").format(pos_profile),
            frappe.PermissionError,
        )


def _fingerprint(*parts):
    return hashlib.sha256(json.dumps(parts, default=str).encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Cursor
# ---------------------------------------------------------------------------


def _decode_cursor(cursor):
    """Two positions: one in the table and one in its tombstones, which move independently."""
    if not cursor:
        return {"modified": _BEGINNING, "name": "", "deleted_at": _BEGINNING, "deleted": ""}

    try:
        position = json.loads(cursor) if isinstance(cursor, str) else cursor
        get_datetime(position["modified"])
        get_datetime(position["deleted_at"])
        return {key: str(position[key]) for key in ("modified", "name", "deleted_at", "deleted")}
    except (KeyError, TypeError, ValueError):
        frappe.throw(_("Invalid sync cursor"))


def _commit_floor():
    return now_datetime() - COMMIT_LAG


def _settled(stamp, name):
    floor = _commit_floor()
    return (str(floor), "") if get_datetime(stamp) > floor else (stamp, name)


def _next_rows(table, stamp, after, after_name, limit, columns="", condition="", **values):
    """Read rows past a position. name breaks ties, so rows sharing a stamp survive a page boundary."""
    rows = frappe.db.sql(
        f"""
        SELECT name, {stamp} AS stamp{columns}
        FROM `tab{table}`
        WHERE ({stamp} > %(after)s OR ({stamp} = %(after)s AND name > %(after_name)s)){condition}
        ORDER BY {stamp} ASC, name ASC
        LIMIT %(limit)s
        """,
        {"after": after, "after_name": after_name, "limit": limit + 1, **values},
        as_dict=True,
    )
    return rows[:limit], len(rows) > limit


def _walk(doctype, cursor, limit, columns="", condition="", tombstone_columns="", **values):
    """Read one page of changes and tombstones.

    Returns:
        tuple: changed rows, tombstones, next cursor, has_more
    """
    position = _decode_cursor(cursor)

    changed, more_changed = _next_rows(
        doctype, "modified", position["modified"], position["name"], limit, columns, condition, **values
    )
    tombstones, more_tombstones = _next_rows(
        "Deleted Document",
        "creation",
        position["deleted_at"],
        position["deleted"],
        limit,
        f", deleted_name{tombstone_columns}",
        " AND deleted_doctype = %(doctype)s",
        doctype=doctype,
    )

    if changed:
        position["modified"], position["name"] = str(changed[-1].stamp), changed[-1].name
    if tombstones:
        position["deleted_at"], position["deleted"] = str(tombstones[-1].stamp), tombstones[-1].name

    has_more = more_changed or more_tombstones
    if not has_more:
        position["modified"], position["name"] = _settled(position["modified"], position["name"])
        position["deleted_at"], position["deleted"] = _settled(position["deleted_at"], position["deleted"])

    return changed, tombstones, json.dumps(position), has_more


def _still_gone(doctype, tombstones):
    """A name can be taken again after deletion, and its tombstone must not remove the new record."""
    names = [row.deleted_name for row in tombstones]
    if not names:
        return []
    existing = set(frappe.get_all(doctype, filters={"name": ["in", names]}, pluck="name"))
    return [name for name in names if name not in existing]


def _page(rows, deleted, next_cursor, has_more=False):
    return {"rows": rows, "deleted": deleted, "next_cursor": next_cursor, "has_more": has_more}


# ---------------------------------------------------------------------------
# Walked entities
# ---------------------------------------------------------------------------


def _profile_item_groups(profile):
    groups = set()
    for row in profile.item_groups:
        groups.update(_get_item_group_with_descendants(row.item_group))
    return sorted(groups)


def _scoped_item_rows(profile, names):
    """Cache rows for those of `names` the profile may sell.

    Variants and templates both stay in, because the cache needs them for barcode scans and
    the display mode is applied on the device. Stock stays out of the filter: it moves
    without touching Item.modified, so an item left out here would never come back.
    """
    if not names:
        return []

    conditions, params, joins = _build_item_base_conditions(profile, exclude_variants=False)
    for column, values in (("i.item_group", _profile_item_groups(profile)), ("i.name", names)):
        if values:
            placeholders = ", ".join(["%s"] * len(values))
            conditions.append(f"{column} IN ({placeholders})")
            params.extend(values)

    rows = _select_item_rows(conditions, params, joins)
    if rows:
        _enrich_items_bulk(rows, profile, exclude_variants=False)

    if getattr(profile, "hide_unavailable_items", 0):
        for row in rows:
            row["hide_when_unavailable"] = 1

    return rows


def _pull_items(profile, cursor, limit):
    changed, tombstones, next_cursor, has_more = _walk("Item", cursor, limit)

    names = [row.name for row in changed]
    rows = _scoped_item_rows(profile, names)
    kept = {row["item_code"] for row in rows}
    deleted = [name for name in names if name not in kept]

    return _page(rows, deleted + _still_gone("Item", tombstones), next_cursor, has_more)


def _pull_item_prices(profile, cursor, limit):
    """Rows of items whose price changed, so the device has one way to store an item."""
    if not cursor:
        # Item rows carry their prices, so a device that has no position yet starts here
        floor = str(_commit_floor())
        return _page([], [], json.dumps({"modified": floor, "name": "", "deleted_at": floor, "deleted": ""}))

    price_list = profile.selling_price_list
    changed, tombstones, next_cursor, has_more = _walk(
        "Item Price",
        cursor,
        limit,
        columns=", item_code",
        condition=" AND price_list = %(price_list)s",
        tombstone_columns=", data",
        price_list=price_list,
    )

    codes = {row.item_code for row in changed}
    for row in tombstones:
        price = json.loads(row.data or "{}")
        if price.get("price_list") == price_list and price.get("item_code"):
            codes.add(price["item_code"])

    return _page(_scoped_item_rows(profile, sorted(codes)), [], next_cursor, has_more)


def _pull_customers(profile, cursor, limit):
    changed, tombstones, next_cursor, has_more = _walk("Customer", cursor, limit)

    names = [row.name for row in changed]
    rows = []
    if names:
        rows = frappe.get_all(
            "Customer",
            filters={**_get_profile_customer_filters(profile.name), "disabled": 0, "name": ["in", names]},
            fields=CUSTOMER_RESULT_FIELDS,
            limit=len(names),
        )
    kept = {row["name"] for row in rows}
    deleted = [name for name in names if name not in kept]

    return _page(rows, deleted + _still_gone("Customer", tombstones), next_cursor, has_more)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

_WALKED = {
    "items": _pull_items,
    "item_prices": _pull_item_prices,
    "customers": _pull_customers,
}

#: Small sets the device replaces whole. These builders raise on failure: the public
#: get_taxes and get_offers answer [] instead, which here would erase the device's copy.
_WHOLE_SETS = {
    "taxes": lambda profile: _get_tax_rows(profile.name),
    "payment_methods": lambda profile: get_payment_methods(profile.name),
    "pos_profile": lambda profile: [get_pos_profile_data(profile.name)],
    "offers": lambda profile: _get_offers(profile.name),
}


def _table_state(doctype, condition="", values=None):
    return frappe.db.sql(f"SELECT MAX(modified), COUNT(*) FROM `tab{doctype}` {condition}", values)[0]


def _latest_tombstones():
    return dict(
        frappe.db.sql(
            """
            SELECT deleted_doctype, MAX(creation)
            FROM `tabDeleted Document`
            WHERE deleted_doctype IN ('Item', 'Item Price', 'Customer')
            GROUP BY deleted_doctype
            """
        )
    )


def _item_scope(profile):
    """What decides which items a profile sees. Changing it moves no Item.modified."""
    return _fingerprint(
        profile.name,
        profile.company,
        profile.warehouse,
        profile.selling_price_list,
        getattr(profile, "hide_unavailable_items", 0),
        _profile_item_groups(profile),
        _get_allowed_profile_brands(profile.name),
    )


@frappe.whitelist()
def get_manifest(pos_profile):
    """Report a version per entity, so the device pulls only what moved.

    Args:
        pos_profile: The device's POS Profile

    Returns:
        dict: A version per entity, plus `scopes`: when an entity's scope differs from the
            one the device walked, its cursor no longer applies and it starts over
    """
    _assert_pos_user()
    _assert_profile_access(pos_profile)

    profile = frappe.get_cached_doc("POS Profile", pos_profile)
    tombstones = _latest_tombstones()
    item_scope = _item_scope(profile)

    return {
        "server_time": now(),
        "scopes": {
            "items": item_scope,
            "item_prices": item_scope,
            "customers": _fingerprint(_get_profile_customer_filters(profile.name)),
        },
        "items": _fingerprint(_table_state("Item"), tombstones.get("Item")),
        "item_prices": _fingerprint(
            _table_state("Item Price", "WHERE price_list = %s", (profile.selling_price_list,)),
            tombstones.get("Item Price"),
        ),
        "customers": _fingerprint(_table_state("Customer"), tombstones.get("Customer")),
        "taxes": _fingerprint(
            profile.name, profile.taxes_and_charges, _table_state("Sales Taxes and Charges Template")
        ),
        "payment_methods": _fingerprint(profile.name, profile.modified, _table_state("Mode of Payment")),
        "pos_profile": _fingerprint(
            profile.name,
            profile.modified,
            _table_state("POS Settings"),
            _table_state("Company"),
            _table_state("Item Group"),
        ),
        # The date is here because get_offers filters by it, so a new day can change the set
        "offers": _fingerprint(
            profile.name,
            profile.company,
            profile.ignore_pricing_rule,
            nowdate(),
            _table_state("Pricing Rule"),
            _table_state("Promotional Scheme"),
        ),
    }


@frappe.whitelist()
def pull(entity, pos_profile, cursor=None, limit=DEFAULT_PAGE_SIZE):
    """Return one page of what changed in an entity.

    Args:
        entity: One of the entities in get_manifest
        pos_profile: The device's POS Profile
        cursor: next_cursor of the previous page, empty to start from the beginning
        limit: Rows per page

    Returns:
        dict: rows, deleted (names to drop), next_cursor and has_more
    """
    _assert_pos_user()
    _assert_profile_access(pos_profile)

    if entity not in _WALKED and entity not in _WHOLE_SETS:
        frappe.throw(_("Unknown sync entity {0}").format(entity))

    profile = frappe.get_cached_doc("POS Profile", pos_profile)
    if entity in _WHOLE_SETS:
        return _page(_WHOLE_SETS[entity](profile), [], None)

    limit = max(1, min(cint(limit) or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE))
    return _WALKED[entity](profile, cursor, limit)


def record_rename(doc, method=None, old=None, new=None, merge=False):
    """Frappe leaves no trace of a rename, so devices would keep the old name forever.

    Marked as restored because the record still exists: the desk must not offer to restore it.
    A merge needs no tombstone, since rename_doc deletes the old record right after this hook.
    """
    if merge:
        return

    frappe.get_doc(
        doctype="Deleted Document",
        deleted_doctype=doc.doctype,
        deleted_name=old,
        new_name=new,
        restored=1,
    ).db_insert()
    frappe.db.set_value(doc.doctype, new, "modified", now(), update_modified=False)
