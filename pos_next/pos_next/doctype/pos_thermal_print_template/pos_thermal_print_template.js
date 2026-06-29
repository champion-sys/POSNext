// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Thermal Print Template", {
  refresh(frm) {
    if (!frm.is_new()) {
      frm.add_custom_button(__("Open Builder"), () => {
        frappe.set_route("pos-thermal-builder", {
          template: frm.doc.name
        });
      });

      frm.add_custom_button(__("Generate Print Format"), () => {
        frappe.call({
          method: "pos_next.api.thermal_print.generate_print_format",
          args: {
            template: frm.doc.name
          },
          freeze: true,
          freeze_message: __("Generating Print Format"),
          callback(r) {
            if (!r.exc && r.message) {
              frappe.msgprint({
                title: __("Print Format Generated"),
                message: __("Print Format {0} has been generated", [
                  r.message.print_format
                ]),
                indicator: "green"
              });

              frm.reload_doc();
            }
          }
        });
      });
    }
  },

  pos_settings(frm) {
    if (!frm.doc.pos_settings) return;

    frappe.call({
      method: "pos_next.api.thermal_print.get_pos_settings_context",
      args: {
        pos_settings: frm.doc.pos_settings
      },
      callback(r) {
        if (!r.exc && r.message) {
          frm.set_value("invoice_doctype", r.message.invoice_doctype);
        }
      }
    });
  }
});