// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

const SYNC_API = "pos_next.api.sync";

/** What a record of each entity can be linked to when it was entered by hand */
const LINK_DOCTYPES = {
	invoice: ["Sales Invoice", "POS Invoice"],
	customer: ["Customer"],
	payment: ["Payment Entry"],
	shift_close: ["POS Closing Shift"],
};

const SHIFT_CONFLICT_GUIDE = __(
	"Another shift is open and stands in the way of this one. Close that shift and press Reprocess, or use Link to Open Shift under Fix Record so the sales of this record go to it.",
);

const SHIFT_OUTDATED_GUIDE = __(
	"This shift opened on an earlier day, and ERPNext only takes POS Invoices under an opening from today. Open a shift for today, then use Link to Open Shift under Fix Record.",
);

const OFFLINE_SHIFT_GUIDE = __(
	"POS Settings no longer allows opening a shift offline. Turn the setting on and press Reprocess, or use Link to Open Shift under Fix Record.",
);

const LINKED_CLOSE_GUIDE = __(
	"This close counted the shift of the device only, and that shift was linked to another open shift. Close the open shift from the POS and add this count to it, then void this record.",
);

const REVIEW_GUIDE = {
	stock: __("There was not enough stock. Receive the stock and press Reprocess, or use Fix Record to change the warehouse."),
	business: __("A rule on the server refused this record. Use Fix Record to correct it, then press Reprocess."),
	dependency: __("It needs another record that did not arrive or was voided. Once that is settled, press Reprocess."),
	contract: __("The data of this record is not valid. Correct the Payload field and press Reprocess, or contact support."),
	bug: __("The server hit an unexpected error. Contact support before voiding this record."),
	transient_server: __("The server was busy. Press Reprocess to try again."),
};

const TOTAL_MISMATCH_GUIDE = __(
	"The server's total differs from what the customer paid. Use Accept Total Difference under Fix Record, or correct the invoice, then press Reprocess.",
);

const SHIFT_CLOSED_GUIDE = __(
	"Its shift is already closed, so this POS Invoice would never reach the books. Use Change Shift under Fix Record to move it to an open shift, then press Reprocess.",
);

const EDIT_CONFLICT_GUIDE = __(
	"The device edited a sale the server had already received, so both would post. To keep the original, void this record. To keep this edit, cancel the original invoice or void its record first, then press Reprocess.",
);

const CASHIER_GUIDE = __(
	"The cashier of this record is disabled or no longer exists. Enable the user and press Reprocess, or close the record without processing it.",
);

const SHIFT_CLOSE_GUIDE = __(
	"Some invoices of this shift have not finished. Finish them and press Reprocess, or use Close Without Unfinished Invoices under Fix Record.",
);

const SAVED_MESSAGE = __("Saved. Reprocess the record to apply it.");

