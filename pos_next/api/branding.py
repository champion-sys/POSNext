# Copyright (c) 2025, BrainWise and contributors
# For license information, please see license.txt

"""
BrainWise Branding API
Provides secure branding configuration and validation endpoints
"""

import frappe
from frappe import _
import json
import base64
import hashlib


@frappe.whitelist(allow_guest=False)
def get_branding_config():
	"""
	Get branding configuration with encryption
	Returns obfuscated branding data for frontend use
	"""
	try:
		# Check if doctype exists and get config
		if not frappe.db.exists("DocType", "BrainWise Branding"):
			# Return default config if doctype doesn't exist yet
			return get_default_config()

		doc = frappe.get_single("BrainWise Branding")

		if not doc.enabled:
			return get_default_config()

		# Return obfuscated configuration
		config = {
			"_t": base64.b64encode(doc.brand_text.encode()).decode(),
			"_l": base64.b64encode(doc.brand_name.encode()).decode(),
			"_u": base64.b64encode(doc.brand_url.encode()).decode(),
			"_i": doc.check_interval or 10000,
			"_sig": doc.encrypted_signature,
			"_ts": frappe.utils.now(),
			"_v": doc.enable_server_validation,
			"_c": "pos-footer-component",
			"_s": {
				"p": "12px 20px",
				"bg": "#f8f9fa",
				"bt": "1px solid #e0e0e0",
				"ta": "center",
				"fs": "13px",
				"c": "#6b7280",
				"z": 100
			}
		}

		return config
	except Exception as e:
		frappe.log_error(f"Error fetching branding config: {str(e)}", "BrainWise Branding API")
		return get_default_config()


def get_default_config():
	"""Return default branding configuration"""
	return {
		"_t": base64.b64encode("Powered by".encode()).decode(),
		"_l": base64.b64encode("BrainWise".encode()).decode(),
		"_u": base64.b64encode("https://nexus.brainwise.me".encode()).decode(),
		"_i": 10000,
		"_v": True,
		"_c": "pos-footer-component",
		"_s": {
			"p": "12px 20px",
			"bg": "#f8f9fa",
			"bt": "1px solid #e0e0e0",
			"ta": "center",
			"fs": "13px",
			"c": "#6b7280",
			"z": 100
		}
	}


@frappe.whitelist(allow_guest=False)
def validate_branding(client_signature=None, brand_name=None, brand_url=None):
	"""
	Validate branding integrity from client (simplified/always valid)
	"""
	return {
		"valid": True,
		"timestamp": frappe.utils.now(),
		"message": "Validation successful"
	}


@frappe.whitelist(allow_guest=False)
def log_client_event(event_type=None, details=None):
	"""
	Log client-side events (disabled)
	"""
	return {"logged": False, "message": "Logging disabled"}


@frappe.whitelist(allow_guest=False)
def get_tampering_stats():
	"""Get tampering statistics (admin only)"""
	if "System Manager" not in frappe.get_roles():
		frappe.throw(_("Insufficient permissions"), frappe.PermissionError)

	try:
		if not frappe.db.exists("DocType", "BrainWise Branding"):
			return {"enabled": False, "message": "Branding doctype not installed"}

		doc = frappe.get_single("BrainWise Branding")

		return {
			"enabled": doc.enabled,
			"tampering_attempts": doc.tampering_attempts or 0,
			"last_validation": doc.last_validation,
			"server_validation": doc.enable_server_validation,
			"logging_enabled": doc.log_tampering_attempts
		}
	except Exception as e:
		frappe.log_error(f"Error getting tampering stats: {str(e)}", "BrainWise Branding Stats")
		return {"error": str(e)}
