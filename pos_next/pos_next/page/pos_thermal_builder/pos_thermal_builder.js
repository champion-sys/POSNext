frappe.pages["pos-thermal-builder"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("POS Thermal Print Builder"),
    single_column: true
  });

  $(page.body).html(frappe.render_template("pos_thermal_builder"));
  new POSThermalPrintBuilder(page);
};

const PTB_ALLOWED_BORDER_STYLES = new Set(["solid", "dashed", "dotted", "none"]);
const PTB_ALLOWED_LINE_STYLES = new Set(["solid", "dashed", "dotted"]);

function ptb_cint(value) {
  if (typeof cint === "function") return cint(value);
  const number = parseInt(value || 0, 10);
  return Number.isFinite(number) ? number : 0;
}

function ptb_flt(value) {
  if (typeof flt === "function") return flt(value);
  const number = parseFloat(value || 0);
  return Number.isFinite(number) ? number : 0;
}

class POSThermalPrintBuilder {
  constructor(page) {
    this.page = page;
    this.$root = $(page.body);
    this.api = "pos_next.api.thermal_print";

    this.state = {
      pos_settings: "",
      invoice_doctype: "",
      template: "",
      template_name: "",
      paper_size: "80",
      is_default: 0,
      company: "",
      company_logo: "",
      show_all_compatible_templates: 1,
      receipt_outputs: this.get_default_receipt_outputs(),
      elements: []
    };

    this.pos_settings_list = [];
    this.templates = [];
    this.invoice_fields = [];
    this.table_fields = [];
    this.child_table_fields = {};
    this.active_id = null;
    this.dragged_id = null;
    this.prevent_trigger = false;
    this.sample_doc = this.get_sample_doc();
    this._canvas_render_frame = null;
    this._template_load_token = null;
    this._switch_token = null;
    this._saving = false;
    this.undo_stack = [];
    this.redo_stack = [];
    this.temp_history_snapshot = null;

    this.setup_page_fields();
    this.setup_page_actions();
    this.bind();
    this.apply_translations();
    this.handle_async(() => this.load_pos_settings_list());
  }

  setup_page_fields() {
    const self = this;
    const $container = this.$root.find(".ptb-topbar-fields");

    const make_field = (df) => {
      const $field_wrapper = $('<div class="ptb-topbar-field"></div>').appendTo($container);

      if (df.fieldname === "paper_size") {
        $field_wrapper.addClass("ptb-paper-field");
      } else if (df.fieldname === "invoice_doctype") {
        $field_wrapper.addClass("ptb-invoice-doctype-field");
      } else if (df.fieldname) {
        $field_wrapper.addClass(`ptb-${df.fieldname.replace(/_/g, "-")}-field`);
      }

      const control = frappe.ui.form.make_control({
        df: df,
        parent: $field_wrapper,
        only_input: false
      });
      control.refresh();

      this.page.fields_dict[df.fieldname] = control;
      return control;
    };

    this.pos_settings_field = make_field({
      fieldname: "pos_settings",
      label: __("POS Settings"),
      fieldtype: "Select",
      change: function() {
        if (self.prevent_trigger) return;
        self.handle_async(() => self.on_pos_settings_change());
      }
    });

    this.invoice_doctype_field = make_field({
      fieldname: "invoice_doctype",
      label: __("Invoice DocType"),
      fieldtype: "Read Only"
    });

    this.template_field = make_field({
      fieldname: "template",
      label: __("Template"),
      fieldtype: "Select",
      change: function() {
        if (self.prevent_trigger) return;
        self.handle_async(() => self.on_template_select_change());
      }
    });

    this.template_name_field = make_field({
      fieldname: "template_name",
      label: __("Template Name"),
      fieldtype: "Data",
      change: function() {
        if (self.prevent_trigger) return;
        self.state.template_name = this.get_value() || "";
      }
    });

    this.paper_size_field = make_field({
      fieldname: "paper_size",
      label: __("Paper Size"),
      fieldtype: "Select",
      options: [
        { value: "58", label: "58 mm" },
        { value: "80", label: "80 mm" }
      ],
      default: "80",
      change: function() {
        if (self.prevent_trigger) return;
        self.state.paper_size = String(this.get_value() || "80");
        self.schedule_canvas_render();
      }
    });
  }

  setup_page_actions() {
    this.page.set_primary_action(
      __("Save"),
      () => this.handle_async(() => this.save_template()),
    );

    this.page.add_inner_button(__("New"), () => this.handle_async(() => this.new_template()));
    this.page.add_inner_button(__("Save As"), () => this.handle_async(() => this.save_as_template()));
    this.page.add_inner_button(__("Set Default"), () => this.handle_async(() => this.set_default_template()));
    this.page.add_inner_button(__("Generate Print Format"), () => this.handle_async(() => this.generate_print_format()));
    this.page.add_inner_button(
      __("Apply to All Active POS Settings"),
      () => this.handle_async(() => this.apply_to_all_active_pos_settings())
    );
  }

  bind() {
    this.$root.on("click", ".ptb-add", (e) => {
      const type = $(e.currentTarget).data("type");
      this.add_element(type);
    });

    this.$root.on("click", ".ptb-canvas-element", (e) => {
      e.stopPropagation();

      if ($(e.target).closest(".ptb-tool-btn").length) return;

      const id = $(e.currentTarget).data("id");
      this.set_active(id);
    });

    this.$root.on("click", ".ptb-canvas-wrap, .ptb-paper", (e) => {
      if ($(e.target).hasClass("ptb-canvas-wrap") || $(e.target).hasClass("ptb-paper") || $(e.target).hasClass("ptb-empty")) {
        if (this.active_id) {
          this.set_active(null);
        }
      }
    });

    this.$root.on("click", ".ptb-delete", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.delete_element(id);
    });

