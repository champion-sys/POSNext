frappe.ui.form.on("POS Profile", {
	onload: function (frm) {
		set_print_format_query(frm);
	},
	refresh: function (frm) {
		set_print_format_query(frm);
	}
});

function set_print_format_query(frm) {
	// Set standard fallback filter first (defaults to POS Invoice)
	frm.set_query("print_format", function () {
		return {
			filters: [["Print Format", "doc_type", "=", "POS Invoice"]]
		};
	});

	if (frm.is_new()) {
		return;
	}

	// Fetch invoice type asynchronously from the linked POS Settings
	frappe.db.get_value("POS Settings", { pos_profile: frm.doc.name }, "invoice_type")
		.then(r => {
			const invoice_type = r.message ? r.message.invoice_type : null;
			if (invoice_type) {
				frm.set_query("print_format", function () {
					return {
						filters: [["Print Format", "doc_type", "=", invoice_type]]
					};
				});
			}
		});
}
