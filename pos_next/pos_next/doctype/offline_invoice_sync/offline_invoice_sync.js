// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

const SYNC_API = "pos_next.api.sync";

/** What a record of each entity can be linked to when it was entered by hand */
const LINK_DOCTYPES = {
	invoice: ["Sales Invoice", "POS Invoice"],
	customer: ["Customer"],
	payment: ["Payment Entry"],
};

const SYNC_FIXES = {
	posting_date: {
		label: __("Change Posting Date"),
		entities: ["invoice", "payment"],
		fields: [{ fieldname: "posting_date", fieldtype: "Date", label: __("Posting Date"), reqd: 1 }],
	},
	customer: {
		label: __("Change Customer"),
		entities: ["invoice"],
		fields: [
			{ fieldname: "customer", fieldtype: "Link", options: "Customer", label: __("Customer"), reqd: 1 },
		],
	},
	warehouse: {
		label: __("Change Warehouse"),
		entities: ["invoice"],
		fields: [
			{ fieldname: "warehouse", fieldtype: "Link", options: "Warehouse", label: __("Warehouse"), reqd: 1 },
			{
				fieldname: "item_code",
				fieldtype: "Link",
				options: "Item",
				label: __("Only This Item"),
				description: __("Leave empty for every item."),
			},
		],
	},
	replace_item: {
		label: __("Replace Item"),
		entities: ["invoice"],
		fields: [
			{ fieldname: "item_code", fieldtype: "Data", label: __("Item On The Invoice"), reqd: 1 },
			{ fieldname: "new_item_code", fieldtype: "Link", options: "Item", label: __("New Item"), reqd: 1 },
		],
	},
	batch: {
		label: __("Change Batch"),
		entities: ["invoice"],
		fields: [
			{ fieldname: "item_code", fieldtype: "Link", options: "Item", label: __("Item"), reqd: 1 },
			{ fieldname: "batch_no", fieldtype: "Link", options: "Batch", label: __("Batch"), reqd: 1 },
		],
	},
	payment_mode: {
		label: __("Change Payment Method"),
		entities: ["invoice", "payment"],
		fields: [
			{ fieldname: "mode_of_payment", fieldtype: "Data", label: __("Method On The Invoice"), reqd: 1 },
			{
				fieldname: "new_mode_of_payment",
				fieldtype: "Link",
				options: "Mode of Payment",
				label: __("New Method"),
				reqd: 1,
			},
		],
	},
	shift: {
		label: __("Change Shift"),
		entities: ["invoice", "payment"],
		fields: [
			{ fieldname: "shift", fieldtype: "Link", options: "POS Opening Shift", label: __("Open Shift"), reqd: 1 },
		],
	},
	payment_amount: {
		label: __("Change Payment Amount"),
		entities: ["payment"],
		fields: [
			{ fieldname: "mode_of_payment", fieldtype: "Data", label: __("Method On The Payment"), reqd: 1 },
			{ fieldname: "amount", fieldtype: "Currency", label: __("Amount"), reqd: 1 },
		],
	},
	customer_group: {
		label: __("Change Customer Group"),
		entities: ["customer"],
		fields: [
			{
				fieldname: "customer_group",
				fieldtype: "Link",
				options: "Customer Group",
				label: __("Customer Group"),
				reqd: 1,
			},
		],
	},
	territory: {
		label: __("Change Territory"),
		entities: ["customer"],
		fields: [
			{ fieldname: "territory", fieldtype: "Link", options: "Territory", label: __("Territory"), reqd: 1 },
		],
	},
};

function callSyncAction(frm, method, args, message) {
	return frappe.call({
		method: `${SYNC_API}.${method}`,
		args: { name: frm.doc.name, ...args },
		freeze: true,
		callback: () => {
			frappe.show_alert({ message, indicator: "green" });
			frm.reload_doc();
		},
	});
}

function promptFix(frm, fix, definition) {
	frappe.prompt(
		definition.fields,
		(values) => callSyncAction(frm, "apply_fix", { fix, values }, __("Saved. Reprocess the record to apply it.")),
		definition.label,
		__("Apply"),
	);
}

function addReviewActions(frm) {
	const entity = frm.doc.entity || "invoice";
	const linkDoctypes = LINK_DOCTYPES[entity];

	frm.add_custom_button(__("Reprocess"), () => {
		frappe.prompt(
			{ fieldname: "note", fieldtype: "Small Text", label: __("Note") },
			({ note }) => callSyncAction(frm, "reprocess", { note }, __("Processed")),
			__("Reprocess"),
			__("Reprocess"),
		);
	}).addClass("btn-primary");

	for (const [fix, definition] of Object.entries(SYNC_FIXES)) {
		if (definition.entities.includes(entity)) {
			frm.add_custom_button(definition.label, () => promptFix(frm, fix, definition), __("Correct"));
		}
	}

	if (entity === "invoice") {
		frm.add_custom_button(
			__("Accept Total Difference"),
			() => {
				frappe.confirm(__("Post this invoice with the server's total?"), () =>
					callSyncAction(frm, "apply_fix", { fix: "accept_total_difference" }, __("Accepted")),
				);
			},
			__("Correct"),
		);
	}

	if (entity === "invoice" && frm.doc.coupon_code) {
		frm.add_custom_button(
			__("Keep the Sale Without the Coupon"),
			() => {
				frappe.confirm(__("The invoice keeps its discount, but this coupon's usage will not count it."), () =>
					callSyncAction(frm, "apply_fix", { fix: "remove_coupon" }, __("Saved. Reprocess the record to apply it.")),
				);
			},
			__("Correct"),
		);
	}

	frm.add_custom_button(
		__("Link Existing Document"),
		() => {
			frappe.prompt(
				[
					{
						fieldname: "doctype",
						fieldtype: "Select",
						options: linkDoctypes.join("\n"),
						label: __("Type"),
						default: linkDoctypes[0],
						reqd: 1,
					},
					{
						fieldname: "invoice_name",
						fieldtype: "Dynamic Link",
						options: "doctype",
						label: __("Document"),
						reqd: 1,
					},
					{ fieldname: "note", fieldtype: "Small Text", label: __("Note"), reqd: 1 },
				],
				(values) => callSyncAction(frm, "link_existing_invoice", values, __("Linked")),
				__("Link Existing Document"),
				__("Link"),
			);
		},
		__("Close"),
	);

	frm.add_custom_button(
		__("Void"),
		() => {
			frappe.prompt(
				{ fieldname: "note", fieldtype: "Small Text", label: __("Reason"), reqd: 1 },
				({ note }) => callSyncAction(frm, "void", { note }, __("Voided")),
				__("Void Record"),
				__("Void"),
			);
		},
		__("Close"),
	);
}

frappe.ui.form.on("Offline Invoice Sync", {
	refresh(frm) {
		const inReview = frm.doc.status === "Needs Review";

		frm.set_df_property("payload", "read_only", inReview ? 0 : 1);
		frm.disable_form_if_needed?.();

		if (frm.doc.error_code === "NegativeStockError" || frm.doc.error_class === "stock") {
			frm.add_custom_button(__("Stock Entry"), () => frappe.new_doc("Stock Entry"), __("Open"));
		}

		if (inReview && frappe.user.has_role(["Nexus POS Manager", "System Manager"])) {
			addReviewActions(frm);
		}

		if (frm.doc.error_message) {
			const color = inReview ? "red" : "orange";
			frm.dashboard.set_headline(
				`<span class="indicator ${color}">${frappe.utils.escape_html(frm.doc.error_message)}</span>`,
			);
		}
	},
});
