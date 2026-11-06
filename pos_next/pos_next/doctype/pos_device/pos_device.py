# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import secrets

import frappe
from frappe.model.document import Document

from pos_next.auth import clear_device_access

#: Without letters and digits that look alike, since these get read and typed by people
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 5


class POSDevice(Document):
    """A till enrolled to work with this site. See pos_next.auth and pos_next.api.device."""

    def before_insert(self):
        self.device_code = self.device_code or self._new_code()

    def on_update(self):
        if self.status == "Revoked":
            clear_device_access(self.name)

    @staticmethod
    def _new_code():
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _position in range(CODE_LENGTH))
            if not frappe.db.exists("POS Device", {"device_code": code}):
                return code
