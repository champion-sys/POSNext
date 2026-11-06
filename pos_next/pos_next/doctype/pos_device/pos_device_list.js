// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.listview_settings["POS Device"] = {
	get_indicator(doc) {
		return [__(doc.status), doc.status === "Active" ? "green" : "red", `status,=,${doc.status}`]
	},

	onload(listview) {
		listview.page.add_inner_button(__("Issue Enrollment Code"), () => {
			const dialog = new frappe.ui.Dialog({
				title: __("Issue Enrollment Code"),
				fields: [
					{
						fieldname: "allowed_profiles",
						fieldtype: "MultiSelectList",
						label: __("Allowed POS Profiles"),
						reqd: 1,
						get_data: (text) => frappe.db.get_link_options("POS Profile", text),
					},
				],
				primary_action_label: __("Issue"),
				async primary_action({ allowed_profiles }) {
					const { message } = await frappe.call({
						method: "pos_next.api.device.issue_enrollment_code",
						args: { allowed_profiles },
						freeze: true,
					})
					dialog.hide()
					frappe.msgprint({
						title: __("Enrollment Code"),
						message: __("Enter {0} on the device before {1}. It works once and is not shown again.", [
							`<b>${message.code}</b>`,
							frappe.datetime.str_to_user(message.expires_at),
						]),
					})
				},
			})
			dialog.show()
		})
	},
}
