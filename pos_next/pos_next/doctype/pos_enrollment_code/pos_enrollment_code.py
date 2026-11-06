# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class POSEnrollmentCode(Document):
    """A one-time code that enrolls a device. Only its hash is kept."""