const SYNC_FIXES = {
	posting_date: {
		label: __("Change Posting Date"),
		entities: ["invoice", "payment"],
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
		entities: ["invoice"],
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
		entities: ["invoice"],
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
		entities: ["invoice", "payment"],
		fields: [
			{
				fieldname: "mode_of_payment",
				fieldtype: "Data",
				label: __("Method To Replace"),
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
		entities: ["invoice", "payment"],
		fields: [
			{
				fieldname: "shift",
				fieldtype: "Link",
				options: "POS Opening Shift",
				label: __("Open Shift"),
				description: __("Use when the original shift is already closed."),
				reqd: 1,
			},
		],
	},
	link_shift: {
		label: __("Link to Open Shift"),
		entities: ["shift_open"],
		fields: [
			{
				fieldname: "shift",
				fieldtype: "Link",
				options: "POS Opening Shift",
				label: __("Open Shift"),
				description: __("Use a shift open on this POS Profile. The sales of this record go to it."),
				get_query: () => ({ filters: { status: "Open" } }),
				reqd: 1,
			},
		],
	},
	payment_amount: {
		label: __("Change Payment Amount"),
		entities: ["payment"],
		fields: [
			{ fieldname: "mode_of_payment", fieldtype: "Data", label: __("Method On The Payment"), reqd: 1 },
			{
				fieldname: "amount",
				fieldtype: "Currency",
				label: __("Amount"),
				description: __("Use when the amount does not match what is still owed."),
				reqd: 1,
			},
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
				description: __("Use when the group sent by the device does not exist on the server."),
				reqd: 1,
			},
		],
	},
	territory: {
		label: __("Change Territory"),
		entities: ["customer"],
		fields: [
			{
				fieldname: "territory",
				fieldtype: "Link",
				options: "Territory",
				label: __("Territory"),
				description: __("Use when the territory sent by the device does not exist on the server."),
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
		? { message: __("Processed"), indicator: "green" }
		: { message: __("Not processed yet. Check the status and the error."), indicator: "orange" };
}

function promptFix(frm, fix, definition) {
	frappe.prompt(
		definition.fields,
		(values) => callSyncAction(frm, "apply_fix", { fix, values }, SAVED_MESSAGE),
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
		callSyncAction(frm, "apply_fix", { fix: "accept_total_difference" }, SAVED_MESSAGE),
	);
}

function addReviewActions(frm) {
	const entity = frm.doc.entity || "invoice";
	const linkDoctypes = LINK_DOCTYPES[entity];
	const fix_group = __("Fix Record");
	const close_group = __("Close Without Processing");

	frm.add_custom_button(__("Reprocess"), () => {
		frappe.prompt(
			{
				fieldname: "note",
				fieldtype: "Small Text",
				label: __("Note"),
				description: __("Tries to process the record again, with any fixes you saved."),
			},
			({ note }) => callSyncAction(frm, "reprocess", { note }, reprocessResult),
			__("Reprocess"),
			__("Reprocess"),
		);
	}).addClass("btn-primary");

	for (const [fix, definition] of Object.entries(SYNC_FIXES)) {
		if (definition.entities.includes(entity)) {
			frm.add_custom_button(definition.label, () => promptFix(frm, fix, definition), fix_group);
		}
	}

	if (entity === "invoice") {
		frm.add_custom_button(__("Accept Total Difference"), () => confirmTotalDifference(frm), fix_group);
	}

	if (entity === "shift_close") {
		frm.add_custom_button(
			__("Close Without Unfinished Invoices"),
			() => {
				frappe.confirm(
					__("The closing will leave out every invoice of this shift that has not finished. Continue?"),
					() => callSyncAction(frm, "apply_fix", { fix: "accept_unfinished" }, SAVED_MESSAGE),
				);
			},
			fix_group,
		);
	}

	if (entity === "invoice" && frm.doc.coupon_code) {
		frm.add_custom_button(
			__("Keep the Sale Without the Coupon"),
			() => {
				frappe.confirm(__("The invoice keeps its discount, but this coupon's usage will not count it."), () =>
					callSyncAction(frm, "apply_fix", { fix: "remove_coupon" }, SAVED_MESSAGE),
				);
			},
			fix_group,
		);
	}

	if (linkDoctypes) {
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
							description: __("Use when it was already entered by hand."),
							reqd: 1,
						},
						{ fieldname: "note", fieldtype: "Small Text", label: __("Note"), reqd: 1 },
					],
					(values) => callSyncAction(frm, "link_existing_invoice", values, __("Linked")),
					__("Link Existing Document"),
					__("Link"),
				);
			},
			close_group,
		);
	}

	frm.add_custom_button(
		__("Void"),
		() => {
			frappe.prompt(
				{
					fieldname: "note",
					fieldtype: "Small Text",
					label: __("Reason"),
					description: __("It will not be processed. The reason is kept for audit."),
					reqd: 1,
				},
				({ note }) => callSyncAction(frm, "void", { note }, __("Voided")),
				__("Void Record"),
				__("Void"),
			);
		},
		close_group,
	);
}

function getReviewGuide(frm, canReview) {
	const { entity, error_code, error_class } = frm.doc;
	if (!canReview) return __("A POS manager needs to review this record.");
	if (error_code === "TotalMismatchError") return TOTAL_MISMATCH_GUIDE;
	if (error_code === "ShiftClosedError") return SHIFT_CLOSED_GUIDE;
	if (error_code === "EditConflictError") return EDIT_CONFLICT_GUIDE;
	if (error_code === "CashierUnavailableError") return CASHIER_GUIDE;
	if (error_code === "ShiftConflictError") return SHIFT_CONFLICT_GUIDE;
	if (error_code === "ShiftOutdatedError") return SHIFT_OUTDATED_GUIDE;
	if (error_code === "OfflineShiftNotAllowedError") return OFFLINE_SHIFT_GUIDE;
	if (error_code === "LinkedShiftCloseError") return LINKED_CLOSE_GUIDE;
	if (entity === "shift_close" && error_class === "dependency") return SHIFT_CLOSE_GUIDE;
	return REVIEW_GUIDE[error_class] || "";
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
