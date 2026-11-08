// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

// The POS device renders these templates with the same function, so the preview is what prints.
const RENDERER_URL = "/assets/pos_next/js/pos_print_template.js";
const PREVIEW_DOCTYPES = ["Sales Invoice", "POS Invoice"];
const PAPER_WIDTH = { "58mm": "58mm", "80mm": "80mm", A4: "210mm", A5: "148mm" };

frappe.ui.form.on("POS Print Template", {
	setup(frm) {
		frm.set_query("preview_doctype", () => ({ filters: { name: ["in", PREVIEW_DOCTYPES] } }));
		frm.set_query("preview_invoice", () => ({ filters: { docstatus: 1 } }));
	},

	refresh(frm) {
		frm.add_custom_button(__("Preview"), () => pos_print_template_preview(frm));
		pos_print_template_help(frm);
		pos_print_template_show(frm, "");
	},

	preview_doctype(frm) {
		frm.set_value("preview_invoice", "");
	},
});

async function pos_print_template_preview(frm) {
	const doctype = frm.doc.preview_doctype || "Sales Invoice";
	let invoice = frm.doc.preview_invoice;

	pos_print_template_show(frm, `<p class="text-muted">${__("Loading preview...")}</p>`);

	if (!invoice) {
		try {
			invoice = await pos_print_template_call("pos_next.api.print_templates.get_preview_invoice", {
				doctype,
			});
		} catch (error) {
			pos_print_template_notice(
				frm,
				__("You cannot read {0} records, so there is no invoice to preview.", [__(doctype)]),
			);
			return;
		}
		if (!invoice) {
			pos_print_template_notice(
				frm,
				__("No submitted POS invoice to preview. Pick one in Preview Invoice."),
			);
			return;
		}
	}

	const renderer = await pos_print_template_renderer();
	if (!renderer) {
		pos_print_template_notice(
			frm,
			__(
				"The template renderer is not available on this site yet, so the preview cannot be shown. Build the POS Next assets, then reload this page.",
			),
		);
		return;
	}

	let context;
	try {
		context = await pos_print_template_call("pos_next.api.print_templates.get_print_context", {
			invoice,
			doctype,
		});
	} catch (error) {
		pos_print_template_notice(frm, __("Could not load invoice {0} for the preview. You may not be allowed to read it.", [invoice]));
		return;
	}

	context.print = {
		paper: frm.doc.paper,
		rtl: frappe.utils.is_rtl(),
		lang: frappe.boot.lang,
		copy: 1,
		reprint: false,
	};

	const template = {
		name: frm.doc.name,
		template_name: frm.doc.template_name,
		paper: frm.doc.paper,
		html: frm.doc.html || "",
		css: frm.doc.css || "",
		copies: frm.doc.copies || 1,
		modified: frm.doc.modified,
	};

	let output;
	try {
		output = await renderer.render(template, context);
	} catch (error) {
		pos_print_template_notice(
			frm,
			__("The template has an error: {0}", [frappe.utils.escape_html(String(error && error.message ? error.message : error))]),
		);
		return;
	}

	const html = typeof output === "string" ? output : (output && output.html) || "";
	pos_print_template_frame(frm, pos_print_template_document(html, template.css), invoice);
}

/** A server call that rejects on failure, so the preview never stays on "Loading" */
function pos_print_template_call(method, args) {
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
function pos_print_template_renderer() {
	const ready = () => (window.posPrintTemplate && typeof window.posPrintTemplate.render === "function" ? window.posPrintTemplate : null);
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
			frappe.require(RENDERER_URL, finish);
		} catch (error) {
			finish();
		}
	});
}

/** A whole page for the frame. The template's CSS goes in when the renderer left it out. */
function pos_print_template_document(html, css) {
	if (/<html[\s>]/i.test(html)) return html;
	const style = /<style[\s>]/i.test(html) ? "" : `<style>${css}</style>`;
	return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

function pos_print_template_frame(frm, page, invoice) {
	const width = PAPER_WIDTH[frm.doc.paper] || "80mm";
	const $wrapper = frm.fields_dict.preview_html.$wrapper;
	$wrapper.empty();
	$wrapper.append(
		`<p class="text-muted small">${__("Preview of {0} on {1} paper", [frappe.utils.escape_html(invoice), frappe.utils.escape_html(frm.doc.paper || "")])}</p>`,
	);

	// Scripts stay off: the frame shows the page and runs nothing
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-same-origin");
	frame.setAttribute("title", __("Print Preview"));
	frame.style.cssText = `width:${width};max-width:100%;min-height:200px;border:1px solid var(--border-color);background:#fff;display:block;`;
	frame.addEventListener("load", () => {
		const body = frame.contentDocument && frame.contentDocument.documentElement;
		if (body) frame.style.height = `${body.scrollHeight + 8}px`;
	});
	frame.srcdoc = page;
	$wrapper.append(frame);
}

function pos_print_template_notice(frm, message) {
	pos_print_template_show(frm, `<div class="alert alert-warning" role="alert">${message}</div>`);
}

function pos_print_template_show(frm, html) {
	const field = frm.fields_dict.preview_html;
	if (field) field.$wrapper.html(html);
}

function pos_print_template_help(frm) {
	const field = frm.fields_dict.help_html;
	if (!field) return;

	const row = (name, text) => `<tr><td><code>${name}</code></td><td>${text}</td></tr>`;
	const names = [
		row("doc", __("The invoice: items, taxes, payments, totals, customer, date, number, offline number, return and currency")),
		row("company", __("Company name, address, tax ID, phone, email, website, currency, and logo as an image you can put in src")),
		row("pos_profile", __("POS Profile name, warehouse, currency and company")),
		row("cashier", __("The cashier: user and full_name")),
		row("customer", __("Customer name, customer_name, tax_id, mobile_no and address")),
		row("print", __("paper, rtl (right to left), lang, copy (the copy number) and reprint")),
	];
	const helpers = [
		row("_(text)", __("Translate a text")),
		row("format_currency(value, currency)", __("An amount in a currency")),
		row("format_date(value)", __("A date")),
		row("format_datetime(value)", __("A date and time")),
		row("format_number(value)", __("A number")),
		row("qr(text)", __("A QR code image to put in src")),
		row("barcode(text)", __("A barcode image to put in src")),
		row("money_in_words(value, currency)", __("An amount in words")),
	];

	field.$wrapper.html(`
		<div class="small">
			<p>${__("Write Jinja: {% for %}, {% if %}, {{ }} and the filters Nunjucks has. The device renders the template itself, so it prints offline.")}</p>
			<p>${__("Set the page direction from print.rtl, for example: {0}", ['<code>dir="{{ \'rtl\' if print.rtl else \'ltr\' }}"</code>'])}</p>
			<h6>${__("Names you can use")}</h6>
			<table class="table table-bordered table-sm">${names.join("")}</table>
			<h6>${__("Helpers")}</h6>
			<table class="table table-bordered table-sm">${helpers.join("")}</table>
			<p class="text-muted">${__("Keep the CSS printer-safe: no web fonts, widths in mm, black on white.")}</p>
		</div>
	`);
}
