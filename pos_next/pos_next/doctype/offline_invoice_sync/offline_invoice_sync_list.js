// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.listview_settings["Offline Invoice Sync"] = {
	get_indicator(doc) {
		const colors = {
			Received: "blue",
			Processing: "blue",
			"Retry Scheduled": "orange",
			Blocked: "orange",
			"Needs Review": "red",
			Synced: "green",
			Resolved: "green",
			Voided: "gray",
		};
		return [__(doc.status), colors[doc.status] || "gray", `status,=,${doc.status}`];
	},
};
