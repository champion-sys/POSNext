// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.provide("frappe.pos_next");

const QUEUE_IMPORT_URL = "/api/method/pos_next.api.queue_import.import_queue_file";
const REQUEST_TOO_LARGE = 413;

/** Sends a queue file exported from a device to the server. Nothing in the file is safe to print raw. */
frappe.pos_next.QueueImport = class QueueImport {
	/** @param {() => void} onFinished - Runs after every attempt, because a failed one can store rows */
	constructor(onFinished) {
		this.onFinished = onFinished;
	}

	pick() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.onchange = () => input.files[0] && this.upload(input.files[0]);
		input.click();
	}

	async upload(file) {
		const body = new FormData();
		body.append("file", file, file.name);

		frappe.dom.freeze(__("Importing..."));
		try {
			const response = await fetch(QUEUE_IMPORT_URL, {
				method: "POST",
				headers: { Accept: "application/json", "X-Frappe-CSRF-Token": frappe.csrf_token },
				body,
			});
			const reply = await response.json().catch(() => ({}));

			if (response.ok) {
				this.showResult(reply.message);
			} else {
				this.showFailure(this.describeFailure(response.status, reply));
			}
		} catch {
			this.showFailure(this.describeFailure());
		} finally {
			frappe.dom.unfreeze();
			this.onFinished();
		}
	}

	describeFailure(status, reply) {
		if (status === REQUEST_TOO_LARGE) {
			return __("This file is too large for this server. Nothing was imported.");
		}

		const [first] = JSON.parse(reply?._server_messages || "[]");
		return (
			(first && JSON.parse(first).message) ||
			__("The import did not finish. Upload the file again: what was stored stays, and is not stored twice.")
		);
	}

	showFailure(message) {
		frappe.msgprint({ title: __("Import Queue File"), message, indicator: "red" });
	}

	showResult(result) {
		const refused = cint(result.conflicts) + cint(result.rejected);

		frappe.msgprint({
			title: __("Queue File Imported"),
			indicator: refused ? "orange" : "green",
			message: `
				${this.renderSource(result)}
				${this.renderCounts(result)}
				${this.renderProblems(result, refused)}
			`,
		});
	}

	renderSource({ device_id, server, exported_at }) {
		const [device, address, time] = [device_id, server, exported_at].map((value) =>
			frappe.utils.escape_html(value || "-"),
		);
		return `<p class="text-muted small" dir="auto">${__("Device {0}, server {1}, exported {2}", [device, address, time])}</p>`;
	}

	renderCounts({ stored, already_known, conflicts, rejected }) {
		const rows = [
			[__("Stored"), stored],
			[__("Already Known"), already_known],
			[__("Conflicts"), conflicts],
			[__("Rejected"), rejected],
		];

		return `
			<table class="table table-bordered">
				<tbody>
					${rows.map(([label, count]) => `<tr><td>${label}</td><td>${cint(count)}</td></tr>`).join("")}
				</tbody>
			</table>`;
	}

	renderProblems({ problems }, refused) {
		if (!problems?.length) {
			return "";
		}

		const rows = problems
			.map(
				({ offline_id, message }) => `
				<tr>
					<td>${frappe.utils.escape_html(offline_id || "-")}</td>
					<td dir="auto">${frappe.utils.escape_html(message || "")}</td>
				</tr>`,
			)
			.join("");

		return `
			${refused > problems.length ? `<p class="text-muted small">${__("The first {0} of {1}", [problems.length, refused])}</p>` : ""}
			<table class="table table-bordered">
				<tbody>${rows}</tbody>
			</table>`;
	}
};
