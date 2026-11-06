// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Device", {
	refresh(frm) {
		if (frm.doc.status !== "Active") return

		frm.add_custom_button(__("Revoke Device"), () => {
			frappe.confirm(
				__("Stop this device now? It will need a new enrollment code to work again."),
				async () => {
					await frappe.call({
						method: "pos_next.api.device.revoke_device",
						args: { device: frm.doc.name },
						freeze: true,
					})
					frm.reload_doc()
				},
			)
		})
	},
})
