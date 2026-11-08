// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

// A Print Format ticked "Print on POS Devices" is rendered by the POS device itself, offline.
// "POS Device Preview" renders it with the device's own code, so the preview is what prints.
const POS_RENDERER_URL = "/assets/pos_next/js/pos_print_template.js";
const POS_INVOICE_DOCTYPES = ["Sales Invoice", "POS Invoice"];
const POS_PAPER = {
	"Receipt 80 mm": { device: "80mm", width: "80mm" },
	"Receipt 58 mm": { device: "58mm", width: "58mm" },
	A4: { device: "A4", width: "210mm" },
	A5: { device: "A5", width: "148mm" },
};

frappe.ui.form.on("Print Format", {
	refresh(frm) {
		if (!frm.doc.pos_next_offline || frm.is_new()) return;
		frm.add_custom_button(__("POS Device Preview"), () => pos_format_preview(frm));
		frm.add_custom_button(__("POS Template Help"), () => pos_format_help());
	},

	pos_next_offline(frm) {
		if (!frm.doc.pos_next_offline) return;
		// What a POS template needs, set once so the manager need not hunt for it
		if (!frm.doc.custom_format) frm.set_value("custom_format", 1);
		if (frm.doc.print_format_type !== "Jinja") frm.set_value("print_format_type", "Jinja");
		if (!POS_PAPER[frm.doc.paper_size]) frm.set_value("paper_size", "Receipt 80 mm");
		if (!frm.doc.pos_next_copies) frm.set_value("pos_next_copies", 1);
	},
});

function pos_format_preview(frm) {
	const doctype = POS_INVOICE_DOCTYPES.includes(frm.doc.doc_type) ? frm.doc.doc_type : "Sales Invoice";
	const dialog = new frappe.ui.Dialog({
		title: __("POS Device Preview"),
		size: "large",
		fields: [
			{
				fieldname: "invoice",
				fieldtype: "Link",
				options: doctype,
				label: __("Invoice"),
				get_query: () => ({ filters: { docstatus: 1 } }),
				onchange: () => pos_format_render(frm, dialog, doctype),
			},
			{ fieldname: "preview", fieldtype: "HTML" },
		],
	});
	dialog.show();

	pos_format_call("pos_next.api.print_templates.get_preview_invoice", { doctype })
		.then((invoice) => {
			if (invoice) dialog.set_value("invoice", invoice);
			else pos_format_notice(dialog, __("No submitted POS invoice to preview. Pick one above."));
		})
		.catch(() =>
			pos_format_notice(dialog, __("You cannot read {0} records, so there is no invoice to preview.", [__(doctype)])),
		);
}

async function pos_format_render(frm, dialog, doctype) {
	const invoice = dialog.get_value("invoice");
	if (!invoice) return;
	pos_format_show(dialog, `<p class="text-muted">${__("Loading preview...")}</p>`);

	const renderer = await pos_format_renderer();
	if (!renderer) {
		pos_format_notice(
			dialog,
			__("The template renderer is not available on this site yet. Build the POS Next assets, then reload this page."),
		);
		return;
	}

	let context;
	try {
		context = await pos_format_call("pos_next.api.print_templates.get_print_context", { invoice, doctype });
	} catch (error) {
		pos_format_notice(dialog, __("Could not load invoice {0} for the preview. You may not be allowed to read it.", [invoice]));
		return;
	}

	const paper = POS_PAPER[frm.doc.paper_size] || POS_PAPER["Receipt 80 mm"];
	context.print = { paper: paper.device, rtl: frappe.utils.is_rtl(), lang: frappe.boot.lang, copy: 1, reprint: false };
	const template = {
		name: frm.doc.name,
		template_name: frm.doc.name,
		paper: paper.device,
		html: frm.doc.html || "",
		css: frm.doc.css || "",
		copies: frm.doc.pos_next_copies || 1,
		modified: frm.doc.modified,
	};

	let output;
	try {
		output = await renderer.render(template, context);
	} catch (error) {
		const message = String(error && error.message ? error.message : error);
		pos_format_notice(dialog, __("The template has an error: {0}", [frappe.utils.escape_html(message)]));
		return;
	}

	const html = typeof output === "string" ? output : (output && output.html) || "";
	const $wrapper = dialog.fields_dict.preview.$wrapper;
	$wrapper.empty();
	$wrapper.append(
		`<p class="text-muted small">${__("As a POS device prints {0} on {1}, without a connection. Save the format first: devices get the saved one.", [
			frappe.utils.escape_html(invoice),
			frappe.utils.escape_html(frm.doc.paper_size || ""),
		])}</p>`,
	);

	// Scripts stay off: the frame shows the page and runs nothing
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-same-origin");
	frame.setAttribute("title", __("POS Device Preview"));
	frame.style.cssText = `width:${paper.width};max-width:100%;min-height:200px;border:1px solid var(--border-color);background:#fff;display:block;margin:0 auto;`;
	frame.addEventListener("load", () => {
		const root = frame.contentDocument && frame.contentDocument.documentElement;
		if (root) frame.style.height = `${root.scrollHeight + 8}px`;
	});
	frame.srcdoc = html;
	$wrapper.append(frame);
}

