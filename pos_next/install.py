"""
Installation and Migration hooks for POS Next

This module relies on Frappe's fixture system for:
- Custom fields (custom_field.json)
- Roles (role.json)
- Custom DocPerm (custom_docperm.json)
- Print formats (print_format.json)

The fixtures are defined in hooks.py and synced automatically during install/migrate.
This module handles post-fixture tasks like setting defaults and clearing cache.
"""
import frappe
import logging

from pos_next.patches.v2_0_0 import add_stock_pull_index, add_sync_pull_indexes

# Configure logger
logger = logging.getLogger(__name__)

#: What ERPNext reads while it fills in an invoice and what the POS screens list, beyond what
#: the role's fixtures give it. Without these a cashier with only this role cannot sell at all.
CASHIER_ROLE = "POSNext Cashier"
CASHIER_PERMISSIONS = {"Account": "select", "Address": "read", "Customer Group": "read", "Sales Person": "read"}


def ensure_cashier_permissions():
	"""Give the cashier role what selling needs, on any site.

	Not in the fixtures: the first Custom DocPerm of a doctype replaces all its standard
	permissions. add_permission copies those first, so every other role keeps its access.
	A new rule also starts with read on, which would open the chart of accounts to a cashier
	who only needs to pick from it.
	"""
	from frappe.permissions import add_permission, update_permission_property

	for doctype, permission in CASHIER_PERMISSIONS.items():
		if not frappe.db.exists(
			"Custom DocPerm", {"parent": doctype, "role": CASHIER_ROLE, "permlevel": 0, "if_owner": 0}
		):
			add_permission(doctype, CASHIER_ROLE, ptype=permission)
			if permission != "read":
				update_permission_property(doctype, CASHIER_ROLE, 0, "read", 0)
			frappe.clear_cache(doctype=doctype)


def after_install():
	"""Hook that runs after app installation"""
	try:
		log_message("POS Next: Running post-install setup", level="info")

		# Setup default print format for POS Profiles
		# setup_default_print_format()

		# Installing an app marks its patches as done without running them
		add_sync_pull_indexes.execute()
		add_stock_pull_index.execute()

		# Clear cache to ensure changes take effect
		frappe.clear_cache()
		frappe.db.commit()

		log_message("POS Next: Installation completed successfully", level="success")
	except Exception as e:
		frappe.db.rollback()
		frappe.log_error(
			title="POS Next Installation Error",
			message=frappe.get_traceback()
		)
		log_message(f"POS Next: Installation error - {str(e)}", level="error")
		raise


def after_migrate():
	"""Hook that runs after bench migrate"""
	try:
		# Setup default print format
		# setup_default_print_format(quiet=True)

		ensure_cashier_permissions()

		# A site installed before these ran at install has them marked done without having them
		add_sync_pull_indexes.execute()
		add_stock_pull_index.execute()

		# Clear cache
		frappe.clear_cache()
		frappe.db.commit()

		log_message("POS Next: Migration completed successfully", level="success")
	except Exception as e:
		frappe.db.rollback()
		frappe.log_error(
			title="POS Next Migration Error",
			message=frappe.get_traceback()
		)
		log_message(f"POS Next: Migration error - {str(e)}", level="error")
		raise


def setup_default_print_format(quiet=False):
	"""
	Set POS Next Receipt as default print format for POS Profiles if not already set.

	Args:
		quiet (bool): If True, suppress detailed logs
	"""
	try:
		# Check if the print format exists
		if not frappe.db.exists("Print Format", "POS Next Receipt"):
			if not quiet:
				log_message("POS Next Receipt SND print format not found, skipping default setup", level="warning")
			return

		# Get all POS Profiles without a print format
		pos_profiles = frappe.get_all(
			"POS Profile",
			filters={"print_format": ["in", ["", None]]},
			fields=["name"]
		)

		if pos_profiles:
			updated_count = 0
			for profile in pos_profiles:
				try:
					frappe.db.set_value(
						"POS Profile",
						profile.name,
						"print_format",
						"POS Next Receipt SND",
						update_modified=False
					)
					if not quiet:
						log_message(f"Set default print format for: {profile.name}", level="info", indent=1)
					updated_count += 1
				except Exception as e:
					log_message(f"Error updating POS Profile {profile.name}: {str(e)}", level="error", indent=1)

			if updated_count > 0 and not quiet:
				log_message(f"Updated {updated_count} POS Profile(s) with default print format", level="success")

	except Exception as e:
		log_message(f"Error setting up default print format: {str(e)}", level="error")
		frappe.log_error(
			title="Default Print Format Setup Error",
			message=frappe.get_traceback()
		)


def log_message(message, level="info", indent=0):
	"""
	Standardized logging function with consistent formatting.

	Args:
		message (str): The message to log
		level (str): Log level - info, success, warning, error
		indent (int): Indentation level (0, 1, 2, etc.)
	"""
	indent_str = "  " * indent

	prefixes = {
		"info": "[INFO]",
		"success": "[SUCCESS]",
		"warning": "[WARNING]",
		"error": "[ERROR]",
	}

	prefix = prefixes.get(level, "[INFO]")
	formatted_message = f"{indent_str}{prefix} {message}"

	# Print to console
	print(formatted_message)

	# Also log to frappe logger
	if level == "error":
		logger.error(message)
	elif level == "warning":
		logger.warning(message)
	else:
		logger.info(message)
