import json

import frappe

DOCTYPE = "Offline Invoice Sync"

#: How the payload stores an edit. A sale that is not one holds a null there.
HOLDS_AN_EDIT = '%"edited_from": "%'


def execute():
    """Records stored before edited_from was a column name their original in the payload alone.

    One erased by retention has nothing left to read, so it stays empty.
    """
    rows = frappe.get_all(
        DOCTYPE,
        filters={"payload": ["like", HOLDS_AN_EDIT], "edited_from": ["is", "not set"]},
        fields=["name", "offline_id", "payload"],
    )
    for row in rows:
        original = _read_original(row.payload)
        if original and original != row.offline_id:
            frappe.db.set_value(DOCTYPE, row.name, "edited_from", original, update_modified=False)


def _read_original(payload):
    # A manager can paste a payload into a record, and one bad record must not stop a migrate
    try:
        original = json.loads(payload).get("edited_from")
    except (ValueError, AttributeError):
        return None
    return original if isinstance(original, str) else None
