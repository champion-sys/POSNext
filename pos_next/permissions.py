# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Who may reach a shift, or a POS Profile's settings, outside the POS API.

The POS API checks each request itself. These hooks hold the standard API to the same
line: a cashier reaches only the shifts and POS Settings of the POS Profiles they are
assigned to, and a manager reaches all of them. They are registered for each doctype
in hooks.py, and every one of them has a pos_profile field.
"""

import frappe

#: Roles that look after every shift: they may close a colleague's and cancel a closing
MANAGER_ROLES = ("Nexus POS Manager", "System Manager")

SHIFT_DOCTYPES = ("POS Opening Shift", "POS Closing Shift")

#: Held to the POS Profiles a user is assigned to: the shifts, and each profile's settings
PROFILE_DOCTYPES = (*SHIFT_DOCTYPES, "POS Settings")


def is_pos_manager(user=None):
    user = user or frappe.session.user
    return user == "Administrator" or bool(set(MANAGER_ROLES) & set(frappe.get_roles(user)))


def _get_assigned_profiles(user):
    return frappe.get_all("POS Profile User", filters={"user": user}, pluck="parent")


def has_shift_permission(doc, ptype=None, user=None, debug=False):
    """has_permission hook. It can only take away what the role gives.

    Returns:
        bool: False for a shift of a POS Profile the user is not assigned to
    """
    user = user or frappe.session.user
    if is_pos_manager(user):
        return True
    return bool(doc.get("pos_profile")) and doc.get("pos_profile") in _get_assigned_profiles(user)


def get_shift_query_conditions(user=None, doctype=None):
    """permission_query_conditions hook, the same rule for lists and reports."""
    user = user or frappe.session.user
    if is_pos_manager(user):
        return ""

    table = f"`tab{doctype or SHIFT_DOCTYPES[0]}`"
    return (
        f"{table}.`pos_profile` in (select `parent` from `tabPOS Profile User` "
        f"where `user` = {frappe.db.escape(user)})"
    )
