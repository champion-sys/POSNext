# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Decide what should happen to an invoice that failed on the server.

Classes and codes are stable, untranslated identifiers. Clients and reports rely
on them, so they must never depend on the wording of an error message.
"""

import hashlib
import json
import re
from dataclasses import dataclass

import frappe
from frappe import _

TRANSIENT_SERVER = "transient_server"
DEPENDENCY = "dependency"
STOCK = "stock"
BUSINESS = "business"
CONTRACT = "contract"
BUG = "bug"

#: How many automatic attempts each class gets, and the minutes to wait after each one
RETRY_POLICY = {
    TRANSIENT_SERVER: (1, 5, 15, 60, 240),
    STOCK: (15, 15, 15, 15),
}

_TRANSIENT_TYPES = {
    "QueryDeadlockError",
    "QueryTimeoutError",
    "TimestampMismatchError",
    "DocumentLockedError",
    "TooManyRequestsError",
    "OperationalError",
    "InterfaceError",
}
_STOCK_TYPES = {
    "NegativeStockError",
    "SerialNoWarehouseError",
    "SerialNoNotExistsError",
    "BatchExpiredError",
    "InsufficientStockError",
}


class SyncContractError(frappe.ValidationError):
    """The stored payload does not have the shape the server expects."""


class ClockSkewError(frappe.ValidationError):
    """The device's clock was so far off that the date of its sale cannot be trusted."""


class SaleOutsideShiftError(ClockSkewError):
    """A sale dated outside its shift's hours, as a clock that was wrong when it was made does."""


class TotalMismatchError(frappe.ValidationError):
    """The server's total differs from what the customer was charged."""


class CashierUnavailableError(frappe.ValidationError):
    """The cashier a record belongs to cannot be used, so a person has to look at it."""


class CashierNotOnProfileError(CashierUnavailableError):
    """A record names a colleague who is not on its POS Profile, as one who has left it since."""


class EditConflictError(frappe.ValidationError):
    """An edit of a sale the server already holds. Both would post, so a person has to choose."""


class ReplacedByEditError(frappe.ValidationError):
    """A copy of a sale the cashier already replaced. It is refused, so nothing stores it."""


class ShiftClosedError(frappe.ValidationError):
    """A sale for a shift that is closed, being closed, or gone. Its drawer was counted without it."""


class WrongShiftError(frappe.ValidationError):
    """A sale for a shift of another POS Profile, or, online, of another cashier."""


class ShiftConflictError(frappe.ValidationError):
    """Another open shift stands in the way of this one, so a person has to choose."""


class ShiftOutdatedError(frappe.ValidationError):
    """ERPNext refuses POS Invoices under an opening entry from an earlier day."""


class OfflineShiftNotAllowedError(frappe.ValidationError):
    """POS Settings no longer lets a shift be opened offline."""


class LinkedShiftCloseError(frappe.ValidationError):
    """A close counted a shift a manager linked to another, and must not close that one."""


class NotShiftHolderError(frappe.ValidationError):
    """A close from someone who does not hold the shift. Their drawer is not that shift's."""


class DependencyError(frappe.ValidationError):
    """A record this one needs was voided, so a person has to decide what happens to it."""


class WaitingForDependencyError(DependencyError):
    """What a record waits for will not come by itself, so a person has to look at it."""


@dataclass(frozen=True)
class Classification:
    error_class: str
    error_code: str
    message: str
    fingerprint: str


def _type_names(exc):
    return {klass.__name__ for klass in type(exc).__mro__}


def _text(exc):
    message = str(exc) or type(exc).__name__
    return re.sub(r"<[^>]+>", " ", message).strip()


def _stock_shortages(text):
    """The POS stock check raises a plain ValidationError with a JSON error list."""
    try:
        return json.loads(text).get("errors") or []
    except (AttributeError, TypeError, ValueError):
        return []


def _describe_shortage(shortage):
    return _("{0}: {1} requested, {2} available in {3}").format(
        shortage.get("item_code"),
        shortage.get("requested_qty"),
        shortage.get("available_qty"),
        shortage.get("warehouse"),
    )


def _fingerprint(error_code, message):
    # Names and amounts differ between invoices, the shape of the message does not
    shape = re.sub(r"\d+", "#", message.lower())[:200]
    return hashlib.sha256(f"{error_code}:{shape}".encode()).hexdigest()[:16]


def classify(exc):
    """Sort an exception into a class that decides the next step.

    Args:
        exc: The exception raised while processing

    Returns:
        Classification
    """
    names = _type_names(exc)
    code = type(exc).__name__
    text = _text(exc)
    shortages = _stock_shortages(text)
    # A manager reads this, and the JSON has to be parsed before it can be cut short
    message = ("\n".join(_describe_shortage(row) for row in shortages) or text)[:1000]

    if names & _TRANSIENT_TYPES:
        error_class = TRANSIENT_SERVER
    elif names & _STOCK_TYPES or shortages:
        error_class = STOCK
    elif isinstance(exc, SyncContractError):
        error_class = CONTRACT
    elif isinstance(exc, DependencyError):
        error_class = DEPENDENCY
    elif isinstance(exc, frappe.ValidationError | frappe.PermissionError | frappe.DoesNotExistError):
        error_class = BUSINESS
    else:
        error_class = BUG

    return Classification(error_class, code, message, _fingerprint(code, message))


def next_retry_minutes(error_class, attempts):
    """Minutes until the next automatic attempt.

    Args:
        error_class: Class of the failure
        attempts: Failed attempts so far, this one included

    Returns:
        int | None: None when the invoice needs a person
    """
    delays = RETRY_POLICY.get(error_class, ())
    return delays[attempts - 1] if 0 < attempts <= len(delays) else None