/** A server call that rejects on failure, so the preview never stays on "Loading" */
function pos_format_call(method, args) {
	return new Promise((resolve, reject) => {
		frappe.call({
			method,
			args,
			callback: (response) => resolve(response.message),
			error: (error) => reject(error || new Error(method)),
		});
	});
}

/** The renderer the device uses, or null when this site has not built it yet */
function pos_format_renderer() {
	const ready = () =>
		window.posPrintTemplate && typeof window.posPrintTemplate.render === "function" ? window.posPrintTemplate : null;
	if (ready()) return Promise.resolve(ready());

	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(ready());
		};
		// frappe.require resolves on a missing file too; the timer covers a load that never ends
		setTimeout(finish, 10000);
		try {
			frappe.require(POS_RENDERER_URL, finish);
		} catch (error) {
			finish();
		}
	});
}

function pos_format_notice(dialog, message) {
	pos_format_show(dialog, `<div class="alert alert-warning" role="alert">${message}</div>`);
}

function pos_format_show(dialog, html) {
	dialog.fields_dict.preview.$wrapper.html(html);
}

function pos_format_help() {
	const row = (name, text) => `<tr><td><code>${frappe.utils.escape_html(name)}</code></td><td>${text}</td></tr>`;
	const names = [
		row("doc", __("The invoice: items, taxes, payments, totals, customer, date, number, offline number, return and currency")),
		row("pos.company", __("Company name, address, tax ID, phone, email, website, currency, and logo as an image you can put in src")),
		row("pos.pos_profile", __("POS Profile name, warehouse, currency and company")),
		row("pos.cashier", __("The cashier: user and full_name")),
		row("pos.customer", __("Customer name, customer_name, tax_id, mobile_no and address")),
		row("pos.print", __("paper, rtl (right to left), lang, copy (the copy number) and reprint")),
	];
	const helpers = [
		row("_(text)", __("Translate a text")),
		row("pos.format_currency(value, currency)", __("An amount in a currency")),
		row("pos.format_date(value)", __("A date")),
		row("pos.format_datetime(value)", __("A date and time")),
		row("pos.format_number(value)", __("A number")),
		row("pos.qr(text)", __("A QR code image to put in src")),
		row("pos.barcode(text)", __("A barcode image to put in src")),
		row("pos.money_in_words(value, currency)", __("An amount in words")),
		row("doc.get_formatted(field)", __("A field formatted as Frappe does")),
	];
	const start = "{% set pos = pos_print_context(doc) %}";

	frappe.msgprint({
		title: __("POS Template Help"),
		wide: true,
		message: `
			<div class="small">
				<p>${__("POS devices download this format and render it themselves with Nunjucks, so it prints without a connection. Desk prints the same format online.")}</p>
				<p>${__("Start the template with this line, then use the names below:")}<br><code>${frappe.utils.escape_html(start)}</code></p>
				<p>${__("The device has no database, so the template cannot call frappe.db, frappe.get_doc or similar. Saving such a format is refused.")}</p>
				<h6>${__("Names you can use")}</h6>
				<table class="table table-bordered table-sm">${names.join("")}</table>
				<h6>${__("Helpers")}</h6>
				<table class="table table-bordered table-sm">${helpers.join("")}</table>
				<p class="text-muted">${__("Keep the CSS printer-safe: no web fonts, widths in mm, black on white.")}</p>
			</div>`,
	});
}
