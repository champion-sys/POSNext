// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.pages["pos-sync-center"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Invoice Sync Center"),
		single_column: true,
	});
	new SyncCenter(page);
};

const STATUS_ORDER = [
	["Needs Review", "red"],
	["Retry Scheduled", "orange"],
	["Blocked", "orange"],
	["Received", "blue"],
	["Processing", "blue"],
	["Synced", "green"],
	["Resolved", "green"],
	["Voided", "gray"],
];

class SyncCenter {
	constructor(page) {
		this.page = page;
		this.body = $('<div class="frappe-card p-4"></div>').appendTo(page.main);
		page.set_primary_action(__("Refresh"), () => this.load(), "refresh");
		page.set_secondary_action(__("All Records"), () =>
			frappe.set_route("List", "Offline Invoice Sync"),
		);
		this.body.on("click", "[data-status]", (event) => {
			frappe.set_route("List", "Offline Invoice Sync", { status: event.currentTarget.dataset.status });
		});
		this.body.on("click", "[data-open]", (event) => {
			frappe.set_route("List", "Offline Invoice Sync", {
				status: "Needs Review",
				error_fingerprint: event.currentTarget.dataset.open,
			});
		});
		this.body.on("click", "[data-reprocess]", (event) => {
			this.reprocessGroup(event.currentTarget.dataset.reprocess);
		});
		this.load();
	}

	async load() {
		const { message } = await frappe.call("pos_next.api.sync.get_center_summary");
		this.render(message);
	}

	render({ counts, groups }) {
		const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.count]));
		const tiles = STATUS_ORDER.map(
			([status, color]) => `
				<button class="btn btn-default" data-status="${status}" style="min-width: 130px">
					<span class="indicator-pill ${color}">${__(status)}</span>
					<div class="mt-2" style="font-size: 20px">${cint(byStatus[status])}</div>
				</button>`,
		).join("");

		this.body.html(`
			<div class="d-flex flex-wrap" style="gap: 8px">${tiles}</div>
			<h5 class="mt-5">${__("Failures to review, grouped by cause")}</h5>
			${groups.length ? this.renderGroups(groups) : `<p class="text-muted">${__("Nothing needs review.")}</p>`}
		`);
	}

	renderGroups(groups) {
		const rows = groups
			.map((group) => {
				const fingerprint = frappe.utils.escape_html(group.error_fingerprint || "");
				return `
				<tr>
					<td>${cint(group.count)}</td>
					<td>${frappe.utils.escape_html(group.error_class || "")}</td>
					<td>${frappe.utils.escape_html(group.message || group.error_code || "")}</td>
					<td>${group.oldest ? frappe.datetime.prettyDate(group.oldest) : ""}</td>
					<td class="text-right" style="white-space: nowrap">
						<button class="btn btn-xs btn-default" data-open="${fingerprint}">${__("Open")}</button>
						<button class="btn btn-xs btn-primary" data-reprocess="${fingerprint}">${__("Reprocess All")}</button>
					</td>
				</tr>`;
			})
			.join("");

		return `
			<table class="table table-bordered mt-3">
				<thead>
					<tr>
						<th>${__("Invoices")}</th>
						<th>${__("Class")}</th>
						<th>${__("Cause")}</th>
						<th>${__("Oldest")}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>`;
	}

	reprocessGroup(fingerprint) {
		frappe.confirm(__("Have you fixed the cause? Every invoice in this group will be processed again."), async () => {
			const { message } = await frappe.call({
				method: "pos_next.api.sync.reprocess_group",
				args: { fingerprint },
				freeze: true,
			});
			const synced = message.filter((row) => row.status === "Synced").length;
			frappe.show_alert({
				message: __("{0} of {1} invoice(s) processed", [synced, message.length]),
				indicator: synced === message.length ? "green" : "orange",
			});
			this.load();
		});
	}
}
