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


class TotalMismatchError(frappe.ValidationError):
    """The server's total differs from what the customer was charged."""


class CashierUnavailableError(frappe.ValidationError):
    """The cashier a record belongs to cannot be used, so a person has to look at it."""


class ShiftClosedError(frappe.ValidationError):
    """A POS Invoice reaches the books through its shift's closing, which has already run."""


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


def _message(exc):
    message = str(exc) or type(exc).__name__
    return re.sub(r"<[^>]+>", " ", message).strip()[:1000]


def _is_stock_message(message):
    """The POS stock check raises a plain ValidationError with a JSON error list."""
    try:
        return "errors" in json.loads(message)
    except (TypeError, ValueError):
        return False


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
    message = _message(exc)

    if names & _TRANSIENT_TYPES:
        error_class = TRANSIENT_SERVER
    elif names & _STOCK_TYPES or _is_stock_message(message):
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
