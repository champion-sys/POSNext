// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

const SYNC_API = "pos_next.api.sync";

const REVIEW_GUIDE = {
	stock: __("There was not enough stock. Receive the stock and press Reprocess, or use Fix Invoice to change the warehouse."),
	business: __("A rule on the server refused this invoice. Use Fix Invoice to correct it, then press Reprocess."),
	dependency: __("It needs a record that has not reached the server yet. Press Reprocess once it arrives."),
	contract: __("The invoice data is not valid. Correct the Payload field and press Reprocess, or contact support."),
	bug: __("The server hit an unexpected error. Contact support before voiding this invoice."),
	transient_server: __("The server was busy. Press Reprocess to try again."),
};

const TOTAL_MISMATCH_GUIDE = __(
	"The server's total differs from what the customer paid. Use Accept Total Difference under Fix Invoice, or correct the invoice, then press Reprocess.",
);

const SYNC_FIXES = {
	posting_date: {
		label: __("Change Posting Date"),
		fields: [
			{
				fieldname: "posting_date",
				fieldtype: "Date",
				label: __("Posting Date"),
				description: __("Use a date in an open accounting period."),
				reqd: 1,
			},
		],
	},
	customer: {
		label: __("Change Customer"),
		fields: [
			{
				fieldname: "customer",
				fieldtype: "Link",
				options: "Customer",
				label: __("Customer"),
				description: __("Use when the customer on the invoice does not exist on the server."),
				reqd: 1,
			},
		],
	},
	warehouse: {
		label: __("Change Warehouse"),
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
		fields: [
			{
				fieldname: "item_code",
				fieldtype: "Data",
				label: __("Item On The Invoice"),
				description: __("Use when the item was disabled or deleted."),
				reqd: 1,
			},
			{ fieldname: "new_item_code", fieldtype: "Link", options: "Item", label: __("New Item"), reqd: 1 },
		],
	},
	batch: {
		label: __("Change Batch"),
		fields: [
			{ fieldname: "item_code", fieldtype: "Link", options: "Item", label: __("Item"), reqd: 1 },
			{
				fieldname: "batch_no",
				fieldtype: "Link",
				options: "Batch",
				label: __("Batch"),
				description: __("Use when the batch expired or has no stock."),
				reqd: 1,
			},
		],
	},
	payment_mode: {
		label: __("Change Payment Method"),
		fields: [
			{
				fieldname: "mode_of_payment",
				fieldtype: "Data",
				label: __("Method On The Invoice"),
				description: __("Use when this method has no account on the server."),
				reqd: 1,
			},
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
		fields: [
			{
				fieldname: "shift",
				fieldtype: "Link",
				options: "POS Opening Shift",
				label: __("Open Shift"),
				description: __("Use when the shift of the sale is already closed."),
				reqd: 1,
			},
		],
	},
};

function callSyncAction(frm, method, args, alert) {
	return frappe.call({
		method: `${SYNC_API}.${method}`,
		args: { name: frm.doc.name, ...args },
		freeze: true,
		callback: ({ message }) => {
			frappe.show_alert(typeof alert === "function" ? alert(message) : { message: alert, indicator: "green" });
			frm.reload_doc();
		},
	});
}

function reprocessResult(row) {
	return row?.status === "Synced"
		? { message: __("Invoice created"), indicator: "green" }
		: { message: __("Not posted yet. Check the status and the error."), indicator: "orange" };
}

function promptFix(frm, fix, definition) {
	frappe.prompt(
		definition.fields,
		(values) => callSyncAction(frm, "apply_fix", { fix, values }, __("Saved. Reprocess the invoice to apply it.")),
		definition.label,
		__("Apply"),
	);
}

function confirmTotalDifference(frm) {
	const { client_grand_total: device, server_grand_total: server } = frm.doc;
	const question = server
		? __("The device total is {0} and the server total is {1}. Post this invoice with the server's total?", [
				format_number(device),
				format_number(server),
			])
		: __("Post this invoice with the server's total?");

	frappe.confirm(question, () =>
		callSyncAction(
			frm,
			"apply_fix",
			{ fix: "accept_total_difference" },
			__("Saved. Reprocess the invoice to apply it."),
		),
	);
}

function addReviewActions(frm) {
	const fix_group = __("Fix Invoice");
	const close_group = __("Close Without Posting");

	frm.add_custom_button(__("Reprocess"), () => {
		frappe.prompt(
			{
				fieldname: "note",
				fieldtype: "Small Text",
				label: __("Note"),
				description: __("Tries to post the invoice again, with any fixes you saved."),
			},
			({ note }) => callSyncAction(frm, "reprocess", { note }, reprocessResult),
			__("Reprocess"),
			__("Reprocess"),
		);
	}).addClass("btn-primary");

	for (const [fix, definition] of Object.entries(SYNC_FIXES)) {
		frm.add_custom_button(definition.label, () => promptFix(frm, fix, definition), fix_group);
	}

	frm.add_custom_button(__("Accept Total Difference"), () => confirmTotalDifference(frm), fix_group);

	frm.add_custom_button(
		__("Link Existing Invoice"),
		() => {
			frappe.prompt(
				[
					{
						fieldname: "doctype",
						fieldtype: "Select",
						options: "Sales Invoice\nPOS Invoice",
						label: __("Type"),
						default: "Sales Invoice",
						reqd: 1,
					},
					{
						fieldname: "invoice_name",
						fieldtype: "Dynamic Link",
						options: "doctype",
						label: __("Invoice"),
						description: __("Use when the sale was already entered by hand."),
						reqd: 1,
					},
					{ fieldname: "note", fieldtype: "Small Text", label: __("Note"), reqd: 1 },
				],
				(values) => callSyncAction(frm, "link_existing_invoice", values, __("Linked")),
				__("Link Existing Invoice"),
				__("Link"),
			);
		},
		close_group,
	);

	frm.add_custom_button(
		__("Void"),
		() => {
			frappe.prompt(
				{
					fieldname: "note",
					fieldtype: "Small Text",
					label: __("Reason"),
					description: __("The sale will not be posted. The reason is kept for audit."),
					reqd: 1,
				},
				({ note }) => callSyncAction(frm, "void", { note }, __("Voided")),
				__("Void Invoice"),
				__("Void"),
			);
		},
		close_group,
	);
}

function getReviewGuide(frm, canReview) {
	if (!canReview) return __("A POS manager needs to review this invoice.");
	if (frm.doc.error_code === "TotalMismatchError") return TOTAL_MISMATCH_GUIDE;
	return REVIEW_GUIDE[frm.doc.error_class] || "";
}

function showError(frm, inReview, canReview) {
	const color = inReview ? "red" : "orange";
	const guide = inReview ? getReviewGuide(frm, canReview) : "";

	frm.dashboard.set_headline(
		`<div dir="auto">${frappe.utils.escape_html(frm.doc.error_message)}</div>
		${guide ? `<div class="mt-1"><b>${__("What to do")}:</b> ${guide}</div>` : ""}`,
		color,
	);
}

frappe.ui.form.on("Offline Invoice Sync", {
	refresh(frm) {
		const inReview = frm.doc.status === "Needs Review";
		const canReview = frappe.user.has_role(["Nexus POS Manager", "System Manager"]);

		frm.set_df_property("payload", "read_only", inReview ? 0 : 1);
		frm.disable_form_if_needed?.();

		if (frm.doc.error_code === "NegativeStockError" || frm.doc.error_class === "stock") {
			frm.add_custom_button(__("New Stock Entry"), () => frappe.new_doc("Stock Entry"));
		}

		if (inReview && canReview) {
			addReviewActions(frm);
		}

		if (frm.doc.error_message) {
			showError(frm, inReview, canReview);
		}
	},
});
