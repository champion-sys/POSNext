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

const REVIEW_STATUS = "Needs Review";

const STATUS_GROUPS = [
	{
		title: __("Being Processed"),
		statuses: [
			["Retry Scheduled", "orange"],
			["Blocked", "orange"],
			["Received", "blue"],
			["Processing", "blue"],
		],
	},
	{
		title: __("Finished"),
		statuses: [
			["Synced", "green"],
			["Resolved", "green"],
			["Voided", "gray"],
		],
	},
];

const ERROR_TYPES = {
	stock: {
		label: __("Stock"),
		hint: __("Receive the stock or change the warehouse, then reprocess."),
	},
	business: {
		label: __("Business Rule"),
		hint: __("Open an invoice to see what to correct, then reprocess."),
	},
	dependency: {
		label: __("Waiting For A Record"),
		hint: __("Reprocess once the record it needs reaches the server."),
	},
	contract: {
		label: __("Invalid Data"),
		hint: __("Open an invoice and correct its data, or contact support."),
	},
	bug: {
		label: __("System Error"),
		hint: __("Contact support before voiding these invoices."),
	},
	transient_server: {
		label: __("Server Busy"),
		hint: __("Reprocess them now."),
	},
};

class SyncCenter {
	constructor(page) {
		this.page = page;
		this.body = $('<div class="sync-center"></div>').appendTo(page.main);
		this.has_data = false;
		page.set_primary_action(__("Refresh"), () => this.load(), "refresh");
		page.set_secondary_action(__("All Records"), () =>
			frappe.set_route("List", "Offline Invoice Sync"),
		);
		this.body.on("click", "[data-status]", (event) => {
			frappe.set_route("List", "Offline Invoice Sync", { status: event.currentTarget.dataset.status });
		});
		this.body.on("click", "[data-open]", (event) => {
			const fingerprint = event.currentTarget.dataset.open;
			frappe.set_route("List", "Offline Invoice Sync", {
				status: REVIEW_STATUS,
				...(fingerprint ? { error_fingerprint: fingerprint } : {}),
			});
		});
		this.body.on("click", "[data-reprocess]", (event) => {
			this.reprocessGroup(event.currentTarget.dataset.reprocess);
		});
		this.body.on("click", "[data-retry]", () => this.load());
		this.load();
	}

	async load() {
		// A refresh keeps the figures on screen, there is nothing to gain from a flash
		if (!this.has_data) {
			this.showMessage(__("Loading..."));
		}

		try {
			const { message } = await frappe.call("pos_next.api.sync.get_center_summary");
			this.render(message);
			this.has_data = true;
		} catch {
			if (!this.has_data) {
				this.showMessage(
					__("Could not load the sync summary."),
					`<button class="btn btn-default mt-3" data-retry>${__("Try Again")}</button>`,
				);
			}
		}
	}

	showMessage(text, action = "") {
		this.body.html(`
			<div class="sync-center-card sync-center-message">
				<p class="text-muted">${text}</p>
				${action}
			</div>
		`);
	}

	render({ counts, groups }) {
		const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.count]));

		this.body.html(`
			${this.renderHeadline(cint(byStatus[REVIEW_STATUS]))}
			<div class="sync-center-groups">
				${STATUS_GROUPS.map((group) => this.renderStatusGroup(group, byStatus)).join("")}
			</div>
			<div class="sync-center-card">
				<h5 class="sync-center-title">${__("Failures to review, grouped by cause")}</h5>
				${groups.length ? this.renderGroups(groups) : `<p class="text-muted mb-0">${__("Nothing needs review.")}</p>`}
			</div>
		`);
	}

	renderHeadline(toReview) {
		if (!toReview) {
			return `
				<div class="sync-center-headline is-clear">
					<span class="sync-center-count">0</span>
					<span>${__("No invoice needs review.")}</span>
				</div>`;
		}

		return `
			<button type="button" class="sync-center-headline is-review" data-status="${REVIEW_STATUS}">
				<span class="sync-center-count">${toReview}</span>
				<span>${__("Invoices need review. Open them to fix or close them.")}</span>
			</button>`;
	}

	renderStatusGroup({ title, statuses }, byStatus) {
		const tiles = statuses
			.map(([status, color]) => {
				const count = cint(byStatus[status]);
				return `
					<button type="button" class="sync-center-tile${count ? "" : " is-empty"}" data-status="${status}">
						<span class="sync-center-count">${count}</span>
						<span class="indicator ${color}">${__(status)}</span>
					</button>`;
			})
			.join("");

		return `
			<div class="sync-center-card">
				<h5 class="sync-center-title">${title}</h5>
				<div class="sync-center-tiles">${tiles}</div>
			</div>`;
	}

	renderGroups(groups) {
		const rows = groups
			.map((group) => {
				const fingerprint = frappe.utils.escape_html(group.error_fingerprint || "");
				const cause = frappe.utils.escape_html(group.message || group.error_code || "");
				const type = ERROR_TYPES[group.error_class];
				const type_label = type?.label || frappe.utils.escape_html(group.error_class || "");

				return `
				<tr>
					<td class="sync-center-group-count">${cint(group.count)}</td>
					<td>
						<div class="sync-center-cause" dir="auto" title="${cause}">${cause}</div>
						<div class="text-muted small">${type_label}${type ? ` - ${type.hint}` : ""}</div>
					</td>
					<td class="sync-center-nowrap">${group.oldest ? frappe.datetime.prettyDate(group.oldest) : ""}</td>
					<td class="sync-center-nowrap sync-center-actions">
						<button class="btn btn-sm btn-default" data-open="${fingerprint}">${__("View Invoices")}</button>
						${fingerprint ? `<button class="btn btn-sm btn-primary" data-reprocess="${fingerprint}">${__("Reprocess All")}</button>` : ""}
					</td>
				</tr>`;
			})
			.join("");

		return `
			<div class="table-responsive">
				<table class="table mb-0">
					<thead>
						<tr>
							<th>${__("Invoices")}</th>
							<th>${__("Cause")}</th>
							<th>${__("Oldest")}</th>
							<th></th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</div>`;
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