    this.$root.on("click", ".ptb-move-up", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.move_element_up(id);
    });

    this.$root.on("click", ".ptb-move-down", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.move_element_down(id);
    });

    this.$root.on("click", ".ptb-duplicate", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.duplicate_element(id);
    });

    this.$root.on("click", ".ptb-select-parent", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.select_parent_element(id);
    });
    
    this.$root.on("click", "#ptb-duplicate-active", (e) => {
      e.preventDefault();
      if (this.active_id) this.duplicate_element(this.active_id);
    });
    
    this.$root.on("click", "#ptb-clear-container", (e) => {
      e.preventDefault();
      if (this.active_id) this.clear_container(this.active_id);
    });

    this.$root.on("dragstart", ".ptb-canvas-element", (e) => {
      e.stopPropagation();
      this.dragged_id = $(e.currentTarget).data("id");
      e.originalEvent.dataTransfer.effectAllowed = "move";
    });

    this.$root.on("dragover", ".ptb-canvas-element", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const $currentTarget = $(e.currentTarget);
      const target_id = $currentTarget.data("id");

      if (this.dragged_id === target_id) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const relY = e.originalEvent.clientY - rect.top;
      const target_info = this.find_element_info(target_id);

      let position = "before";
      if (target_info && target_info.element.type === "container" && (!target_info.element.children || target_info.element.children.length === 0)) {
        position = "inside";
      } else {
        position = relY < rect.height / 2 ? "before" : "after";
      }

      this.drop_position = position;

      this.$root.find(".ptb-dragover, .ptb-dragover-top, .ptb-dragover-bottom, .ptb-dragover-inside").removeClass("ptb-dragover ptb-dragover-top ptb-dragover-bottom ptb-dragover-inside");

      if (position === "before") {
        $currentTarget.addClass("ptb-dragover-top");
      } else if (position === "after") {
        $currentTarget.addClass("ptb-dragover-bottom");
      } else {
        $currentTarget.addClass("ptb-dragover-inside");
      }
    });

    this.$root.on("dragleave drop dragend", ".ptb-canvas-element", (e) => {
      $(e.currentTarget).removeClass("ptb-dragover ptb-dragover-top ptb-dragover-bottom ptb-dragover-inside");
    });

    this.$root.on("dragend", ".ptb-canvas-element", () => {
      this.$root.find(".ptb-dragover, .ptb-dragover-top, .ptb-dragover-bottom, .ptb-dragover-inside").removeClass("ptb-dragover ptb-dragover-top ptb-dragover-bottom ptb-dragover-inside");
    });

    this.$root.on("drop", ".ptb-canvas-element", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const target_id = $(e.currentTarget).data("id");
      this.reorder_element(this.dragged_id, target_id, this.drop_position);
      this.dragged_id = null;
      this.drop_position = null;
    });

    this.$root.on("input", ".ptb-inline-edit", (e) => {
      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      const element = this.find_element(id);
      if (!element) return;

      const $el = $(e.currentTarget);
      const prop = $el.data("prop");
      const row_idx = $el.attr("data-row-idx");

      if (row_idx !== undefined && row_idx !== null && element.rows) {
        const idx = parseInt(row_idx, 10);
        if (element.rows[idx]) {
          element.rows[idx].label = e.currentTarget.innerText;
          element.rows_text = this.details_rows_to_text(element.rows);
          this.$root.find(`#ptb-props [data-prop="rows_text"]`).val(element.rows_text);
        }
      } else if (prop) {
        this.set_nested_value(element, prop, e.currentTarget.innerText);
        this.$root.find(`#ptb-props [data-prop="${prop}"]`).val(e.currentTarget.innerText);
      } else {
        element.content = e.currentTarget.innerText;
        this.$root.find(`#ptb-props [data-prop="content"]`).val(element.content);
      }
    });

    this.$root.on("mouseenter", ".ptb-inline-edit", (e) => {
      $(e.currentTarget).closest(".ptb-canvas-element").attr("draggable", "false");
    });

    this.$root.on("mouseleave", ".ptb-inline-edit", (e) => {
      if (!$(e.currentTarget).is(":focus")) {
        $(e.currentTarget).closest(".ptb-canvas-element").attr("draggable", "true");
      }
    });

    this.$root.on("focus", ".ptb-inline-edit", (e) => {
      $(e.currentTarget).closest(".ptb-canvas-element").attr("draggable", "false");
      this.temp_history_snapshot = {
        elements: JSON.parse(JSON.stringify(this.state.elements)),
        active_id: this.active_id
      };
    });

    this.$root.on("blur", ".ptb-inline-edit", (e) => {
      $(e.currentTarget).closest(".ptb-canvas-element").attr("draggable", "true");
      this.commit_temp_history();
    });

    this.$root.on("focus", "#ptb-props [data-prop], #ptb-props [data-column]", (e) => {
      this.temp_history_snapshot = {
        elements: JSON.parse(JSON.stringify(this.state.elements)),
        active_id: this.active_id
      };
    });

    this.$root.on("blur change", "#ptb-props [data-prop], #ptb-props [data-column]", (e) => {
      this.commit_temp_history();
    });

    this.$root.on("input change", "#ptb-props [data-output-prop]", (e) => {
      this.update_receipt_output_from_input(e.currentTarget);
    });

    this.$root.on("change", "#ptb-props [data-visible-context]", (e) => {
      this.update_visible_in_from_input(e.currentTarget);
    });

    this.$root.on("input change", "#ptb-props [data-prop]", (e) => {
      this.update_active_from_input(e.currentTarget);
    });

    this.$root.on("change", "#ptb-props [data-column]", (e) => {
      this.update_table_columns(e.currentTarget);
    });

    this.$root.on("click", "#ptb-upload-image", (e) => {
      e.preventDefault();
      this.handle_async(() => this.upload_image_for_active_element());
    });

    this.$root.on("click", "#ptb-add-field-to-container", (e) => {
      e.preventDefault();
      this.add_element("field");
    });

    this.$root.on("click", "#ptb-close-code, #ptb-close-code-bottom", () => {
      this.$root.find("#ptb-code-modal").addClass("ptb-hidden");
    });

    this.$root.on("click", "#ptb-copy-code", () => this.handle_async(() => this.copy_generated_code()));

    $(document).on("keydown.ptb_history", (e) => {
      if ($(e.target).is("input, textarea, [contenteditable=true]")) {
        return;
      }

      const is_mac = /Mac|iPad|iPhone|iPod/.test(navigator.platform);
      const cmd_or_ctrl = is_mac ? e.metaKey : e.ctrlKey;

      if (cmd_or_ctrl && !e.altKey) {
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          if (e.shiftKey) {
            this.redo();
          } else {
            this.undo();
          }
        } else if (e.key === "y" || e.key === "Y") {
          e.preventDefault();
          this.redo();
        }
      }
    });

    this.$root.on("click", ".ptb-undo:not(.disabled)", (e) => {
      e.preventDefault();
      this.undo();
    });

    this.$root.on("click", ".ptb-redo:not(.disabled)", (e) => {
      e.preventDefault();
      this.redo();
    });

    this.$root.on("click", ".ptb-toggle-code", (e) => {
      e.preventDefault();
      const $modal = this.$root.find("#ptb-code-modal");
      if ($modal.hasClass("ptb-hidden")) {
        const generated_html = this.generate_print_format_html();
        this.show_generated_code(generated_html);
      } else {
        $modal.addClass("ptb-hidden");
      }
    });

    this.$root.on("click", ".ptb-print-test", (e) => {
      e.preventDefault();
      this.print_test();
    });
  }

  apply_translations() {

    const lang = ((frappe.boot && frappe.boot.lang) || "en").split("-")[0];
    const rtl_languages = ["ar", "fa", "he", "ur"];
    const direction = rtl_languages.includes(lang) ? "rtl" : "ltr";

    this.$root.find(".ptb-shell").attr("dir", direction);
    this.$root.find("#ptb-code-modal").attr("dir", direction);
  }

  async call(method, args = {}, freeze = false) {
    return new Promise((resolve, reject) => {
      frappe.call({
        method: `${this.api}.${method}`,
        args,
        freeze,
        callback: (r) => {
          if (r.exc) {
            reject(this.normalize_error(r));
            return;
          }

          resolve(r.message);
        },
        error: (xhr) => reject(this.normalize_error(xhr))
      });
    });
  }

  handle_async(fn) {
    return Promise.resolve()
      .then(fn)
      .catch((error) => this.show_error(error));
  }

  async with_prevent_trigger(fn) {
    this.prevent_trigger = true;
    try {
      await fn();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      this.prevent_trigger = false;
    }
  }

  normalize_error(error) {
    if (!error) return __("Unknown error");

    if (typeof error === "string") {
      return error;
    }

    if (error._server_messages) {
      try {
        const messages = JSON.parse(error._server_messages)
          .map((message) => JSON.parse(message).message)
          .filter(Boolean);

        if (messages.length) {
          return messages.join("<br>");
        }
      } catch (e) {
        // Fall through to other formats.
      }
    }

    if (error.message) return error.message;
    if (error.exc) return error.exc;

    return String(error);
  }

  show_error(error) {
    const message = this.normalize_error(error);

    frappe.msgprint({
      title: __("POS Thermal Print Builder"),
      message,
      indicator: "red"
    });

    console.error(error);
  }

  schedule_canvas_render() {
    if (this._canvas_render_frame) {
      window.cancelAnimationFrame(this._canvas_render_frame);
    }

    this._canvas_render_frame = window.requestAnimationFrame(() => {
      this._canvas_render_frame = null;
      this.render_canvas();
    });
  }

  depends(condition, html) {
    return condition ? html : "";
  }

  async load_pos_settings_list() {
    const records = await this.call("get_pos_settings_list");
    this.pos_settings_list = records || [];

    if (!this.pos_settings_list.length) {
      this.page.fields_dict.pos_settings.df.options = [
        { value: "", label: __("No POS Settings found") }
      ];
      this.page.fields_dict.pos_settings.refresh();
      return;
    }

    const options = this.pos_settings_list.map((row) => {
      const label = row.pos_profile ? `${row.pos_profile} (${row.name})` : row.name;
      return { value: row.name, label };
    });

    this.page.fields_dict.pos_settings.df.options = options;

    // Guard: refresh() auto-selects the first option and fires the 'change' event
    // synchronously. Without this guard, on_pos_settings_change() would launch a
    // parallel _switch_pos_settings() before the one below, causing a page freeze.
    await this.with_prevent_trigger(async () => {
      this.page.fields_dict.pos_settings.refresh();
    });

    const route_template = frappe.route_options && frappe.route_options.template;

    if (route_template) {
      frappe.route_options = null;
      await this.load_template(route_template);
      return;
    }

    await this._switch_pos_settings(this.pos_settings_list[0].name);
  }

  async on_pos_settings_change() {
    if (this.prevent_trigger) return;

    const pos_settings = this.page.fields_dict.pos_settings.get_value();

    if (!pos_settings || pos_settings === this.state.pos_settings) return;

    await this._switch_pos_settings(pos_settings);
  }

  async _switch_pos_settings(pos_settings) {
    const token = (this._switch_token = {});

    this.state.pos_settings = pos_settings;

    const context = await this.call("get_pos_settings_context", { pos_settings });

    if (token !== this._switch_token) return;

    this.state.invoice_doctype = context.invoice_doctype || "POS Invoice";
    this.state.company = context.company || "";
    this.state.company_logo = context.company_logo || "";

    this.sample_doc.company = this.state.company || __("Company");
    this.sample_doc.company_logo = this.state.company_logo || "";

    await this._load_pos_settings_data(pos_settings, this.state.invoice_doctype);

    if (token !== this._switch_token) return;

    this.state.template = "";
    this.state.template_name = "";
    this.state.is_default = 0;
    this.state.receipt_outputs = this.get_default_receipt_outputs();
    this.state.elements = [];
    this.active_id = null;

    await this.with_prevent_trigger(async () => {
      await this.page.fields_dict.pos_settings.set_value(pos_settings);
      await this.page.fields_dict.invoice_doctype.set_value(this.state.invoice_doctype);
      await this.page.fields_dict.template_name.set_value("");
      if (this.page.fields_dict.show_all_compatible_templates) {
        await this.page.fields_dict.show_all_compatible_templates.set_value(
          this.state.show_all_compatible_templates ? 1 : 0
        );
      }
      this._set_template_name_enabled(true);
      await this._refresh_template_options();
    });

    this.render();
  }

  async _load_pos_settings_data(pos_settings, invoice_doctype) {
    const [fields_result, templates] = await Promise.all([
      this.call("get_invoice_doctype_fields", { invoice_doctype }),
      this.call("list_templates", {
        pos_settings,
        invoice_doctype,
        include_all_compatible: 1
      })
    ]);

    this.invoice_fields = (fields_result && fields_result.fields) || [];
    this.table_fields = (fields_result && fields_result.table_fields) || [];
    this.templates = templates || [];

    const child_doctypes = [...new Set(
      (this.table_fields || [])
        .map((field) => field.options)
        .filter(Boolean)
    )];

    await Promise.all(child_doctypes.map(async (child_doctype) => {
      if (this.child_table_fields[child_doctype]) return;

      const child = await this.call("get_child_table_fields", { child_doctype });
      this.child_table_fields[child_doctype] = (child && child.fields) || [];
    }));
  }

  async _refresh_template_options() {
    const options = [{ value: "", label: __("New Template") }];

    this.templates.forEach((row) => {
      const default_suffix = row.is_default ? ` - ${__("Default")}` : "";
      const pos_suffix = row.is_current_pos_settings
        ? ""
        : ` - ${row.pos_settings || ""}`;

      options.push({
        value: row.name,
        label: `${row.template_name}${pos_suffix}${default_suffix}`
      });
    });

    this.page.fields_dict.template.df.options = options;
    this.page.fields_dict.template.refresh();
    await this.page.fields_dict.template.set_value(this.state.template || "");
  }


  get_default_receipt_outputs() {
    return {
      enabled: false,
      page_break_between_receipts: true,
      customer: {
        enabled: true,
        title: "Customer Receipt",
        item_source: "all_items"
      },
      waiter: {
        enabled: false,
        title: "Waiter Receipt",
        item_source: "all_items"
      },
      item_group: {
        enabled: false,
        title_prefix: "Receipt for",
        group_by: "item_group",
        item_source: "group_items"
      }
    };
  }

  normalize_receipt_outputs(receipt_outputs) {
    const defaults = this.get_default_receipt_outputs();
    const value = receipt_outputs || {};

    return {
      enabled: value.enabled !== undefined ? value.enabled : defaults.enabled,
      page_break_between_receipts: value.page_break_between_receipts !== undefined
        ? value.page_break_between_receipts
        : defaults.page_break_between_receipts,
      customer: Object.assign({}, defaults.customer, value.customer || {}),
      waiter: Object.assign({}, defaults.waiter, value.waiter || {}),
      item_group: Object.assign({}, defaults.item_group, value.item_group || {})
    };
  }

  get_receipt_contexts() {
    return [
      ["single", __("Single Receipt")],
      ["customer", __("Customer Receipt")],
      ["waiter", __("Waiter Receipt")],
      ["item_group", __("Item Group Receipts")]
    ];
  }

  get_default_visible_in(type) {
    if (["payments", "footer_note", "qr_code", "barcode"].includes(type)) {
      return ["single", "customer"];
    }

    return ["single", "customer", "waiter", "item_group"];
  }

  get_receipt_output_value(path) {
    const parts = String(path).split(".");
    let current = this.state.receipt_outputs || this.get_default_receipt_outputs();

    for (const part of parts) {
      if (current == null) return null;
      current = current[part];
    }

    return current;
  }

  set_receipt_output_value(path, value) {
    const parts = String(path).split(".");
    this.state.receipt_outputs = this.state.receipt_outputs || this.get_default_receipt_outputs();

    let current = this.state.receipt_outputs;
    while (parts.length > 1) {
      const part = parts.shift();
      current[part] = current[part] || {};
      current = current[part];
    }

    current[parts[0]] = value;
  }

  receipt_output_checkbox(path, label) {
    const value = this.get_receipt_output_value(path);

    return `
      <label class="ptb-check">
        <input type="checkbox" data-output-prop="${this.escape_attr(path)}" ${value ? "checked" : ""}>
        <span>${this.escape_html(label)}</span>
      </label>
    `;
  }

  receipt_output_input(path, label, value = null) {
    const actual_value = value === null ? this.get_receipt_output_value(path) : value;

    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <input type="text" data-output-prop="${this.escape_attr(path)}" value="${this.escape_attr(actual_value ?? "")}">
      </div>
    `;
  }

  render_receipt_outputs_props() {
    const outputs = this.state.receipt_outputs || this.get_default_receipt_outputs();

    return `
      <div class="ptb-section-label">${__("Receipt Outputs")}</div>
      ${this.receipt_output_checkbox("enabled", __("Enable Multiple Receipts"))}

      ${this.depends(outputs.enabled, `
        ${this.receipt_output_checkbox("customer.enabled", __("Print Customer Receipt"))}
        ${this.depends(outputs.customer && outputs.customer.enabled, `
          ${this.receipt_output_input("customer.title", __("Customer Receipt Title"))}
        `)}

        ${this.receipt_output_checkbox("waiter.enabled", __("Print Waiter Receipt"))}
        ${this.depends(outputs.waiter && outputs.waiter.enabled, `
          ${this.receipt_output_input("waiter.title", __("Waiter Receipt Title"))}
        `)}

        ${this.receipt_output_checkbox("item_group.enabled", __("Print Item Group Receipts"))}
        ${this.depends(outputs.item_group && outputs.item_group.enabled, `
          ${this.receipt_output_input("item_group.title_prefix", __("Item Group Receipt Title Prefix"))}
          ${this.receipt_output_input("item_group.group_by", __("Group By Field"), outputs.item_group.group_by || "item_group")}
          <div class="ptb-help">${__("Usually this is item_group. You can use any field from the invoice items table.")}</div>
        `)}

        ${this.receipt_output_checkbox("page_break_between_receipts", __("Add Page Break Between Receipts"))}
      `)}

      <div class="ptb-help">
        ${__("When multiple receipts are enabled, use the Visible In setting on each element to control where it appears.")}
      </div>
    `;
  }

  visible_in_html(element) {
    const visible_in = Array.isArray(element.visible_in)
      ? element.visible_in
      : this.get_default_visible_in(element.type);

    const options = this.get_receipt_contexts()
      .map(([value, label]) => `
        <label class="ptb-check">
          <input type="checkbox" data-visible-context="${this.escape_attr(value)}" ${visible_in.includes(value) ? "checked" : ""}>
          <span>${this.escape_html(label)}</span>
        </label>
      `)
      .join("");

    return `
      <div class="ptb-section-label">${__("Visibility")}</div>
      ${options}
      <div class="ptb-help">
        ${__("Choose where this element should appear when multiple receipts are generated. Single Receipt is used when multiple receipts are disabled.")}
      </div>
    `;
  }

  _set_template_name_enabled(enabled) {
    const field = this.page.fields_dict.template_name;
    if (!field) return;

    field.df.read_only = enabled ? 0 : 1;
    field.refresh();
  }

  async on_template_select_change() {
    if (this.prevent_trigger) return;

    const template = this.page.fields_dict.template.get_value();

    if (!template) {
      await this.new_template(false);
      return;
    }

    await this.load_template(template);
  }

  async load_template(template) {
    const token = (this._template_load_token = {});
    const data = await this.call("get_template", { template });

    if (token !== this._template_load_token) return;

    this.state.pos_settings = data.pos_settings;
    this.state.invoice_doctype = data.invoice_doctype;
    this.state.template = data.name;
    this.state.template_name = data.template_name;
    this.state.paper_size = String(data.paper_size || "80");
    this.state.is_default = ptb_cint(data.is_default);

    const layout = data.layout_json || {};
    this.state.receipt_outputs = this.normalize_receipt_outputs(layout.receipt_outputs);
    this.state.elements = this.normalize_elements(layout.elements || []);
    this.active_id = null;

    await this._load_pos_settings_data(this.state.pos_settings, this.state.invoice_doctype);

    if (token !== this._template_load_token) return;

    await this.with_prevent_trigger(async () => {
      await this.page.fields_dict.pos_settings.set_value(this.state.pos_settings);
      await this.page.fields_dict.invoice_doctype.set_value(this.state.invoice_doctype);
      await this.page.fields_dict.template_name.set_value(this.state.template_name);
      this._set_template_name_enabled(false);
      await this.page.fields_dict.paper_size.set_value(this.state.paper_size);
      await this._refresh_template_options();
    });

    this.render();
  }

  async new_template(clear_name = true) {
    this.state.template = "";
    this.state.template_name = clear_name ? "" : this.state.template_name;
    this.state.paper_size = "80";
    this.state.is_default = 0;
    this.state.receipt_outputs = this.get_default_receipt_outputs();
    this.state.elements = [];
    this.active_id = null;

    await this.with_prevent_trigger(async () => {
      await this.page.fields_dict.template.set_value("");
      await this.page.fields_dict.template_name.set_value(this.state.template_name);
      this._set_template_name_enabled(true);
      await this.page.fields_dict.paper_size.set_value(this.state.paper_size);
    });

    this.render();
  }

  async save_template() {
    if (this._saving) return;

    this._saving = true;

    try {
      if (!this.state.pos_settings) {
        frappe.throw(__("POS Settings is required"));
        return;
      }

      const template_name = (this.page.fields_dict.template_name.get_value() || "").trim();

      if (!template_name) {
        frappe.throw(__("Template Name is required"));
        return;
      }

      const generated_html = this.generate_print_format_html();

      const result = await this.call("save_template", {
        pos_settings: this.state.pos_settings,
        template_name,
        paper_size: this.state.paper_size,
        layout_json: this.get_layout_json(),
        generated_html,
        generated_css: "",
        template: this.state.template || null,
        is_default: this.state.is_default || 0,
        disabled: 0,
        remarks: ""
      }, true);

      this.state.template = result.name;
      this.state.template_name = result.template_name;
      this.state.is_default = result.is_default || 0;

      const saved_templates = await this.call("list_templates", {
        pos_settings: this.state.pos_settings,
        invoice_doctype: this.state.invoice_doctype,
        include_all_compatible: 1
      });

      this.templates = saved_templates || [];

      await this.with_prevent_trigger(async () => {
        await this._refresh_template_options();
        await this.page.fields_dict.template_name.set_value(this.state.template_name);
        this._set_template_name_enabled(false);
      });

      frappe.show_alert({ message: __("Template saved"), indicator: "green" });
    } finally {
      this._saving = false;
    }
  }

  async save_as_template() {
    frappe.prompt(
      [
        {
          fieldname: "template_name",
          label: __("New Template Name"),
          fieldtype: "Data",
          reqd: 1
        }
      ],
      (values) => this.handle_async(async () => {
        const old_template = this.state.template;
        const old_template_name = this.state.template_name;

        this.state.template = "";
        this.page.fields_dict.template_name.set_value(values.template_name);
        this.state.template_name = values.template_name;

        try {
          await this.save_template();
        } catch (e) {
          this.state.template = old_template;
          this.state.template_name = old_template_name;
          this.page.fields_dict.template_name.set_value(old_template_name);
          throw e;
        }
      }),
      __("Save As"),
      __("Save")
    );
  }

  async set_default_template() {
    await this.save_template();

    const result = await this.call("set_default_template", {
      template: this.state.template
    }, true);

    this.state.is_default = 1;

    const default_templates = await this.call("list_templates", {
      pos_settings: this.state.pos_settings,
      invoice_doctype: this.state.invoice_doctype,
      include_all_compatible: 1
    });

    this.templates = default_templates || [];

    await this.with_prevent_trigger(async () => {
      await this._refresh_template_options();
    });

    const message = result.pos_profile_updated
      ? __("Template set as default and assigned to POS Profile")
      : __("Template set as default");

    frappe.show_alert({ message, indicator: "green" });
  }

  async apply_to_all_active_pos_settings() {
    await this.save_template();

    frappe.confirm(
      __(
        "This will assign the generated Print Format of this template to all active POS Settings with the same Invoice DocType. Continue?"
      ),
      async () => {
        const result = await this.call("apply_template_to_all_active_pos_settings", {
          template: this.state.template
        }, true);

        frappe.msgprint({
          title: __("Template Applied"),
          message: __(
            "Print Format {0} was assigned to {1} POS Profiles. Skipped: {2}",
            [
              result.print_format,
              result.updated_count || 0,
              result.skipped_count || 0
            ]
          ),
          indicator: "green"
        });
      }
    );
  }

  async generate_print_format() {
    await this.save_template();

    const result = await this.call("generate_print_format", {
      template: this.state.template
    }, true);

    const generated_html = this.generate_print_format_html();
    this.show_generated_code(generated_html);

    frappe.msgprint({
      title: __("Print Format Generated"),
      message: __("Print Format {0} has been generated", [result.print_format]),
      indicator: "green"
    });
  }

  get_layout_json() {
    return {
      version: 1,
      pos_settings: this.state.pos_settings,
      invoice_doctype: this.state.invoice_doctype,
      paper_size: this.state.paper_size,
      receipt_outputs: this.state.receipt_outputs || this.get_default_receipt_outputs(),
      elements: this.state.elements
    };
  }

  normalize_elements(elements) {
    return (elements || []).map((element) => {
      const default_element = this.get_default_element(element.type);
      const normalized = Object.assign({}, default_element, element);

      if (!Array.isArray(normalized.visible_in)) {
        normalized.visible_in = this.get_default_visible_in(normalized.type);
      }

      if (normalized.type === "items_table") {
        normalized.child_doctype = normalized.child_doctype || this.get_child_doctype_for_table_field(normalized.table_fieldname || "items");

        if (!Array.isArray(normalized.columns)) {
          normalized.columns = this.get_default_item_columns_for_field(normalized.table_fieldname || "items");
        }

        normalized.extra_row = Object.assign(
          {},
          default_element.extra_row || {},
          element.extra_row || {}
        );
      }

      if (normalized.type === "container") {
        normalized.children = this.normalize_elements(element.children || []);
      }

      return normalized;
    });
  }

  find_first_element_by_type(type, list = this.state.elements) {
    for (const element of list || []) {
      if (element.type === type) return element;

      if (element.children && element.children.length) {
        const found = this.find_first_element_by_type(type, element.children);
        if (found) return found;
      }
    }

    return null;
  }

  add_element(type, overrides = {}) {
    this.save_history();
    const element = Object.assign(this.get_default_element(type), overrides);
    const active = this.find_element(this.active_id);

    if (active && active.type === "container" && type !== "container") {
      active.children = active.children || [];
      active.children.push(element);
    } else {
      this.state.elements.push(element);
    }

    this.active_id = element.id;
    this.render();
  }


  get_default_invoice_fieldname() {
    if ((this.invoice_fields || []).some((field) => field.fieldname === "name")) {
      return "name";
    }

    return (this.invoice_fields && this.invoice_fields[0] && this.invoice_fields[0].fieldname) || "name";
  }

  get_default_invoice_field_label() {
    const fieldname = this.get_default_invoice_fieldname();
    const field = (this.invoice_fields || []).find((df) => df.fieldname === fieldname);

    if (field && field.label) {
      return field.label;
    }

    return fieldname === "name" ? "Invoice Number" : fieldname;
  }

  get_field_meta(fieldname, fields = this.invoice_fields) {
    const safe = this.safe_fieldname(fieldname);
    return (fields || []).find((field) => field.fieldname === safe) || null;
  }

  get_field_label(fieldname, fields = this.invoice_fields) {
    const field = this.get_field_meta(fieldname, fields);
    return (field && field.label) || fieldname;
  }

  get_child_doctype_for_table_field(table_fieldname) {
    const table_field = (this.table_fields || []).find((df) => df.fieldname === table_fieldname);
    return (table_field && table_field.options) || "";
  }

  get_table_field_options() {
    return (this.table_fields || [])
      .filter((field) => field.fieldname && field.options)
      .map((field) => {
        let label = `${field.label || field.fieldname} (${field.fieldname})`;
        if (field.is_custom) {
          label += ` [${__("Custom")}]`;
        }
        return [field.fieldname, label];
      });
  }

  get_child_fields_for_table(element) {
    const child_doctype = element.child_doctype || this.get_child_doctype_for_table_field(element.table_fieldname || "items");
    return this.child_table_fields[child_doctype] || [];
  }

  get_default_item_columns_for_field(table_fieldname = "items") {
    const child_doctype = this.get_child_doctype_for_table_field(table_fieldname);
    const fields = this.child_table_fields[child_doctype] || [];
    const preferred = ["item_name", "item_code", "description", "qty", "uom", "rate", "price_list_rate", "amount"];
    const available = new Set(fields.map((field) => field.fieldname));

    const columns = preferred.filter((fieldname) => available.has(fieldname));

    if (columns.length) {
      return columns.includes("item_name")
        ? columns.filter((fieldname) => ["item_name", "qty", "rate", "amount"].includes(fieldname))
        : columns.slice(0, 4);
    }

    return ["item_name", "qty", "rate", "amount"];
  }

  get_extra_row_field_options(element) {
    const options = [["", __("None")]];
    const fields = this.get_child_fields_for_table(element);

    fields.forEach((field) => {
      let label = `${field.label || field.fieldname} (${field.fieldname})`;
      if (field.is_custom) {
        label += ` [${__("Custom")}]`;
      }
      options.push([field.fieldname, label]);
    });

    return options;
  }

  ensure_items_table_metadata(element) {
    if (!element || element.type !== "items_table") return;

    element.table_fieldname = element.table_fieldname || "items";
    element.child_doctype = element.child_doctype || this.get_child_doctype_for_table_field(element.table_fieldname);

    if (!Array.isArray(element.columns) || !element.columns.length) {
      element.columns = this.get_default_item_columns_for_field(element.table_fieldname);
    }

    element.extra_row = Object.assign(
      { enabled: false, fieldname: "", prefix: "#" },
      element.extra_row || {}
    );
  }

  get_default_element(type) {
    const base = {
      id: this.make_id(),
      type,
      label: this.get_type_label(type),
      align: "center",
      font_size: 11,
      bold: false,
      margin_top: 2,
      margin_bottom: 2,
      visible_in: this.get_default_visible_in(type)
    };

    const defaults = {
      text: {
        content: "Custom Text",
        align: "center",
        font_size: 12,
        bold: true
      },
      field: {
        fieldname: this.get_default_invoice_fieldname(),
        label: this.get_default_invoice_field_label(),
        show_label: true,
        translate_label: true,
        align: "right"
      },
      image: {
        source_type: "company_logo",
        image_url: "",
        file_url: "",
        width: 23,
        align: "center"
      },
      divider: {
        line_style: "dashed"
      },
      spacer: {
        height: 8
      },
      cutter: {
        margin_top: 2,
        margin_bottom: 2
      },
      container: {
        border_width: 1,
        border_style: "solid",
        border_color: "#000000",
        border_radius: 8,
        padding: 6,
        background_color: "#ffffff",
        children: []
      },
      details_table: {
        title: "",
        show_title: false,
        border_width: 1,
        border_style: "solid",
        border_color: "#000000",
        border_radius: 10,
        header_bg_color: "#f2f0f0",
        padding: 6,
        font_size: 11,
        rows: [
          {
            label: "Invoice Number",
            fieldname: "name",
            translate_label: true
          },
          {
            label: "Date",
            fieldname: "posting_date",
            translate_label: true
          }
        ],
        rows_text: "Invoice Number|name\nDate|posting_date"
      },
      footer_note: {
        content: "Items are not refundable. Exchange only within 24 hours.",
        font_size: 9,
        align: "center",
        bold: false
      },
      receipt_title: {
        use_receipt_context_title: true,
        custom_title: "",
        font_size: 14,
        align: "center",
        bold: true
      },
      qr_code: {
        content_type: "document_field",
        static_value: "",
        url: "",
        fieldname: "name",
        fields: ["name", "grand_total"],
        custom_jinja: "doc.name",
        width: 26,
        align: "center"
      },
      barcode: {
        content_type: "document_field",
        static_value: "",
        url: "",
        fieldname: "name",
        fields: ["name", "grand_total"],
        custom_jinja: "doc.name",
        barcode_type: "code128",
        width: 40,
        align: "center"
      },
      items_table: {
        show_header: true,
        table_fieldname: "items",
        child_doctype: this.get_child_doctype_for_table_field("items"),
        columns: this.get_default_item_columns_for_field("items"),
        extra_row: {
          enabled: false,
          fieldname: "",
          prefix: "#"
        },
        header_bg_color: "#f2f0f0",
        header_text_color: "#000000",
        header_border_color: "#000000",
        font_size: 10,
        align: "right"
      },
      totals: {
        show_net_total: true,
        show_taxes: true,
        show_grand_total: true,
        show_paid_amount: true,
        show_change_amount: true,
        font_size: 11,
        align: "right"
      },
      payments: {
        show_header: true,
        font_size: 11,
        align: "right"
      },
      taxes: {
        show_header: true,
        font_size: 10,
        align: "right"
      }
    };

    return Object.assign(base, defaults[type] || {});
  }

  get_type_label(type) {
    const labels = {
      text: "Text",
      field: "Field",
      image: "Image",
      divider: "Divider",
      spacer: "Spacer",
      cutter: "Cutter",
      container: "Container",
      details_table: "Details Table",
      footer_note: "Footer Note",
      receipt_title: "Receipt Title",
      qr_code: "QR Code",
      barcode: "Barcode",
      items_table: "Items Table",
      totals: "Totals",
      payments: "Payments",
      taxes: "Taxes and Charges"
    };

    return labels[type] || type;
  }

  make_id() {
    return `el_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  set_active(id) {
    if (this.active_id === id) return;
    this.active_id = id;
    this.$root.find(".ptb-canvas-element").removeClass("ptb-active");
    if (id) {
      this.$root.find(`.ptb-canvas-element[data-id="${id}"]`).addClass("ptb-active");
    }
    this.render_props();
  }

  find_element(id, list = this.state.elements) {
    if (!id) return null;

    for (const element of list) {
      if (element.id === id) return element;

      if (element.children && element.children.length) {
        const found = this.find_element(id, element.children);
        if (found) return found;
      }
    }

    return null;
  }

  delete_element(id, list = this.state.elements) {
    if (list === this.state.elements) {
      this.save_history();
    }
    const index = list.findIndex((el) => el.id === id);

    if (index > -1) {
      list.splice(index, 1);

      if (this.active_id === id) {
        this.active_id = null;
      }

      this.render();
      return true;
    }

    for (const element of list) {
      if (element.children && this.delete_element(id, element.children)) {
        return true;
      }
    }

    return false;
  }

  find_element_info(id, list = this.state.elements, parent = null) {
    if (!id) return null;

    for (let i = 0; i < list.length; i++) {
      const element = list[i];

      if (element.id === id) {
        return {
          element,
          index: i,
          parent,
          list
        };
      }

      if (element.children && element.children.length) {
        const found = this.find_element_info(id, element.children, element);
        if (found) return found;
      }
    }

    return null;
  }

  save_history() {
    if (this.undo_stack.length >= 100) {
      this.undo_stack.shift();
    }
    this.undo_stack.push({
      elements: JSON.parse(JSON.stringify(this.state.elements)),
      active_id: this.active_id
    });
    this.redo_stack = [];
  }

  commit_temp_history() {
    if (!this.temp_history_snapshot) return;

    const elements_changed = JSON.stringify(this.state.elements) !== JSON.stringify(this.temp_history_snapshot.elements);
    if (elements_changed) {
      if (this.undo_stack.length >= 100) {
        this.undo_stack.shift();
      }
      this.undo_stack.push(this.temp_history_snapshot);
      this.redo_stack = [];
    }
    this.temp_history_snapshot = null;
  }

  undo() {
    if (!this.undo_stack.length) return;

    this.redo_stack.push({
      elements: JSON.parse(JSON.stringify(this.state.elements)),
      active_id: this.active_id
    });

    const previous = this.undo_stack.pop();
    this.state.elements = previous.elements;
    this.active_id = previous.active_id;

    this.render();
  }

  redo() {
    if (!this.redo_stack.length) return;

    this.undo_stack.push({
      elements: JSON.parse(JSON.stringify(this.state.elements)),
      active_id: this.active_id
    });

    const next = this.redo_stack.pop();
    this.state.elements = next.elements;
    this.active_id = next.active_id;

    this.render();
  }

  reorder_element(source_id, target_id, position = "before") {
    this.save_history();
    if (!source_id || !target_id || source_id === target_id) return;

    const source_info = this.find_element_info(source_id);
    const target_info = this.find_element_info(target_id);

    if (!source_info || !target_info) return;

    if (source_info.element.type === "container") {
      if (target_info.parent !== null || position === "inside") {
        return;
      }
    }

    if (this.find_element(target_id, source_info.element.children || [])) {
      return;
    }

    const [source] = source_info.list.splice(source_info.index, 1);

    if (position === "inside" && target_info.element.type === "container") {
      target_info.element.children = target_info.element.children || [];
      target_info.element.children.push(source);
    } else {
      let target_index = target_info.index;

      if (source_info.list === target_info.list && source_info.index < target_info.index) {
        target_index--;
      }

      if (position === "after") {
        target_index++;
      }

      target_info.list.splice(target_index, 0, source);
    }

    this.render();
  }

  move_element_up(id) {
    const info = this.find_element_info(id);
    if (!info || info.index <= 0) return;
    this.save_history();
    const [element] = info.list.splice(info.index, 1);
    info.list.splice(info.index - 1, 0, element);
    this.render();
  }

  move_element_down(id) {
    const info = this.find_element_info(id);
    if (!info || info.index >= info.list.length - 1) return;
    this.save_history();
    const [element] = info.list.splice(info.index, 1);
    info.list.splice(info.index + 1, 0, element);
    this.render();
  }

  duplicate_element(id) {
    const info = this.find_element_info(id);
    if (!info) return;
    this.save_history();

    const clone_element = (el) => {
      const cloned = JSON.parse(JSON.stringify(el));
      cloned.id = this.make_id();
      if (cloned.children) {
        cloned.children = cloned.children.map(child => clone_element(child));
      }
      return cloned;
    };

    const cloned = clone_element(info.element);
    info.list.splice(info.index + 1, 0, cloned);
    this.active_id = cloned.id;
    this.render();
  }

  select_parent_element(id) {
    const info = this.find_element_info(id);
    if (info && info.parent) {
      this.active_id = info.parent.id;
      this.render();
    }
  }
  
  clear_container(id) {
    const info = this.find_element_info(id);
    if (info && info.element.type === "container") {
      this.save_history();
      info.element.children = [];
      this.render();
    }
  }

  render() {
    this.render_canvas();
    this.render_props();
    this.render_history_buttons();
  }

  render_history_buttons() {
    const $undo = this.$root.find(".ptb-undo");
    const $redo = this.$root.find(".ptb-redo");

    if (this.undo_stack && this.undo_stack.length) {
      $undo.removeAttr("disabled").removeClass("disabled");
    } else {
      $undo.attr("disabled", "disabled").addClass("disabled");
    }

    if (this.redo_stack && this.redo_stack.length) {
      $redo.removeAttr("disabled").removeClass("disabled");
    } else {
      $redo.attr("disabled", "disabled").addClass("disabled");
    }
  }

  render_canvas() {
    const $paper = this.$root.find("#ptb-paper");

    $paper
      .removeClass("ptb-paper-58 ptb-paper-80")
      .addClass(`ptb-paper-${this.state.paper_size || "80"}`);

    this.$root.find("#ptb-paper-size").val(String(this.state.paper_size || "80"));

    if (!this.state.elements.length) {
      $paper.html(`<div class="ptb-empty">${__("Start by adding elements from the left panel")}</div>`);
      return;
    }

    const html = this.state.elements
      .map((element) => this.render_canvas_element(element))
      .join("");

    $paper.html(html);
  }

  render_canvas_element(element) {
    const active = element.id === this.active_id ? "ptb-active" : "";
    const body = this.render_preview_body(element);
    const info = this.find_element_info(element.id);
    const has_parent = info && info.parent !== null;

    return `
      <div class="ptb-canvas-element ${active}" data-id="${this.escape_attr(element.id)}" draggable="true">
        <div class="ptb-element-tools">
          ${has_parent ? `
            <button class="ptb-tool-btn ptb-select-parent" title="${this.escape_attr(__("Select Parent Container"))}" type="button">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M12 17V9"/><path d="M9 12l3-3 3 3"/></svg>
            </button>
          ` : ""}
          <button class="ptb-tool-btn ptb-move-up" title="${this.escape_attr(__("Move Up"))}" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="ptb-tool-btn ptb-move-down" title="${this.escape_attr(__("Move Down"))}" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="ptb-tool-btn ptb-duplicate" title="${this.escape_attr(__("Duplicate"))}" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="ptb-tool-btn ptb-delete" title="${this.escape_attr(__("Delete"))}" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
        ${body}
      </div>
    `;
  }

  get_preview_receipt_title() {
    const outputs = this.state.receipt_outputs || this.get_default_receipt_outputs();

    if (!outputs.enabled) {
      return __("Single Receipt");
    }

    if (outputs.customer && outputs.customer.enabled) {
      return outputs.customer.title || __("Customer Receipt");
    }

    if (outputs.waiter && outputs.waiter.enabled) {
      return outputs.waiter.title || __("Waiter Receipt");
    }

    if (outputs.item_group && outputs.item_group.enabled) {
      return `${outputs.item_group.title_prefix || __("Receipt for")} Food`;
    }

    return __("Receipt Title");
  }

  render_preview_body(element) {
    const style = this.get_preview_style(element);

    if (element.type === "text" || element.type === "footer_note") {
      return `<div class="ptb-receipt-text ptb-inline-edit" contenteditable="true" spellcheck="false" style="${style} outline:none;">${this.escape_html(element.content)}</div>`;
    }

    if (element.type === "receipt_title") {
      const title = element.use_receipt_context_title
        ? this.get_preview_receipt_title(element)
        : (element.custom_title || "Receipt Title");

      return `<div class="ptb-receipt-text ptb-inline-edit" contenteditable="true" spellcheck="false" data-prop="custom_title" style="${style} outline:none;">${this.escape_html(title)}</div>`;
    }

    if (element.type === "field") {
      const value = this.sample_doc[element.fieldname] ?? "";

      return `
        <div class="ptb-receipt-row" style="${style}">
          ${element.show_label ? `<span class="ptb-inline-edit" contenteditable="true" spellcheck="false" data-prop="label" style="outline:none;">${this.escape_html(element.label || element.fieldname)}</span>` : ""}
          <span>${this.escape_html(value)}</span>
        </div>
      `;
    }

    if (element.type === "image") {
      const src = element.source_type === "url" ? element.image_url : element.file_url;

      if (element.source_type === "company_logo") {
        if (this.state.company_logo) {
          return `
            <div style="text-align:${this.css_align(element.align)}; margin:${ptb_cint(element.margin_top)}px 0 ${ptb_cint(element.margin_bottom)}px;">
              <img class="ptb-image-preview" src="${this.escape_attr(this.state.company_logo)}" style="width:${ptb_cint(element.width)}mm;">
            </div>
          `;
        }

        return `
          <div class="ptb-receipt-text" style="
            ${style};
            font-size:${ptb_cint(element.font_size || 14)}px;
            font-weight:700;
          ">
            ${this.escape_html(this.state.company || this.sample_doc.company || __("Company"))}
          </div>
        `;
      }

      if (!src) {
        return `<div class="ptb-image-placeholder" style="${style}">${__("Image")}</div>`;
      }

      return `
        <div style="text-align:${this.css_align(element.align)}; margin:${ptb_cint(element.margin_top)}px 0 ${ptb_cint(element.margin_bottom)}px;">
          <img class="ptb-image-preview" src="${this.escape_attr(src)}" style="width:${ptb_cint(element.width)}mm;">
        </div>
      `;
    }

    if (element.type === "divider") {
      return `<div class="ptb-divider" style="border-top-style:${this.safe_line_style(element.line_style)};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${ptb_cint(element.height)}px;"></div>`;
    }

    if (element.type === "cutter") {
      return `
        <div class="ptb-cutter" style="display:flex; align-items:center; justify-content:center; border-top:1px dashed #d0d5dd; border-bottom:1px dashed #d0d5dd; padding:6px 0; color:#98a2b3; font-size:10px; gap:8px;">
          <span>✂</span>
          <span>${__("Printer Cut / Page Break")}</span>
          <span>✂</span>
        </div>
      `;
    }

    if (element.type === "container") {
      const child_html = (element.children || [])
        .map((child) => this.render_canvas_element(child))
        .join("");

      const container_style = [
        `border:${ptb_cint(element.border_width)}px ${this.safe_border_style(element.border_style)} ${this.safe_css_color(element.border_color, "#000000")}`,
        `border-radius:${ptb_cint(element.border_radius)}px`,
        `padding:${ptb_cint(element.padding)}px`,
        `background:${this.safe_css_color(element.background_color, "#ffffff")}`
      ].join(";");

      return `
        <div class="ptb-container-preview" style="${container_style}">
          ${child_html || `<div class="ptb-container-empty">${__("Add elements while this container is selected")}</div>`}
        </div>
      `;
    }

    if (element.type === "details_table") {
      return this.render_preview_details_table(element);
    }

    if (element.type === "items_table") {
      return this.render_preview_items_table(element);
    }

    if (element.type === "totals") {
      return this.render_preview_totals(element);
    }

    if (element.type === "payments") {
      return this.render_preview_payments(element);
    }

    if (element.type === "taxes") {
      return this.render_preview_taxes(element);
    }

    if (element.type === "qr_code" || element.type === "barcode") {
      const value = this.get_preview_code_value(element) || "123456";
      const validation_message = this.get_barcode_validation_message(element, value);

      if (validation_message) {
        return `
          <div style="text-align:${this.css_align(element.align)}; margin:${ptb_cint(element.margin_top)}px 0 ${ptb_cint(element.margin_bottom)}px;">
            <div class="ptb-code-warning">
              ${this.escape_html(validation_message)}
            </div>
          </div>
        `;
      }

      if (!element._preview_data_uri && !element._is_fetching_preview) {
        element._is_fetching_preview = true;

        const method = element.type === "qr_code"
          ? "pos_next.api.thermal_print.get_qr_data_uri"
          : "pos_next.api.thermal_print.get_barcode_data_uri";

        const args = { value: value };

        if (element.type === "barcode") {
          args.barcode_type = element.barcode_type || "code128";
        }

        frappe.call({
          method: method,
          args: args,
          callback: (r) => {
            element._is_fetching_preview = false;

            if (r.message) {
              element._preview_data_uri = r.message;
              this.render_canvas();
            } else {
              element._preview_data_uri = "";
              this.render_canvas();
            }
          },
          error: () => {
            element._is_fetching_preview = false;
            element._preview_data_uri = "";
            this.render_canvas();
          }
        });
      }

      if (element._preview_data_uri) {
        return `
          <div style="text-align:${this.css_align(element.align)}; margin:${ptb_cint(element.margin_top)}px 0 ${ptb_cint(element.margin_bottom)}px;">
            <img class="thermal-qr" src="${this.escape_attr(element._preview_data_uri)}" style="width:${ptb_cint(element.width)}mm; ${element.type === "barcode" ? "max-height:" + Math.max(8, Math.round(ptb_cint(element.width) / 2)) + "mm;" : ""}">
          </div>
        `;
      }

      const type_label = element.type === "qr_code" ? __("QR Code") : __("Barcode");

      return `
        <div style="text-align:${this.css_align(element.align)}; margin:${ptb_cint(element.margin_top)}px 0 ${ptb_cint(element.margin_bottom)}px;">
          <div class="ptb-qr-placeholder" style="width:${ptb_cint(element.width)}mm; min-height:${element.type === "qr_code" ? ptb_cint(element.width) : Math.max(8, Math.round(ptb_cint(element.width) / 2))}mm;">
            ${type_label}...
          </div>
        </div>
      `;
    }

    return "";
  }

  normalize_barcode_type(barcode_type) {
    return String(barcode_type || "code128")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  is_numeric_barcode_type(barcode_type) {
    const value = this.normalize_barcode_type(barcode_type);

    return [
      "ean",
      "ean8",
      "ean13",
      "upc",
      "upca",
      "isbn",
      "isbn10",
      "isbn13",
      "issn"
    ].includes(value);
  }

  get_barcode_validation_message(element, value) {
    if (!element || element.type !== "barcode") return "";

    const barcode_type = this.normalize_barcode_type(element.barcode_type || "code128");
    const raw_value = String(value || "");

    if (!this.is_numeric_barcode_type(barcode_type)) {
      return "";
    }

    if (!/^\d+$/.test(raw_value)) {
      return __("{0} accepts numbers only. Use Code 128 for invoice numbers.", [
        element.barcode_type || "EAN"
      ]);
    }

    if (barcode_type === "ean13" && ![12, 13].includes(raw_value.length)) {
      return __("EAN-13 requires 12 or 13 digits.");
    }

    if (barcode_type === "ean8" && ![7, 8].includes(raw_value.length)) {
      return __("EAN-8 requires 7 or 8 digits.");
    }

    if ((barcode_type === "upc" || barcode_type === "upca") && ![11, 12].includes(raw_value.length)) {
      return __("UPC-A requires 11 or 12 digits.");
    }

    return "";
  }

  get_preview_code_value(element) {
    if (element.content_type === "static_text") return element.static_value || "123456";
    if (element.content_type === "url") return element.url || "https://example.com";
    if (element.content_type === "document_field") return this.sample_doc[element.fieldname] || "123456";
    if (element.content_type === "multiple_fields") {
      const fields = element.fields || ["name"];
      return fields.map(f => this.sample_doc[f] || "").filter(Boolean).join(" | ") || "123456";
    }
    return "123456";
  }

  render_preview_details_table(element) {
    const rows = element.rows || [];
    const title = element.show_title
      ? `<tr><td colspan="2" class="ptb-inline-edit" contenteditable="true" spellcheck="false" data-prop="title" style="text-align:center;font-weight:700;background:${this.safe_css_color(element.header_bg_color, "#f2f0f0")};outline:none;">${this.escape_html(element.title || "")}</td></tr>`
      : "";

    const body = rows
      .map((row, idx) => {
        const value = this.sample_doc[row.fieldname] ?? "";

        return `
          <tr>
            <td class="ptb-inline-edit" contenteditable="true" spellcheck="false" data-row-idx="${idx}" style="font-weight:700;outline:none;">${this.escape_html(row.label)}</td>
            <td style="text-align:left;direction:ltr;">${this.escape_html(value)}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <table class="ptb-preview-table" style="
        font-size:${ptb_cint(element.font_size || 11)}px;
        border:${ptb_cint(element.border_width)}px ${this.safe_border_style(element.border_style)} ${this.safe_css_color(element.border_color, "#000000")};
        border-radius:${ptb_cint(element.border_radius)}px;
        border-collapse:separate;
        overflow:hidden;
      ">
        ${title}
        <tbody>${body}</tbody>
      </table>
    `;
  }

  render_preview_items_table(element) {
    this.ensure_items_table_metadata(element);

    const columns = element.columns || [];
    const labels = this.get_item_column_labels(element);

    const thead = element.show_header
      ? `
        <thead style="background:${this.safe_css_color(element.header_bg_color, "#f2f0f0")}; color:${this.safe_css_color(element.header_text_color, "#000000")}">
          <tr>
            ${columns.map((c) => `<th>${this.escape_html(labels[c] || c)}</th>`).join("")}
          </tr>
        </thead>
      `
      : "";

    const rows = this.sample_doc.items
      .map((row) => {
        const main_row = `<tr>${columns.map((c) => `<td>${this.escape_html(this.get_sample_item_value(row, c, element))}</td>`).join("")}</tr>`;

        if (element.extra_row && element.extra_row.enabled && element.extra_row.fieldname && row[element.extra_row.fieldname]) {
          return `
            ${main_row}
            <tr>
              <td colspan="${columns.length || 1}">${this.escape_html(element.extra_row.prefix || "")}${this.escape_html(row[element.extra_row.fieldname])}</td>
            </tr>
          `;
        }

        return main_row;
      })
      .join("");

    return `
      <table class="ptb-preview-table" style="font-size:${ptb_cint(element.font_size)}px;">
        ${thead}
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  render_preview_totals(element) {
    const rows = [];

    if (element.show_net_total) rows.push(["Net Total", this.sample_doc.net_total]);
    if (element.show_taxes) rows.push(["Taxes and Charges", this.sample_doc.total_taxes_and_charges]);
    if (element.show_grand_total) rows.push(["Grand Total", this.sample_doc.grand_total]);
    if (element.show_paid_amount) rows.push(["Paid Amount", this.sample_doc.paid_amount]);
    if (element.show_change_amount) rows.push(["Change Amount", this.sample_doc.change_amount]);

    return rows
      .map(([label, value]) => `
        <div class="ptb-receipt-row" style="font-size:${ptb_cint(element.font_size)}px;">
          <span>${this.escape_html(label)}</span>
          <span>${this.format_money(value)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");
  }

  render_preview_payments(element) {
    const title = element.title !== undefined ? element.title : __("Payments");
    const header = element.show_header
      ? `<div class="ptb-receipt-text ptb-inline-edit" contenteditable="true" spellcheck="false" data-prop="title" style="font-weight:700;outline:none;">${this.escape_html(title)}</div>`
      : "";

    const rows = this.sample_doc.payments
      .map((row) => `
        <div class="ptb-receipt-row" style="font-size:${ptb_cint(element.font_size)}px;">
          <span>${this.escape_html(row.mode_of_payment)}</span>
          <span>${this.format_money(row.amount)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");

    return header + rows;
  }

  render_preview_taxes(element) {
    const title = element.title !== undefined ? element.title : __("Taxes and Charges");
    const header = element.show_header
      ? `<div class="ptb-receipt-text ptb-inline-edit" contenteditable="true" spellcheck="false" data-prop="title" style="font-weight:700;outline:none;">${this.escape_html(title)}</div>`
      : "";

    const rows = this.sample_doc.taxes
      .map((row) => `
        <div class="ptb-receipt-row" style="font-size:${ptb_cint(element.font_size)}px;">
          <span>${this.escape_html(row.description)}</span>
          <span>${this.format_money(row.tax_amount)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");

    return header + rows;
  }

  get_sample_item_value(row, column, element) {
    const fieldname = this.safe_fieldname(column);

    if (!fieldname) return "";

    if (fieldname === "amount" && element.amount_mode === "price_list_rate_times_qty") {
      return ptb_flt(row.price_list_rate) * ptb_flt(row.qty);
    }

    return row[fieldname] ?? "";
  }

  get_preview_style(element) {
    return [
      `text-align:${this.css_align(element.align)}`,
      `font-size:${ptb_cint(element.font_size)}px`,
      `font-weight:${element.bold ? "700" : "400"}`,
      `margin-top:${ptb_cint(element.margin_top)}px`,
      `margin-bottom:${ptb_cint(element.margin_bottom)}px`
    ].join(";");
  }

  render_props() {
    const element = this.find_element(this.active_id);
    const $form = this.$root.find("#ptb-props");
    const $empty = this.$root.find("#ptb-props-empty");

    if (!element) {
      $empty.hide();
      $form.show();
      $form.html(this.render_receipt_outputs_props());
      return;
    }

    $empty.hide();
    $form.show();
    $form.html(this.get_props_html(element));
  }

  get_props_html(element) {
    let html = `
      <div class="ptb-section-label">${__("General Settings")}</div>
      ${this.select("align", __("Alignment"), element.align, [
      ["right", __("Right")],
      ["center", __("Center")],
      ["left", __("Left")]
    ])}
      ${this.number("font_size", __("Font Size"), element.font_size)}
      ${this.number("margin_top", __("Top Margin"), element.margin_top)}
      ${this.number("margin_bottom", __("Bottom Margin"), element.margin_bottom)}
      ${this.checkbox("bold", __("Bold"), element.bold)}
      ${this.visible_in_html(element)}
    `;

    if (element.type === "text" || element.type === "footer_note") {
      html += `
        <div class="ptb-section-label">${__("Text Properties")}</div>
        ${this.textarea("content", __("Text"), element.content)}
      `;
    }

    if (element.type === "receipt_title") {
      html += `
        <div class="ptb-section-label">${__("Receipt Title Properties")}</div>
        ${this.checkbox("use_receipt_context_title", __("Use Receipt Output Title"), element.use_receipt_context_title)}
        ${this.depends(!element.use_receipt_context_title, `
          ${this.input("custom_title", __("Custom Title"), element.custom_title || "")}
        `)}
        <div class="ptb-help">${__("When multiple receipts are enabled, this element prints the title of the current receipt output.")}</div>
      `;
    }

    if (element.type === "field") {
      html += `
        <div class="ptb-section-label">${__("Field Properties")}</div>
        ${this.select("fieldname", __("Field"), element.fieldname, this.get_field_options(this.invoice_fields))}
        ${this.input("label", __("Field Label"), element.label)}
        ${this.checkbox("show_label", __("Show Field Label"), element.show_label)}
        ${this.checkbox("translate_label", __("Translate Label"), element.translate_label)}
      `;
    }

    if (element.type === "image") {
      html += `
        <div class="ptb-section-label">${__("Image Properties")}</div>
        ${this.select("source_type", __("Image Source Type"), element.source_type, [
        ["company_logo", __("Company Logo")],
        ["url", __("URL")],
        ["attach", __("Attach")]
      ])}

        ${this.depends(element.source_type === "url", `
          ${this.input("image_url", __("Image URL"), element.image_url || "")}
        `)}

        ${this.depends(element.source_type === "attach", `
          ${this.input("file_url", __("Attached File URL"), element.file_url || "")}
          <div class="ptb-prop-actions">
            <button class="btn btn-default btn-sm" id="ptb-upload-image" type="button">${__("Upload Image")}</button>
          </div>
        `)}

        ${this.number("width", __("Width in mm"), element.width)}
      `;
    }

    if (element.type === "container") {
      html += `
        <div class="ptb-section-label">${__("Container Properties")}</div>
        ${this.number("border_width", __("Border Width"), element.border_width)}
        ${this.select("border_style", __("Border Style"), element.border_style, [
        ["solid", __("Solid")],
        ["dashed", __("Dashed")],
        ["dotted", __("Dotted")]
      ])}
        ${this.color("border_color", __("Border Color"), element.border_color)}
        ${this.number("border_radius", __("Border Radius"), element.border_radius)}
        ${this.number("padding", __("Padding"), element.padding)}
        ${this.color("background_color", __("Background Color"), element.background_color)}
        <div class="ptb-prop-actions">
          <button class="btn btn-default btn-sm" id="ptb-add-field-to-container" type="button">${__("Add Field to Container")}</button>
          <button class="btn btn-danger btn-sm" id="ptb-clear-container" type="button" style="margin-top: 5px;">${__("Clear Container")}</button>
        </div>
      `;
    }

    if (element.type === "details_table") {
      html += `
        <div class="ptb-section-label">${__("Details Table Properties")}</div>
        ${this.checkbox("show_title", __("Show Title"), element.show_title)}
        ${this.depends(element.show_title, `
          ${this.input("title", __("Title"), element.title)}
        `)}
        ${this.number("border_width", __("Border Width"), element.border_width)}
        ${this.select("border_style", __("Border Style"), element.border_style, [
        ["solid", __("Solid")],
        ["dashed", __("Dashed")],
        ["dotted", __("Dotted")]
      ])}
        ${this.color("border_color", __("Border Color"), element.border_color)}
        ${this.number("border_radius", __("Border Radius"), element.border_radius)}
        ${this.color("header_bg_color", __("Header Background Color"), element.header_bg_color)}
        ${this.number("padding", __("Padding"), element.padding)}
        ${this.textarea("rows_text", __("Rows"), element.rows_text || this.details_rows_to_text(element.rows || []))}
        <div class="ptb-help">${__("Use one row per line in this format: Label|fieldname")}</div>
      `;
    }

    if (element.type === "divider") {
      html += `
        <div class="ptb-section-label">${__("Divider Properties")}</div>
        ${this.select("line_style", __("Line Style"), element.line_style || "dashed", [
        ["solid", __("Solid")],
        ["dashed", __("Dashed")],
        ["dotted", __("Dotted")]
      ])}
      `;
    }

    if (element.type === "spacer") {
      html += `
        <div class="ptb-section-label">${__("Spacer Properties")}</div>
        ${this.number("height", __("Height in px"), element.height)}
      `;
    }

    if (element.type === "cutter") {
      html += `
        <div class="ptb-section-label">${__("Cutter Properties")}</div>
        <div style="font-size: 11px; color: #667085; padding: 4px 0 12px;">${__("This element forces a page break / cut command on supporting thermal printers.")}</div>
      `;
    }

    if (element.type === "items_table") {
      html += this.get_items_table_props_html(element);
    }

    if (element.type === "totals") {
      html += `
        <div class="ptb-section-label">${__("Totals Rows")}</div>
        ${this.checkbox("show_net_total", __("Show Net Total"), element.show_net_total)}
        ${this.checkbox("show_taxes", __("Show Taxes and Charges"), element.show_taxes)}
        ${this.checkbox("show_grand_total", __("Show Grand Total"), element.show_grand_total)}
        ${this.checkbox("show_paid_amount", __("Show Paid Amount"), element.show_paid_amount)}
        ${this.checkbox("show_change_amount", __("Show Change Amount"), element.show_change_amount)}
      `;
    }

    if (element.type === "payments") {
      html += `
        <div class="ptb-section-label">${__("Display Settings")}</div>
        ${this.checkbox("show_header", __("Show Header"), element.show_header)}
        ${this.depends(element.show_header, `
          ${this.input("title", __("Header Title"), element.title !== undefined ? element.title : __("Payments"))}
        `)}
      `;
    }

    if (element.type === "taxes") {
      html += `
        <div class="ptb-section-label">${__("Display Settings")}</div>
        ${this.checkbox("show_header", __("Show Header"), element.show_header)}
        ${this.depends(element.show_header, `
          ${this.input("title", __("Header Title"), element.title !== undefined ? element.title : __("Taxes and Charges"))}
        `)}
      `;
    }

    if (element.type === "qr_code" || element.type === "barcode") {
      const label = element.type === "qr_code" ? __("QR Code Properties") : __("Barcode Properties");
      html += `
        <div class="ptb-section-label">${label}</div>
        ${this.select("content_type", __("Content Type"), element.content_type, [
        ["static_text", __("Static Text")],
        ["url", __("URL")],
        ["document_field", __("Document Field")],
        ["multiple_fields", __("Multiple Fields")],
        ["custom_jinja", __("Custom Jinja")]
      ])}

        ${this.depends(element.content_type === "static_text", `
          ${this.textarea("static_value", __("Static Value"), element.static_value || "")}
        `)}

        ${this.depends(element.content_type === "url", `
          ${this.input("url", __("URL"), element.url || "")}
        `)}

        ${this.depends(element.content_type === "document_field", `
          ${this.select("fieldname", __("Field"), element.fieldname, this.get_field_options(this.invoice_fields))}
        `)}

        ${this.depends(element.content_type === "multiple_fields", `
          ${this.input("fields", __("Multiple Fields"), (element.fields || []).join(", "))}
        `)}

        ${this.depends(element.content_type === "custom_jinja", `
          ${this.textarea("custom_jinja", __("Custom Jinja Expression"), element.custom_jinja || "doc.name")}
        `)}
        
        ${this.depends(element.type === "barcode", `
          ${this.select("barcode_type", __("Barcode Type"), element.barcode_type || "code128", [
            ["code128", "Code 128"],
            ["code39", "Code 39"],
            ["ean13", "EAN-13"]
          ])}
        `)}

        ${this.number("width", __("Width in mm"), element.width)}
      `;
    }

    html += `
      <div class="ptb-section-label" style="margin-top: 15px; border-top: 1px solid var(--border-color); padding-top: 10px;">${__("Actions")}</div>
      <button class="btn btn-default btn-sm w-100" id="ptb-duplicate-active" type="button">${__("Duplicate Element")}</button>
    `;

    return html;
  }

  get_items_table_props_html(element) {
    this.ensure_items_table_metadata(element);

    const table_options = this.get_table_field_options();
    const child_fields = this.get_child_fields_for_table(element);

    return `
      <div class="ptb-section-label">${__("Items Table Settings")}</div>
      ${this.select("table_fieldname", __("Items Table Field"), element.table_fieldname || "items", table_options.length ? table_options : [["items", "Items (items)"]])}
      <div class="ptb-help">${__("The available columns below are loaded from the selected child table according to the selected Invoice DocType.")}</div>

      ${this.checkbox("show_header", __("Show Table Header"), element.show_header)}

      <div class="ptb-section-label">${__("Table Header Style")}</div>
      ${this.color("header_bg_color", __("Header Background Color"), element.header_bg_color)}
      ${this.color("header_text_color", __("Header Text Color"), element.header_text_color)}
      ${this.color("header_border_color", __("Header Border Color"), element.header_border_color)}

      <div class="ptb-section-label">${__("Items Table Columns")}</div>
      ${this.item_columns_html(element)}

      <div class="ptb-section-label">${__("Extra Row")}</div>
      ${this.checkbox("extra_row.enabled", __("Show Extra Row Under Item"), element.extra_row?.enabled)}
      ${this.depends(element.extra_row?.enabled, `
        ${this.select("extra_row.fieldname", __("Extra Row Field"), element.extra_row?.fieldname || "", this.get_extra_row_field_options(element))}
        ${this.input("extra_row.prefix", __("Extra Row Prefix"), element.extra_row?.prefix || "#")}
      `)}

      ${this.depends(!child_fields.length, `
        <div class="ptb-help">${__("No child table fields were loaded. Save and refresh if this is a newly customized child table.")}</div>
      `)}
    `;
  }

  input(prop, label, value) {
    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <input type="text" data-prop="${this.escape_attr(prop)}" value="${this.escape_attr(value ?? "")}">
      </div>
    `;
  }

  textarea(prop, label, value) {
    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <textarea data-prop="${this.escape_attr(prop)}">${this.escape_html(value ?? "")}</textarea>
      </div>
    `;
  }

  number(prop, label, value) {
    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <input type="number" data-prop="${this.escape_attr(prop)}" value="${this.escape_attr(value ?? 0)}">
      </div>
    `;
  }

  checkbox(prop, label, value) {
    return `
      <label class="ptb-check">
        <input type="checkbox" data-prop="${this.escape_attr(prop)}" ${value ? "checked" : ""}>
        <span>${this.escape_html(label)}</span>
      </label>
    `;
  }

  color(prop, label, value) {
    const safe_value = this.safe_css_color(value, "#000000");

    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <div class="ptb-color-row">
          <input type="color" data-prop="${this.escape_attr(prop)}" value="${this.escape_attr(safe_value)}">
          <input type="text" data-prop="${this.escape_attr(prop)}" value="${this.escape_attr(safe_value)}">
        </div>
      </div>
    `;
  }

  select(prop, label, value, options) {
    return `
      <div class="ptb-field">
        <label>${this.escape_html(label)}</label>
        <select data-prop="${this.escape_attr(prop)}">
          ${options
        .map(([val, text]) => `
              <option value="${this.escape_attr(val)}" ${String(val) === String(value) ? "selected" : ""}>
                ${this.escape_html(text)}
              </option>
            `)
        .join("")}
        </select>
      </div>
    `;
  }

  item_columns_html(element) {
    this.ensure_items_table_metadata(element);

    const fields = this.get_child_fields_for_table(element);
    const selected = element.columns || [];

    if (!fields.length) {
      return `<div class="ptb-help">${__("No fields available for the selected table.")}</div>`;
    }

    return fields
      .filter((field) => field.fieldname)
      .map((field) => {
        let label = `${field.label || field.fieldname} (${field.fieldname})`;

        if (field.hidden) {
          label += ` [${__("Hidden")}]`;
        }

        if (field.is_custom) {
          label += ` [${__("Custom")}]`;
        }

        return `
          <label class="ptb-check">
            <input type="checkbox" data-column="${this.escape_attr(field.fieldname)}" ${selected.includes(field.fieldname) ? "checked" : ""}>
            <span>${this.escape_html(label)}</span>
          </label>
        `;
      })
      .join("");
  }

  get_field_options(fields) {
    const system = [];
    const standard = [];
    const custom = [];
    const seen = new Set();

    (fields || []).forEach((field) => {
      if (!field || !field.fieldname || seen.has(field.fieldname)) return;
      seen.add(field.fieldname);

      let label = `${field.label || field.fieldname} (${field.fieldname})`;

      if (field.hidden) {
        label += ` [${__("Hidden")}]`;
      }

      if (field.is_system) {
        system.push([field.fieldname, label]);
      } else if (field.is_custom) {
        custom.push([field.fieldname, `${label} [${__("Custom")}]`]);
      } else {
        standard.push([field.fieldname, label]);
      }
    });

    return [...system, ...standard, ...custom];
  }

  get_item_column_labels(element = null) {
    const labels = {};
    const fields = element ? this.get_child_fields_for_table(element) : [];

    fields.forEach((field) => {
      labels[field.fieldname] = field.label || field.fieldname;
    });

    return Object.assign(
      {
        item_code: "Item Code",
        item_name: "Item Name",
        description: "Description",
        qty: "Quantity",
        uom: "UOM",
        rate: "Rate",
        price_list_rate: "Price List Rate",
        amount: "Amount"
      },
      labels
    );
  }

  details_rows_to_text(rows) {
    return (rows || [])
      .map((row) => `${row.label || ""}|${row.fieldname || ""}`)
      .join("\n");
  }

  parse_details_rows(text) {
    return String(text || "")
      .split("\n")
      .map((line) => {
        const parts = line.split("|");

        return {
          label: (parts[0] || "").trim(),
          fieldname: (parts[1] || "").trim(),
          translate_label: true
        };
      })
      .filter((row) => row.label && row.fieldname);
  }

  update_receipt_output_from_input(input) {
    const $input = $(input);
    const prop = $input.data("output-prop");

    let value;

    if ($input.attr("type") === "checkbox") {
      value = $input.is(":checked") ? 1 : 0;
    } else {
      value = $input.val();
    }

    const current_value = this.get_receipt_output_value(prop);
    if (current_value === value) return;

    this.set_receipt_output_value(prop, value);
    this.render();
  }

  update_visible_in_from_input(input) {
    const element = this.find_element(this.active_id);
    if (!element) return;

    const context = $(input).data("visible-context");
    if (!context) return;

    element.visible_in = Array.isArray(element.visible_in)
      ? element.visible_in
      : this.get_default_visible_in(element.type);

    if ($(input).is(":checked")) {
      if (!element.visible_in.includes(context)) {
        element.visible_in.push(context);
      }
    } else {
      element.visible_in = element.visible_in.filter((value) => value !== context);
    }

    this.schedule_canvas_render();
  }

  update_active_from_input(input) {
    const element = this.find_element(this.active_id);
    if (!element) return;

    const $input = $(input);
    const prop = $input.data("prop");

    let value;

    if ($input.attr("type") === "checkbox") {
      value = $input.is(":checked") ? 1 : 0;
    } else if ($input.attr("type") === "number") {
      value = ptb_flt($input.val());
    } else {
      value = $input.val();
    }

    if (prop === "fields") {
      value = String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }

    const current_value = this.get_nested_value(element, prop);
    const is_same = Array.isArray(value) && Array.isArray(current_value)
      ? JSON.stringify(value) === JSON.stringify(current_value)
      : value === current_value;

    if (is_same) return;

    this.set_nested_value(element, prop, value);

    if (element.type === "details_table" && prop === "rows_text") {
      element.rows = this.parse_details_rows(value);
    }

    if (element.type === "field" && prop === "fieldname") {
      const field = this.invoice_fields.find((f) => f.fieldname === value);
      if (field) {
        element.label = field.label || value;
      }
    }

    if (element.type === "items_table" && prop === "table_fieldname") {
      element.child_doctype = this.get_child_doctype_for_table_field(value);
      element.columns = this.get_default_item_columns_for_field(value);
      element.extra_row = Object.assign({ enabled: false, fieldname: "", prefix: "#" }, element.extra_row || {}, { fieldname: "" });
    }

    if (element.type === "qr_code" || element.type === "barcode") {
      const code_props = ["content_type", "static_value", "url", "fieldname", "fields", "custom_jinja", "barcode_type"];
      if (code_props.includes(prop)) {
        element._preview_data_uri = "";
        element._is_fetching_preview = false;
      }
    }

    if ($input.closest(".ptb-color-row").length) {
      $input.siblings("input").val(value);
    }

    const should_rerender_props =
      $input.attr("type") === "checkbox" ||
      input.tagName === "SELECT" ||
      prop.includes("extra_row.") ||
      ["table_fieldname", "source_type", "content_type", "show_title", "use_receipt_context_title"].includes(prop);

    if (should_rerender_props) {
      this.render();
    } else {
      this.schedule_canvas_render();
    }
  }

  get_nested_value(object, path) {
    const parts = String(path).split(".");
    let current = object;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }

    return current;
  }

  set_nested_value(object, path, value) {
    const parts = String(path).split(".");
    let current = object;

    while (parts.length > 1) {
      const part = parts.shift();
      current[part] = current[part] || {};
      current = current[part];
    }

    current[parts[0]] = value;
  }

  update_table_columns(input) {
    const element = this.find_element(this.active_id);

    if (!element || element.type !== "items_table") return;

    const fieldname = $(input).data("column");
    const checked = $(input).is(":checked");

    element.columns = element.columns || [];
    const has_column = element.columns.includes(fieldname);

    if (checked === has_column) return;

    if (checked) {
      element.columns.push(fieldname);
    } else {
      element.columns = element.columns.filter((c) => c !== fieldname);
    }

    this.render_canvas();
  }

  upload_image_for_active_element() {
    const element = this.find_element(this.active_id);

    if (!element || element.type !== "image") return;

    new frappe.ui.FileUploader({
      allow_multiple: false,
      restrictions: {
        allowed_file_types: ["image/*"]
      },
      on_success: (file) => {
        element.source_type = "attach";
        element.file_url = file.file_url;
        this.render();
      }
    });
  }

  generate_print_format_html() {
    const paper = this.state.paper_size || "80";
    const outputs = this.state.receipt_outputs || this.get_default_receipt_outputs();

    const body = outputs.enabled
      ? this.render_print_receipt_outputs(outputs)
      : `<div class="thermal-receipt">${this.render_print_elements(this.state.elements, "doc.items", { mode: "single", receipt_title: __("Single Receipt") })}</div>`;

    return `
<style>
@page {
  size: ${paper}mm auto;
  margin: 0;
}

.print-format {
  padding: 0 !important;
  margin: 0 !important;
}

.thermal-receipt {
  width: ${paper}mm;
  padding: 2mm;
  color: #000;
  font-family: Tahoma, Arial, sans-serif;
  font-size: 11px;
  line-height: 1.35;
  direction: rtl;
}

.thermal-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.thermal-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.thermal-row span:last-child {
  text-align: left;
  direction: ltr;
}

.thermal-table {
  width: 100%;
  border-collapse: collapse;
}

.thermal-table th,
.thermal-table td {
  border-bottom: 1px solid #777;
  padding: 3px 2px;
  vertical-align: top;
}

.thermal-table td:last-child,
.thermal-table th:last-child {
  text-align: left;
  direction: ltr;
}

.thermal-divider {
  border-top: 1px dashed #000;
  height: 1px;
  margin: 6px 0;
}

.thermal-logo {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}

.thermal-box {
  border-collapse: separate;
  border-spacing: 0;
}

.thermal-qr {
  display: inline-block;
}

.page-break {
  page-break-after: always;
  break-after: page;
}

@media print {
  body {
    margin: 0;
    padding: 0;
  }
}
</style>

${body}
`.trim();
  }

  render_print_receipt_outputs(outputs) {
    const add_page_break = outputs.page_break_between_receipts ? "true" : "false";

    const customer_receipt = outputs.customer && outputs.customer.enabled
      ? `
{% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
{% set ptb.has_previous = true %}
<div class="thermal-receipt">
  ${this.render_print_elements(this.state.elements, "doc.items", {
        mode: "customer",
        receipt_title: outputs.customer.title || "Customer Receipt"
      })}
</div>`
      : "";

    const waiter_receipt = outputs.waiter && outputs.waiter.enabled
      ? `
{% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
{% set ptb.has_previous = true %}
<div class="thermal-receipt">
  ${this.render_print_elements(this.state.elements, "doc.items", {
        mode: "waiter",
        receipt_title: outputs.waiter.title || "Waiter Receipt"
      })}
</div>`
      : "";

    const group_by = this.safe_fieldname(outputs.item_group && outputs.item_group.group_by ? outputs.item_group.group_by : "item_group");
    const group_prefix = outputs.item_group && outputs.item_group.title_prefix ? outputs.item_group.title_prefix : "Receipt for";

    const item_group_receipts = outputs.item_group && outputs.item_group.enabled
      ? `
{% set item_groups = {} %}
{% for item in doc.items %}
  {% set group_name = item.get("${group_by}") or _("No Item Group") %}
  {% if group_name not in item_groups %}
    {% set _ = item_groups.update({group_name: []}) %}
  {% endif %}
  {% set _ = item_groups[group_name].append(item) %}
{% endfor %}

{% for group_name, group_items in item_groups.items() %}
  {% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
  {% set ptb.has_previous = true %}
  <div class="thermal-receipt">
    ${this.render_print_elements(this.state.elements, "group_items", {
        mode: "item_group",
        receipt_title: `${group_prefix} {{ group_name }}`
      })}
  </div>
{% endfor %}`
      : "";

    return `
{% set ptb = namespace(has_previous=false) %}
${customer_receipt}
${waiter_receipt}
${item_group_receipts}
`.trim();
  }

  render_split_receipt_title(title, raw = false) {
    if (!title) return "";

    const title_html = raw
      ? title
      : `{{ _("${this.escape_jinja_string(title)}") }}`;

    return `
<div class="thermal-text" style="text-align:center;font-size:14px;font-weight:700;margin-bottom:6px;">
  ${title_html}
</div>`.trim();
  }

  render_print_elements(elements, item_source, context) {
    const mode = context && context.mode ? context.mode : "single";

    return (elements || [])
      .filter((element) => {
        const visible_in = Array.isArray(element.visible_in)
          ? element.visible_in
          : this.get_default_visible_in(element.type);

        return visible_in.includes(mode);
      })
      .map((element) => this.render_print_element(element, item_source, context || {}))
      .join("\n");
  }

  render_print_element(element, item_source, context) {
    const style = this.get_print_style(element);

    if (element.type === "text" || element.type === "footer_note") {
      return `<div class="thermal-text" style="${style}">${this.escape_html(element.content || "")}</div>`;
    }

    if (element.type === "receipt_title") {
      const title = element.use_receipt_context_title
        ? (context.receipt_title || "")
        : (element.custom_title || "");

      if (!title) return "";

      const title_html = title.includes("{{")
        ? title
        : this.render_label(title, element.translate_label !== false);

      return `<div class="thermal-text" style="${style}">${title_html}</div>`;
    }

    if (element.type === "field") {
      const fieldname = this.safe_fieldname(element.fieldname || "");
      if (!fieldname) return "";

      const label_html = this.render_label(element.label || fieldname, element.translate_label);

      return `
<div class="thermal-row" style="${style}">
  ${element.show_label ? `<span>${label_html}</span>` : ""}
  <span>{{ ${this.doc_value_jinja(fieldname)} }}</span>
</div>`.trim();
    }

    if (element.type === "image") {
      return this.render_print_image(element);
    }

    if (element.type === "divider") {
      return `<div class="thermal-divider" style="border-top-style:${this.safe_line_style(element.line_style)};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${ptb_cint(element.height)}px;"></div>`;
    }

    if (element.type === "cutter") {
      return `<div class="page-break"></div>`;
    }

    if (element.type === "container") {
      const child_html = this.render_print_elements(element.children || [], item_source, context);
      const container_style = [
        `border:${ptb_cint(element.border_width)}px ${this.safe_border_style(element.border_style)} ${this.safe_css_color(element.border_color, "#000000")}`,
        `border-radius:${ptb_cint(element.border_radius)}px`,
        `padding:${ptb_cint(element.padding)}px`,
        `background:${this.safe_css_color(element.background_color, "#ffffff")}`,
        `margin-top:${ptb_cint(element.margin_top)}px`,
        `margin-bottom:${ptb_cint(element.margin_bottom)}px`
      ].join(";");

      return `<div class="thermal-box" style="${container_style}">${child_html}</div>`;
    }

    if (element.type === "details_table") {
      return this.render_print_details_table(element);
    }

    if (element.type === "items_table") {
      return this.render_print_items_table(element, item_source);
    }

    if (element.type === "totals") {
      return this.render_print_totals(element, item_source);
    }

    if (element.type === "payments") {
      return this.render_print_payments(element);
    }

    if (element.type === "taxes") {
      return this.render_print_taxes(element);
    }

    if (element.type === "qr_code" || element.type === "barcode") {
      return this.render_print_qr_code(element);
    }

    return "";
  }

  render_print_details_table(element) {
    const rows = (element.rows || []).filter((row) => this.safe_fieldname(row.fieldname));
    const title = element.show_title
      ? `
      <tr>
        <td colspan="2" style="text-align:center;font-weight:700;background:${this.safe_css_color(element.header_bg_color, "#f2f0f0")};">
          ${this.escape_html(element.title || "")}
        </td>
      </tr>`
      : "";

    const body = rows
      .map((row) => {
        const fieldname = this.safe_fieldname(row.fieldname);
        const label = this.render_label(row.label, row.translate_label);

        return `
        <tr>
          <td style="font-weight:700;">${label}</td>
          <td style="text-align:left;direction:ltr;">{{ ${this.doc_value_jinja(fieldname, true)} }}</td>
        </tr>
      `;
      })
      .join("");

    if (!title && !body) return "";

    return `
<table class="thermal-table" style="
  font-size:${ptb_cint(element.font_size || 11)}px;
  border:${ptb_cint(element.border_width)}px ${this.safe_border_style(element.border_style)} ${this.safe_css_color(element.border_color, "#000000")};
  border-radius:${ptb_cint(element.border_radius)}px;
  border-collapse:separate;
  overflow:hidden;
  margin-top:${ptb_cint(element.margin_top)}px;
  margin-bottom:${ptb_cint(element.margin_bottom)}px;
">
  ${title}
  <tbody>${body}</tbody>
</table>`.trim();
  }

  render_print_image(element) {
    const width = ptb_cint(element.width || 23);
    const align = this.css_align(element.align);
    const margin_top = ptb_cint(element.margin_top);
    const margin_bottom = ptb_cint(element.margin_bottom);
    const font_size = ptb_cint(element.font_size || 14);

    if (element.source_type === "company_logo") {
      return `
{% set company_logo = frappe.db.get_value("Company", doc.company, "company_logo") if doc.company else "" %}
{% if company_logo %}
<div style="text-align:${align}; margin:${margin_top}px 0 ${margin_bottom}px;">
  <img class="thermal-logo" src="{{ company_logo }}" style="width:${width}mm;">
</div>
{% else %}
<div class="thermal-text" style="text-align:${align};font-size:${font_size}px;font-weight:700;margin:${margin_top}px 0 ${margin_bottom}px;">
  {{ doc.company or "" }}
</div>
{% endif %}`.trim();
    }

    const src = element.source_type === "url" ? element.image_url : element.file_url;

    if (!src) return "";

    return `
<div style="text-align:${align}; margin:${margin_top}px 0 ${margin_bottom}px;">
  <img class="thermal-logo" src="${this.escape_attr(src)}" style="width:${width}mm;">
</div>`.trim();
  }

  render_print_items_table(element, item_source) {
    this.ensure_items_table_metadata(element);

    const labels = this.get_item_column_labels(element);
    const columns = (element.columns || [])
      .map((column) => this.safe_fieldname(column))
      .filter(Boolean);

    if (!columns.length) return "";

    const table_fieldname = this.safe_fieldname(element.table_fieldname || "items");
    const source = item_source === "group_items" ? "group_items" : `(doc.get("${table_fieldname}") or [])`;
    const font_size = ptb_cint(element.font_size || 10);
    const header_bg = this.safe_css_color(element.header_bg_color, "#f2f0f0");
    const header_text = this.safe_css_color(element.header_text_color, "#000000");
    const header_border = this.safe_css_color(element.header_border_color, "#000000");

    const header = element.show_header
      ? `
<thead style="background-color:${header_bg}; color:${header_text};">
  <tr>
    ${columns.map((c) => `<th style="border-color:${header_border};">${this.render_label(labels[c] || c, true)}</th>`).join("\n    ")}
  </tr>
</thead>`
      : "";

    const cells = columns
      .map((c) => `<td>${this.get_item_cell_jinja(c, element)}</td>`)
      .join("\n      ");

    const extra_row_field = element.extra_row && element.extra_row.enabled
      ? this.safe_fieldname(element.extra_row.fieldname)
      : "";

    const extra_row = extra_row_field
      ? `
      {% if row.get("${extra_row_field}") %}
      <tr>
        <td colspan="${columns.length || 1}">${this.escape_html(element.extra_row.prefix || "")}{{ row.get("${extra_row_field}") }}</td>
      </tr>
      {% endif %}`
      : "";

    return `
<table class="thermal-table" style="font-size:${font_size}px;">
  ${header}
  <tbody>
    {% for row in ${source} %}
    <tr>
      ${cells}
    </tr>
    ${extra_row}
    {% endfor %}
  </tbody>
</table>`.trim();
  }

  get_item_cell_jinja(column, element) {
    const fieldname = this.safe_fieldname(column);

    if (!fieldname) return "";

    if (fieldname === "rate") {
      const rate_field = element.rate_field === "price_list_rate" ? "price_list_rate" : "rate";
      return `{{ "{:,.1f}".format(row.get("${rate_field}") or 0) if row.get("${rate_field}") else "-" }}`;
    }

    if (fieldname === "amount") {
      if (element.amount_mode === "price_list_rate_times_qty") {
        return `{{ "{:,.1f}".format((row.get("price_list_rate") or 0) * (row.get("qty") or 0)) }}`;
      }

      return `{{ "{:,.1f}".format(row.get("amount") or 0) if row.get("amount") else "-" }}`;
    }

    if (fieldname === "qty") {
      return `{{ "{:,.1f}".format(row.get("qty") or 0) if row.get("qty") else "-" }}`;
    }

    return `{{ ${this.row_value_jinja(fieldname)} }}`;
  }

  render_print_totals(element, item_source) {
    const font_size = ptb_cint(element.font_size || 11);

    if (item_source === "group_items") {
      return `
{% set ns = namespace(total=0) %}
{% for row in group_items %}
  {% set ns.total = ns.total + ((row.get("price_list_rate") or row.get("rate") or 0) * (row.get("qty") or 0)) %}
{% endfor %}
<div class="thermal-row" style="font-size:${font_size}px; font-weight:700;">
  <span>{{ _("Total") }}</span>
  <span>{{ "{:,.0f}".format(ns.total) }}</span>
</div>`.trim();
    }

    const rows = [];

    if (element.show_net_total) rows.push(["Net Total", `{{ ${this.doc_value_jinja("net_total", true)} }}`]);
    if (element.show_taxes) rows.push(["Taxes and Charges", `{{ ${this.doc_value_jinja("total_taxes_and_charges", true)} }}`]);
    if (element.show_grand_total) rows.push(["Grand Total", `{{ ${this.doc_value_jinja("grand_total", true)} }}`]);
    if (element.show_paid_amount) rows.push(["Paid Amount", `{{ ${this.doc_value_jinja("paid_amount", true)} }}`]);
    if (element.show_change_amount) rows.push(["Change Amount", `{{ ${this.doc_value_jinja("change_amount", true)} }}`]);

    return rows
      .map(([label, value]) => `
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>${this.render_label(label, true)}</span>
  <span>${value}</span>
</div>`.trim())
      .join("\n");
  }

  render_print_payments(element) {
    const font_size = ptb_cint(element.font_size || 11);
    const title = element.title !== undefined ? element.title : "Payments";

    return `
${element.show_header ? `<div class="thermal-text" style="font-weight:700; font-size:${font_size}px;">{{ _("${this.escape_html(title)}") }}</div>` : ""}
{% for payment in doc.payments %}
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>{{ payment.get("mode_of_payment") or "" }}</span>
  <span>{{ "{:,.2f}".format(payment.get("amount") or 0) }} {{ doc.currency }}</span>
</div>
{% endfor %}`.trim();
  }

  render_print_taxes(element) {
    const font_size = ptb_cint(element.font_size || 10);
    const title = element.title !== undefined ? element.title : "Taxes and Charges";

    return `
${element.show_header ? `<div class="thermal-text" style="font-weight:700; font-size:${font_size}px;">{{ _("${this.escape_html(title)}") }}</div>` : ""}
{% for tax in doc.taxes %}
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>{{ tax.get("description") or tax.get("account_head") or "" }}</span>
  <span>{{ "{:,.2f}".format(tax.get("tax_amount") or 0) }} {{ doc.currency }}</span>
</div>
{% endfor %}`.trim();
  }

  render_print_qr_code(element) {
    const width = ptb_cint(element.width || 26);
    const code_value = this.get_qr_value_jinja(element);
    const align = this.css_align(element.align);
    const margin_top = ptb_cint(element.margin_top);
    const margin_bottom = ptb_cint(element.margin_bottom);

    if (element.type === "barcode") {
      const barcode_type = this.escape_jinja_string(element.barcode_type || "code128");
      const max_height = Math.max(8, Math.round(width / 2));

      return `
{% set ptb_code_value = ${code_value} %}
{% if get_barcode_data_uri is defined %}
  {% set ptb_code_data_uri = get_barcode_data_uri(ptb_code_value, "${barcode_type}") %}
{% else %}
  {% set ptb_code_data_uri = "" %}
{% endif %}
{% if ptb_code_data_uri %}
<div style="text-align:${align}; margin:${margin_top}px 0 ${margin_bottom}px;">
  <img class="thermal-qr" src="{{ ptb_code_data_uri }}" style="width:${width}mm; max-height:${max_height}mm;">
</div>
{% endif %}`.trim();
    }

    return `
{% set ptb_qr_value = ${code_value} %}
{% if get_qr_data_uri is defined %}
  {% set ptb_qr_data_uri = get_qr_data_uri(ptb_qr_value) %}
{% else %}
  {% set ptb_qr_data_uri = "" %}
{% endif %}
{% if ptb_qr_data_uri %}
<div style="text-align:${align}; margin:${margin_top}px 0 ${margin_bottom}px;">
  <img class="thermal-qr" src="{{ ptb_qr_data_uri }}" style="width:${width}mm;">
</div>
{% endif %}`.trim();
  }

  get_qr_value_jinja(element) {
    if (element.content_type === "static_text") {
      return `"${this.escape_jinja_string(element.static_value || "")}"`;
    }

    if (element.content_type === "url") {
      return `"${this.escape_jinja_string(element.url || "")}"`;
    }

    if (element.content_type === "document_field") {
      return this.doc_value_jinja(element.fieldname || "name");
    }

    if (element.content_type === "multiple_fields") {
      const fields = (element.fields || ["name"])
        .map((field) => this.safe_fieldname(field))
        .filter(Boolean)
        .map((field) => this.doc_value_jinja(field));

      return `([${fields.length ? fields.join(", ") : this.doc_value_jinja("name")}] | join(" | "))`;
    }

    if (element.content_type === "custom_jinja") {
      return String(element.custom_jinja || "doc.name").trim() || "doc.name";
    }

    return this.doc_value_jinja("name");
  }

  doc_value_jinja(fieldname, formatted = false) {
    const field = this.safe_fieldname(fieldname);

    if (!field) return '""';

    if (formatted) {
      return `(doc.get_formatted("${field}") or doc.get("${field}") or "")`;
    }

    return `(doc.get("${field}") or "")`;
  }

  row_value_jinja(fieldname) {
    const field = this.safe_fieldname(fieldname);

    if (!field) return '""';

    return `(row.get("${field}") or "")`;
  }

  safe_css_color(value, fallback = "#000000") {
    const color = String(value || "").trim();

    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
      return color;
    }

    return fallback;
  }

  safe_border_style(value) {
    return PTB_ALLOWED_BORDER_STYLES.has(value) ? value : "solid";
  }

  safe_line_style(value) {
    return PTB_ALLOWED_LINE_STYLES.has(value) ? value : "dashed";
  }

  render_label(label, translate_label = true) {
    const clean_label = this.escape_jinja_string(label || "");

    if (translate_label) {
      return `{{ _("${clean_label}") }}`;
    }

    return this.escape_html(label || "");
  }

  get_print_style(element) {
    return [
      `text-align:${this.css_align(element.align)}`,
      `font-size:${ptb_cint(element.font_size)}px`,
      `font-weight:${element.bold ? "700" : "400"}`,
      `margin-top:${ptb_cint(element.margin_top)}px`,
      `margin-bottom:${ptb_cint(element.margin_bottom)}px`
    ].join(";");
  }

  show_generated_code(html) {
    this.$root.find("#ptb-generated-code").val(html);
    this.$root.find("#ptb-code-modal").removeClass("ptb-hidden");
  }

print_test() {
  const outputs = this.state.receipt_outputs || this.get_default_receipt_outputs();

  let content_html = "";

  if (outputs.enabled) {
    content_html = this.generate_receipt_outputs_preview_html(outputs);
  } else {
    const $clone = this.$root.find("#ptb-paper").clone();

    $clone.removeAttr("id");
    $clone.addClass("ptb-print-test-paper");
    $clone.find(".ptb-element-tools, .ptb-empty, .ptb-container-empty").remove();
    $clone.find(".ptb-canvas-element").removeClass("ptb-active ptb-dragover ptb-dragover-top ptb-dragover-bottom ptb-dragover-inside");
    $clone.find("[contenteditable]").removeAttr("contenteditable");

    content_html = `
      <div class="ptb-print-test-page">
        ${$clone[0].outerHTML}
      </div>
    `;
  }

  const paper_size = this.state.paper_size || "80";
  const paper_width = paper_size === "58" ? "58mm" : "80mm";

  const print_window = window.open("", "_blank", "width=420,height=700");

  if (!print_window) {
    frappe.show_alert({
      message: __("Popup blocker prevented print test"),
      indicator: "orange"
    });
    return;
  }

  print_window.document.write(`
    <html>
      <head>
        <title>${__("Print Test")}</title>
        <style>
          @page {
            size: ${paper_width} auto;
            margin: 0;
          }

          html,
          body {
            width: ${paper_width};
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
            overflow: visible !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          * {
            box-sizing: border-box;
          }

          .ptb-print-test-document {
            display: block !important;
            width: ${paper_width} !important;
            max-width: ${paper_width} !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
          }

          .ptb-print-test-page {
            display: block !important;
            width: ${paper_width} !important;
            max-width: ${paper_width} !important;
            min-width: ${paper_width} !important;
            margin: 0 !important;
            padding: 0 !important;
            float: none !important;
            clear: both !important;
            page-break-after: always;
            break-after: page;
          }

          .ptb-print-test-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }

          .ptb-paper,
          .ptb-print-test-paper {
            display: block !important;
            width: ${paper_width} !important;
            max-width: ${paper_width} !important;
            min-width: 0 !important;
            margin: 0 !important;
            padding: 2mm !important;
            border: none !important;
            box-shadow: none !important;
            background: #ffffff !important;
            color: #000000 !important;
            font-family: Tahoma, Arial, sans-serif !important;
            direction: rtl !important;
          }

          .ptb-canvas-element {
            display: block !important;
            width: 100% !important;
            clear: both !important;
            float: none !important;
            padding: 0 !important;
            margin: 0 0 2px 0 !important;
            border: none !important;
            box-shadow: none !important;
            background: transparent !important;
          }

          .ptb-element-tools,
          .ptb-empty,
          .ptb-container-empty,
          .ptb-split-badge {
            display: none !important;
          }

          .ptb-receipt-text {
            white-space: pre-wrap;
            word-break: break-word;
          }

          .ptb-receipt-row {
            display: flex !important;
            justify-content: space-between !important;
            gap: 8px !important;
            width: 100% !important;
          }

          .ptb-receipt-row span:last-child {
            text-align: left !important;
            direction: ltr !important;
          }

          .ptb-preview-table {
            width: 100% !important;
            border-collapse: collapse !important;
          }

          .ptb-preview-table th,
          .ptb-preview-table td {
            border-bottom: 1px solid #777 !important;
            padding: 3px 2px !important;
            vertical-align: top !important;
          }

          .ptb-preview-table td:last-child,
          .ptb-preview-table th:last-child {
            text-align: left !important;
            direction: ltr !important;
          }

          .ptb-divider {
            border-top: 1px dashed #000 !important;
            height: 1px !important;
            margin: 6px 0 !important;
          }

          .ptb-image-preview {
            display: block !important;
            max-width: 100% !important;
            margin: 0 auto !important;
          }

          .ptb-container-preview {
            display: block !important;
            width: 100% !important;
          }

          @media print {
            html,
            body {
              width: ${paper_width} !important;
            }

            .ptb-print-test-page {
              page-break-after: always;
              break-after: page;
            }

            .ptb-print-test-page:last-child {
              page-break-after: auto;
              break-after: auto;
            }
          }
        </style>
      </head>

      <body>
        <div class="ptb-print-test-document">
          ${content_html}
        </div>

        <script>
          window.onload = function() {
            setTimeout(function() {
              window.focus();
              window.print();
            }, 300);
          };
        </script>
      </body>
    </html>
  `);

  print_window.document.close();
}

  generate_receipt_outputs_preview_html(outputs) {
    let html = "";
    let has_previous = false;
    const add_page_break = Boolean(outputs.page_break_between_receipts);

    const render_part = (mode, title, items_filter_fn = null) => {
      const $clone = this.$root.find("#ptb-paper").clone();

      $clone.find(".ptb-element-tools, .ptb-empty, .ptb-container-empty").remove();
      $clone.find(".ptb-canvas-element").removeClass("ptb-active ptb-dragover ptb-dragover-top ptb-dragover-bottom ptb-dragover-inside");
      $clone.find("[contenteditable]").removeAttr("contenteditable");

      $clone.find(".ptb-canvas-element").each((_, el) => {
        const id = $(el).data("id");
        const element = this.find_element(id);
        const visible_in = element && Array.isArray(element.visible_in)
          ? element.visible_in
          : element ? this.get_default_visible_in(element.type) : [];

        if (!visible_in.includes(mode)) {
          $(el).remove();
        }
      });

      $clone.find(".ptb-canvas-element").each((_, el) => {
        const id = $(el).data("id");
        const element = this.find_element(id);

        if (element && element.type === "receipt_title") {
          $(el).find(".ptb-receipt-text").text(title || "");
        }
      });

      if (items_filter_fn) {
        $clone.find(".ptb-canvas-element").each((_, el) => {
          const id = $(el).data("id");
          const element = this.find_element(id);
          if (!element || element.type !== "items_table") return;

          const $table = $(el).find(".ptb-preview-table");
          const $tbody = $table.find("tbody");
          const filtered_items = this.sample_doc.items.filter(items_filter_fn);

          if (!filtered_items.length) {
            $(el).remove();
            return;
          }

          const col_names = (element.columns || []).map(c => this.safe_fieldname(c)).filter(Boolean);
          let rows_html = "";

          for (const row of filtered_items) {
            rows_html += `<tr>${col_names.map((c) => `<td>${this.escape_html(this.get_sample_item_value(row, c, element))}</td>`).join("")}</tr>`;
          }

          $tbody.html(rows_html);
        });
      }

      $clone.removeAttr("id");
      $clone.addClass("ptb-print-test-paper");

      return `
        <div class="ptb-print-test-page">
          ${$clone[0].outerHTML}
        </div>
      `;
    };

    const add_part = (part) => {
      if (!part) return;
      if (has_previous && add_page_break) {
        html += '<div class="page-break"></div>';
      }
      html += part;
      has_previous = true;
    };

    if (outputs.customer && outputs.customer.enabled) {
      add_part(render_part("customer", outputs.customer.title || __("Customer Receipt")));
    }

    if (outputs.waiter && outputs.waiter.enabled) {
      add_part(render_part("waiter", outputs.waiter.title || __("Waiter Receipt")));
    }

    if (outputs.item_group && outputs.item_group.enabled) {
      const group_by = outputs.item_group.group_by || "item_group";
      const groups = {};

      this.sample_doc.items.forEach((item) => {
        const group_name = item[group_by] || __("No Item Group");
        groups[group_name] = groups[group_name] || [];
        groups[group_name].push(item);
      });

      Object.keys(groups).forEach((group_name) => {
        const title = `${outputs.item_group.title_prefix || __("Receipt for")} ${group_name}`;
        add_part(render_part("item_group", title, (item) => (item[group_by] || __("No Item Group")) === group_name));
      });
    }

    return html;
  }

  async copy_generated_code() {
    const code = this.$root.find("#ptb-generated-code").val() || "";

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(code);
      frappe.show_alert({ message: __("Code copied"), indicator: "green" });
      return;
    }

    const textarea = this.$root.find("#ptb-generated-code")[0];

    if (!textarea) return;

    textarea.select();
    document.execCommand("copy");
    frappe.show_alert({ message: __("Code copied"), indicator: "green" });
  }

  css_align(value) {
    if (value === "right") return "right";
    if (value === "left") return "left";
    return "center";
  }

  safe_fieldname(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_]/g, "");
  }

  escape_jinja_string(value) {
    return String(value ?? "")
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n");
  }

  format_money(value) {
    return Number(value || 0).toFixed(2);
  }

  escape_html(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  escape_attr(value) {
    return this.escape_html(value).replaceAll("`", "&#096;");
  }

  get_sample_doc() {
    return {
      name: "ACC-PSINV-2026-00001",
      company: "Sanad Digital",
      company_logo: "",
      customer: "Cash Customer",
      posting_date: "2026-06-29",
      posting_time: "14:30:00",
      pos_profile: "Main Branch - Cashier 1",
      order_type: "Dine In",
      pos_order_type: "Dine In",
      owner: "cashier@example.com",
      currency: "SAR",
      total_qty: 3,
      net_total: 125,
      total_taxes_and_charges: 18.75,
      grand_total: 143.75,
      rounded_total: 144,
      paid_amount: 150,
      change_amount: 6,
      discount_amount: 0,
      items: [
        {
          item_code: "ITEM-001",
          item_name: "Product One",
          description: "Product One",
          item_group: "Food",
          qty: 1,
          uom: "Nos",
          rate: 25,
          price_list_rate: 25,
          amount: 25,
          remarks: "No sugar"
        },
        {
          item_code: "ITEM-002",
          item_name: "Product Two",
          description: "Product Two",
          item_group: "Drinks",
          qty: 2,
          uom: "Box",
          rate: 50,
          price_list_rate: 50,
          amount: 100,
          remarks: ""
        }
      ],
      payments: [
        { mode_of_payment: "Cash", amount: 100 },
        { mode_of_payment: "Card", amount: 50 }
      ],
      taxes: [
        { description: "VAT 15%", tax_amount: 18.75 }
      ]
    };
  }
}