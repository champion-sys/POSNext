frappe.pages["pos-thermal-builder"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: __("POS Thermal Print Builder"),
    single_column: true
  });

  $(page.body).html(frappe.render_template("pos_thermal_builder"));
  new POSThermalPrintBuilder(page);
};

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
      elements: []
    };

    this.pos_settings_list = [];
    this.templates = [];
    this.invoice_fields = [];
    this.table_fields = [];
    this.child_table_fields = {};
    this.active_id = null;
    this.dragged_id = null;
    this.sample_doc = this.get_sample_doc();

    this.bind();
    this.apply_translations();
    this.load_pos_settings_list();
  }

  bind() {
    this.$root.on("change", "#ptb-pos-settings", (e) => {
      if (e.originalEvent) this.on_pos_settings_change();
    });
    this.$root.on("change", "#ptb-template", (e) => {
      if (e.originalEvent) this.on_template_select_change();
    });

    this.$root.on("change", "#ptb-paper-size", (e) => {
      this.state.paper_size = String(e.target.value || "80");
      this.render_canvas();
    });

    this.$root.on("input", "#ptb-template-name", (e) => {
      this.state.template_name = e.target.value || "";
    });

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

    this.$root.on("click", ".ptb-delete", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const id = $(e.currentTarget).closest(".ptb-canvas-element").data("id");
      this.delete_element(id);
    });

    this.$root.on("dragstart", ".ptb-canvas-element", (e) => {
      e.stopPropagation();
      this.dragged_id = $(e.currentTarget).data("id");
      e.originalEvent.dataTransfer.effectAllowed = "move";
    });

    this.$root.on("dragover", ".ptb-canvas-element", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.$root.find(".ptb-canvas-element").removeClass("ptb-dragover");
      $(e.currentTarget).addClass("ptb-dragover");
    });

    this.$root.on("dragleave drop dragend", ".ptb-canvas-element", (e) => {
      $(e.currentTarget).removeClass("ptb-dragover");
    });

    this.$root.on("dragend", ".ptb-canvas-element", (e) => {
      this.$root.find(".ptb-canvas-element").removeClass("ptb-dragover");
    });

    this.$root.on("drop", ".ptb-canvas-element", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const target_id = $(e.currentTarget).data("id");
      this.reorder_element(this.dragged_id, target_id);
      this.dragged_id = null;
    });

    this.$root.on("input change", "#ptb-props [data-prop]", (e) => {
      this.update_active_from_input(e.currentTarget);
    });

    this.$root.on("change", "#ptb-props [data-column]", (e) => {
      this.update_table_columns(e.currentTarget);
    });

    this.$root.on("click", "#ptb-upload-image", (e) => {
      e.preventDefault();
      this.upload_image_for_active_element();
    });

    this.$root.on("click", "#ptb-add-field-to-container", (e) => {
      e.preventDefault();
      this.add_element("field");
    });

    this.$root.on("click", "#ptb-new-template", () => this.new_template());
    this.$root.on("click", "#ptb-load-template", () => this.load_selected_template());
    this.$root.on("click", "#ptb-save-template", () => this.save_template());
    this.$root.on("click", "#ptb-save-as-template", () => this.save_as_template());
    this.$root.on("click", "#ptb-set-default", () => this.set_default_template());
    this.$root.on("click", "#ptb-generate-print-format", () => this.generate_print_format());

    this.$root.on("click", "#ptb-close-code, #ptb-close-code-bottom", () => {
      this.$root.find("#ptb-code-modal").addClass("ptb-hidden");
    });

    this.$root.on("click", "#ptb-copy-code", () => this.copy_generated_code());
  }

  apply_translations() {
    this.$root.find("[data-i18n]").each((_, el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = __(key);
    });

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
            reject(r.exc);
            return;
          }

          resolve(r.message);
        },
        error: reject
      });
    });
  }

  depends(condition, html) {
    return condition ? html : "";
  }

  async load_pos_settings_list() {
    const records = await this.call("get_pos_settings_list");
    this.pos_settings_list = records || [];

    const $select = this.$root.find("#ptb-pos-settings");
    $select.empty();

    if (!this.pos_settings_list.length) {
      $select.append(`<option value="">${__("No POS Settings found")}</option>`);
      return;
    }

    this.pos_settings_list.forEach((row) => {
      const label = row.pos_profile ? `${row.pos_profile} (${row.name})` : row.name;
      $select.append(`<option value="${this.escape_attr(row.name)}">${this.escape_html(label)}</option>`);
    });

    const route_template = frappe.route_options && frappe.route_options.template;

    if (route_template) {
      await this.load_template(route_template);
      frappe.route_options = null;
      return;
    }

    this.state.pos_settings = this.pos_settings_list[0].name;
    $select.val(this.state.pos_settings);
    await this.on_pos_settings_change();
  }

  async on_pos_settings_change() {
    const pos_settings = this.$root.find("#ptb-pos-settings").val();

    if (!pos_settings) return;

    this.state.pos_settings = pos_settings;

    const context = await this.call("get_pos_settings_context", { pos_settings });
    this.state.invoice_doctype = context.invoice_doctype || "POS Invoice";

    this.$root.find("#ptb-invoice-doctype").val(this.state.invoice_doctype);

    await this.load_invoice_fields();
    await this.load_templates();

    this.state.template = "";
    this.state.template_name = "";
    this.state.is_default = 0;
    this.state.elements = [];
    this.active_id = null;

    this.$root.find("#ptb-template-name").val("").prop("disabled", false);

    this.render();
  }

  async load_invoice_fields() {
    if (!this.state.invoice_doctype) return;

    const result = await this.call("get_invoice_doctype_fields", {
      invoice_doctype: this.state.invoice_doctype
    });

    this.invoice_fields = result.fields || [];
    this.table_fields = result.table_fields || [];

    const items_table = this.table_fields.find((df) => df.fieldname === "items") || this.table_fields[0];

    if (items_table && items_table.options && !this.child_table_fields[items_table.options]) {
      const child = await this.call("get_child_table_fields", {
        child_doctype: items_table.options
      });

      this.child_table_fields[items_table.options] = child.fields || [];
    }
  }

  async load_templates() {
    if (!this.state.pos_settings || !this.state.invoice_doctype) return;

    const templates = await this.call("list_templates", {
      pos_settings: this.state.pos_settings,
      invoice_doctype: this.state.invoice_doctype
    });

    this.templates = templates || [];
    this.render_template_select();
  }

  render_template_select() {
    const $select = this.$root.find("#ptb-template");
    $select.empty();

    $select.append(`<option value="">${__("New Template")}</option>`);

    this.templates.forEach((row) => {
      const suffix = row.is_default ? ` - ${__("Default")}` : "";
      $select.append(`
        <option value="${this.escape_attr(row.name)}">
          ${this.escape_html(row.template_name)}${suffix}
        </option>
      `);
    });

    $select.val(this.state.template || "");
  }

  on_template_select_change() {
    const template = this.$root.find("#ptb-template").val();

    if (!template) {
      this.new_template(false);
      return;
    }

    this.load_template(template);
  }

  async load_selected_template() {
    const template = this.$root.find("#ptb-template").val();

    if (!template) {
      frappe.show_alert({ message: __("Please select a template"), indicator: "orange" });
      return;
    }

    await this.load_template(template);
  }

  async load_template(template) {
    const data = await this.call("get_template", { template });

    this.state.pos_settings = data.pos_settings;
    this.state.invoice_doctype = data.invoice_doctype;
    this.state.template = data.name;
    this.state.template_name = data.template_name;
    this.state.paper_size = String(data.paper_size || "80");
    this.state.is_default = cint(data.is_default);

    const layout = data.layout_json || {};
    this.state.elements = layout.elements || [];
    this.active_id = null;

    this.$root.find("#ptb-pos-settings").val(this.state.pos_settings);
    this.$root.find("#ptb-invoice-doctype").val(this.state.invoice_doctype);
    this.$root.find("#ptb-template-name").val(this.state.template_name).prop("disabled", true);
    this.$root.find("#ptb-paper-size").val(this.state.paper_size);

    await this.load_invoice_fields();
    await this.load_templates();

    this.$root.find("#ptb-template").val(this.state.template);

    this.render();
  }

  new_template(clear_name = true) {
    this.state.template = "";
    this.state.template_name = clear_name ? "" : this.state.template_name;
    this.state.paper_size = "80";
    this.state.is_default = 0;
    this.state.elements = [];
    this.active_id = null;

    this.$root.find("#ptb-template").val("");
    this.$root.find("#ptb-template-name").val(this.state.template_name).prop("disabled", false);
    this.$root.find("#ptb-paper-size").val(this.state.paper_size);

    this.render();
  }

  async save_template() {
    if (!this.state.pos_settings) {
      frappe.throw(__("POS Settings is required"));
      return;
    }

    const template_name = (this.$root.find("#ptb-template-name").val() || "").trim();

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

    await this.load_templates();

    this.$root.find("#ptb-template").val(this.state.template);
    this.$root.find("#ptb-template-name").val(this.state.template_name).prop("disabled", true);

    frappe.show_alert({ message: __("Template saved"), indicator: "green" });
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
      async (values) => {
        const old_template = this.state.template;
        this.state.template = "";
        this.$root.find("#ptb-template-name").val(values.template_name);
        this.state.template_name = values.template_name;

        try {
          await this.save_template();
        } catch (e) {
          this.state.template = old_template;
        }
      },
      __("Save As"),
      __("Save")
    );
  }

  async set_default_template() {
    if (!this.state.template) {
      await this.save_template();
    } else {
      await this.save_template();
    }

    const result = await this.call("set_default_template", {
      template: this.state.template
    }, true);

    this.state.is_default = 1;

    await this.load_templates();

    const message = result.pos_profile_updated
      ? __("Template set as default and assigned to POS Profile")
      : __("Template set as default");

    frappe.show_alert({ message, indicator: "green" });
  }

  async generate_print_format() {
    if (!this.state.template) {
      await this.save_template();
    } else {
      await this.save_template();
    }

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
      elements: this.state.elements
    };
  }

  add_element(type, overrides = {}) {
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

  get_default_element(type) {
    const base = {
      id: this.make_id(),
      type,
      label: this.get_type_label(type),
      align: "center",
      font_size: 11,
      bold: false,
      margin_top: 2,
      margin_bottom: 2
    };

    const defaults = {
      text: {
        content: "Custom Text",
        align: "center",
        font_size: 12,
        bold: true
      },
      field: {
        fieldname: "name",
        label: "Invoice Number",
        show_label: true,
        translate_label: true,
        align: "right"
      },
      image: {
        source_type: "company_logo",
        image_url: "",
        file_url: "",
        width: 36,
        align: "center"
      },
      divider: {
        line_style: "dashed"
      },
      spacer: {
        height: 8
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
      items_table: {
        show_header: true,
        table_fieldname: "items",
        child_doctype: "",
        columns: ["item_name", "qty", "rate", "amount"],
        rate_field: "rate",
        amount_mode: "amount",
        show_item_remarks: true,
        header_bg_color: "#f2f0f0",
        header_text_color: "#000000",
        header_border_color: "#000000",
        font_size: 10,
        align: "right",
        split_settings: {
          enabled: false,
          split_by: "item_group",
          print_customer_receipt: true,
          customer_receipt_title: "Customer Receipt",
          print_waiter_receipt: true,
          waiter_receipt_title: "Waiter Receipt",
          print_group_receipts: true,
          group_receipt_title_prefix: "Receipt for",
          add_page_break_between_receipts: true,
          include_totals_in_group_receipts: false,
          include_payments_in_group_receipts: false
        }
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
      container: "Container",
      details_table: "Details Table",
      footer_note: "Footer Note",
      qr_code: "QR Code",
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
    this.active_id = id;
    this.render();
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

  reorder_element(source_id, target_id) {
    if (!source_id || !target_id || source_id === target_id) return;

    const source_info = this.find_element_info(source_id);
    const target_info = this.find_element_info(target_id);

    if (!source_info || !target_info) return;

    // A container cannot contain a container
    if (source_info.element.type === "container") {
      if (target_info.parent !== null || target_info.element.type === "container") {
        return;
      }
    }

    // Target cannot be a descendant of source
    if (this.find_element(target_id, source_info.element.children || [])) {
      return;
    }

    // Remove source from its original location
    const [source] = source_info.list.splice(source_info.index, 1);

    // If target is a container, we drop it INTO the container
    if (target_info.element.type === "container") {
      target_info.element.children = target_info.element.children || [];
      target_info.element.children.push(source);
    } else {
      // Otherwise, we insert it at target's position
      let target_index = target_info.index;
      
      // Adjust target index if source and target were in the same list and source was before target
      if (source_info.list === target_info.list && source_info.index < target_info.index) {
        target_index--;
      }
      
      target_info.list.splice(target_index, 0, source);
    }

    this.render();
  }

  render() {
    this.render_canvas();
    this.render_props();
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

    return `
      <div class="ptb-canvas-element ${active}" data-id="${this.escape_attr(element.id)}" draggable="true">
        <div class="ptb-element-tools">
          <button class="ptb-tool-btn ptb-delete" title="${this.escape_attr(__("Delete"))}" type="button">×</button>
        </div>
        ${body}
      </div>
    `;
  }

  render_preview_body(element) {
    const style = this.get_preview_style(element);

    if (element.type === "text" || element.type === "footer_note") {
      return `<div class="ptb-receipt-text" style="${style}">${this.escape_html(element.content)}</div>`;
    }

    if (element.type === "field") {
      const value = this.sample_doc[element.fieldname] ?? "";

      return `
        <div class="ptb-receipt-row" style="${style}">
          ${element.show_label ? `<span>${this.escape_html(element.label || element.fieldname)}</span>` : ""}
          <span>${this.escape_html(value)}</span>
        </div>
      `;
    }

    if (element.type === "image") {
      const src = element.source_type === "url" ? element.image_url : element.file_url;

      if (element.source_type === "company_logo") {
        return `<div class="ptb-image-placeholder" style="${style}">${__("Company Logo")}</div>`;
      }

      if (!src) {
        return `<div class="ptb-image-placeholder" style="${style}">${__("Image")}</div>`;
      }

      return `
        <div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
          <img class="ptb-image-preview" src="${this.escape_attr(src)}" style="width:${cint(element.width)}mm;">
        </div>
      `;
    }

    if (element.type === "divider") {
      return `<div class="ptb-divider" style="border-top-style:${this.escape_attr(element.line_style || "dashed")};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${cint(element.height)}px;"></div>`;
    }

    if (element.type === "container") {
      const child_html = (element.children || [])
        .map((child) => this.render_canvas_element(child))
        .join("");

      const container_style = [
        `border:${cint(element.border_width)}px ${element.border_style || "solid"} ${element.border_color || "#000"}`,
        `border-radius:${cint(element.border_radius)}px`,
        `padding:${cint(element.padding)}px`,
        `background:${element.background_color || "#fff"}`
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

    if (element.type === "qr_code") {
      return `
        <div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
          <div class="ptb-qr-placeholder" style="width:${cint(element.width)}mm; min-height:${cint(element.width)}mm;">
            ${__("QR Code")}
          </div>
        </div>
      `;
    }

    return "";
  }

  render_preview_details_table(element) {
    const rows = element.rows || [];
    const title = element.show_title
      ? `<tr><td colspan="2" style="text-align:center;font-weight:700;background:${this.escape_attr(element.header_bg_color || "#f2f0f0")}">${this.escape_html(element.title || "")}</td></tr>`
      : "";

    const body = rows
      .map((row) => {
        const value = this.sample_doc[row.fieldname] ?? "";
        return `
          <tr>
            <td style="font-weight:700;">${this.escape_html(row.label)}</td>
            <td style="text-align:left;direction:ltr;">${this.escape_html(value)}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <table class="ptb-preview-table" style="
        font-size:${cint(element.font_size || 11)}px;
        border:${cint(element.border_width)}px ${element.border_style || "solid"} ${element.border_color || "#000"};
        border-radius:${cint(element.border_radius)}px;
        border-collapse:separate;
        overflow:hidden;
      ">
        ${title}
        <tbody>${body}</tbody>
      </table>
    `;
  }

  render_preview_items_table(element) {
    const columns = element.columns || [];
    const labels = this.get_item_column_labels();

    const thead = element.show_header
      ? `
        <thead style="background:${this.escape_attr(element.header_bg_color || "#f2f0f0")}; color:${this.escape_attr(element.header_text_color || "#000")}">
          <tr>
            ${columns.map((c) => `<th>${this.escape_html(labels[c] || c)}</th>`).join("")}
          </tr>
        </thead>
      `
      : "";

    const rows = this.sample_doc.items
      .map((row) => {
        return `<tr>${columns.map((c) => `<td>${this.escape_html(this.get_sample_item_value(row, c, element))}</td>`).join("")}</tr>`;
      })
      .join("");

    const split_badge = element.split_settings && element.split_settings.enabled
      ? `<div class="ptb-receipt-text" style="font-size:9px;text-align:center;">${__("Receipt splitting is enabled")}</div>`
      : "";

    return `
      ${split_badge}
      <table class="ptb-preview-table" style="font-size:${cint(element.font_size)}px;">
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
        <div class="ptb-receipt-row" style="font-size:${cint(element.font_size)}px;">
          <span>${this.escape_html(label)}</span>
          <span>${this.format_money(value)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");
  }

  render_preview_payments(element) {
    const header = element.show_header
      ? `<div class="ptb-receipt-text" style="font-weight:700;">${__("Payments")}</div>`
      : "";

    const rows = this.sample_doc.payments
      .map((row) => `
        <div class="ptb-receipt-row" style="font-size:${cint(element.font_size)}px;">
          <span>${this.escape_html(row.mode_of_payment)}</span>
          <span>${this.format_money(row.amount)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");

    return header + rows;
  }

  render_preview_taxes(element) {
    const header = element.show_header
      ? `<div class="ptb-receipt-text" style="font-weight:700;">${__("Taxes and Charges")}</div>`
      : "";

    const rows = this.sample_doc.taxes
      .map((row) => `
        <div class="ptb-receipt-row" style="font-size:${cint(element.font_size)}px;">
          <span>${this.escape_html(row.description)}</span>
          <span>${this.format_money(row.tax_amount)} ${this.escape_html(this.sample_doc.currency)}</span>
        </div>
      `)
      .join("");

    return header + rows;
  }

  get_sample_item_value(row, column, element) {
    if (column === "amount" && element.amount_mode === "price_list_rate_times_qty") {
      return flt(row.price_list_rate) * flt(row.qty);
    }

    if (column === "rate" && element.rate_field === "price_list_rate") {
      return row.price_list_rate;
    }

    return row[column] ?? "";
  }

  get_preview_style(element) {
    return [
      `text-align:${this.css_align(element.align)}`,
      `font-size:${cint(element.font_size)}px`,
      `font-weight:${element.bold ? "700" : "400"}`,
      `margin-top:${cint(element.margin_top)}px`,
      `margin-bottom:${cint(element.margin_bottom)}px`
    ].join(";");
  }

  render_props() {
    const element = this.find_element(this.active_id);
    const $form = this.$root.find("#ptb-props");
    const $empty = this.$root.find("#ptb-props-empty");

    if (!element) {
      $form.empty().hide();
      $empty.show();
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
    `;

    if (element.type === "text" || element.type === "footer_note") {
      html += `
        <div class="ptb-section-label">${__("Text Properties")}</div>
        ${this.textarea("content", __("Text"), element.content)}
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

    if (element.type === "payments" || element.type === "taxes") {
      html += `
        <div class="ptb-section-label">${__("Display Settings")}</div>
        ${this.checkbox("show_header", __("Show Header"), element.show_header)}
      `;
    }

    if (element.type === "qr_code") {
      html += `
        <div class="ptb-section-label">${__("QR Code Properties")}</div>
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

        ${this.number("width", __("Width in mm"), element.width)}
      `;
    }

    return html;
  }

  get_items_table_props_html(element) {
    return `
      <div class="ptb-section-label">${__("Items Table Settings")}</div>
      ${this.checkbox("show_header", __("Show Table Header"), element.show_header)}
      ${this.checkbox("show_item_remarks", __("Show Item Remarks"), element.show_item_remarks)}
      ${this.select("rate_field", __("Rate Field"), element.rate_field, [
        ["rate", __("Rate")],
        ["price_list_rate", __("Price List Rate")]
      ])}
      ${this.select("amount_mode", __("Amount Mode"), element.amount_mode, [
        ["amount", __("Amount Field")],
        ["price_list_rate_times_qty", __("Price List Rate x Quantity")]
      ])}

      <div class="ptb-section-label">${__("Table Header Style")}</div>
      ${this.color("header_bg_color", __("Header Background Color"), element.header_bg_color)}
      ${this.color("header_text_color", __("Header Text Color"), element.header_text_color)}
      ${this.color("header_border_color", __("Header Border Color"), element.header_border_color)}

      <div class="ptb-section-label">${__("Items Table Columns")}</div>
      ${this.item_columns_html(element)}

      <div class="ptb-section-label">${__("Receipt Splitting")}</div>
      ${this.checkbox("split_settings.enabled", __("Enable Split by Item Group"), element.split_settings?.enabled)}

      ${this.depends(element.split_settings?.enabled, `
        ${this.checkbox("split_settings.print_customer_receipt", __("Print Customer Receipt"), element.split_settings?.print_customer_receipt)}

        ${this.depends(element.split_settings?.print_customer_receipt, `
          ${this.input("split_settings.customer_receipt_title", __("Customer Receipt Title"), element.split_settings?.customer_receipt_title)}
        `)}

        ${this.checkbox("split_settings.print_waiter_receipt", __("Print Waiter Receipt"), element.split_settings?.print_waiter_receipt)}

        ${this.depends(element.split_settings?.print_waiter_receipt, `
          ${this.input("split_settings.waiter_receipt_title", __("Waiter Receipt Title"), element.split_settings?.waiter_receipt_title)}
        `)}

        ${this.checkbox("split_settings.print_group_receipts", __("Print Item Group Receipts"), element.split_settings?.print_group_receipts)}

        ${this.depends(element.split_settings?.print_group_receipts, `
          ${this.input("split_settings.group_receipt_title_prefix", __("Item Group Receipt Title Prefix"), element.split_settings?.group_receipt_title_prefix)}
        `)}

        ${this.checkbox("split_settings.add_page_break_between_receipts", __("Add Page Break Between Receipts"), element.split_settings?.add_page_break_between_receipts)}
        ${this.checkbox("split_settings.include_totals_in_group_receipts", __("Include Totals in Group Receipts"), element.split_settings?.include_totals_in_group_receipts)}
        ${this.checkbox("split_settings.include_payments_in_group_receipts", __("Include Payments in Group Receipts"), element.split_settings?.include_payments_in_group_receipts)}
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
    const safe_value = value || "#000000";
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
    const labels = this.get_item_column_labels();
    const selected = element.columns || [];

    return Object.keys(labels)
      .map((fieldname) => `
        <label class="ptb-check">
          <input type="checkbox" data-column="${this.escape_attr(fieldname)}" ${selected.includes(fieldname) ? "checked" : ""}>
          <span>${this.escape_html(labels[fieldname])}</span>
        </label>
      `)
      .join("");
  }

  get_field_options(fields) {
    const standard = [];
    const custom = [];

    (fields || []).forEach((field) => {
      let label = `${field.label || field.fieldname} (${field.fieldname})`;

      if (field.hidden) {
        label += ` [${__("Hidden")}]`;
      }

      if (field.is_custom) {
        custom.push([field.fieldname, `${label} [${__("Custom")}]`]);
      } else {
        standard.push([field.fieldname, label]);
      }
    });

    return [...standard, ...custom];
  }

  get_item_column_labels() {
    return {
      item_code: "Item Code",
      item_name: "Item Name",
      description: "Description",
      qty: "Quantity",
      uom: "UOM",
      rate: "Rate",
      amount: "Amount"
    };
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

  update_active_from_input(input) {
    const element = this.find_element(this.active_id);
    if (!element) return;

    const $input = $(input);
    const prop = $input.data("prop");

    let value;

    if ($input.attr("type") === "checkbox") {
      value = $input.is(":checked") ? 1 : 0;
    } else if ($input.attr("type") === "number") {
      value = flt($input.val());
    } else {
      value = $input.val();
    }

    if (prop === "fields") {
      value = String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }

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

    const should_rerender_props =
      $input.attr("type") === "checkbox" ||
      input.tagName === "SELECT" ||
      prop.includes("split_settings.") ||
      ["source_type", "content_type", "show_title"].includes(prop);

    if (should_rerender_props) {
      this.render();
    } else {
      this.render_canvas();
    }
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

    if (checked && !element.columns.includes(fieldname)) {
      element.columns.push(fieldname);
    }

    if (!checked) {
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
    const split_element = this.state.elements.find(
      (el) => el.type === "items_table" && el.split_settings && el.split_settings.enabled
    );

    const body = split_element
      ? this.render_print_split_receipts(split_element)
      : `<div class="thermal-receipt">${this.render_print_elements(this.state.elements, "doc.items", {})}</div>`;

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

  render_print_split_receipts(split_element) {
    const s = split_element.split_settings || {};

    const customer_title = s.customer_receipt_title || "Customer Receipt";
    const waiter_title = s.waiter_receipt_title || "Waiter Receipt";
    const group_prefix = s.group_receipt_title_prefix || "Receipt for";
    const add_page_break = s.add_page_break_between_receipts ? "true" : "false";

    const customer_receipt = s.print_customer_receipt
      ? `
{% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
{% set ptb.has_previous = true %}
<div class="thermal-receipt">
  ${this.render_split_receipt_title(customer_title)}
  ${this.render_print_elements(this.state.elements, "doc.items", { mode: "customer" })}
</div>`
      : "";

    const waiter_receipt = s.print_waiter_receipt
      ? `
{% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
{% set ptb.has_previous = true %}
<div class="thermal-receipt">
  ${this.render_split_receipt_title(waiter_title)}
  ${this.render_print_elements(this.state.elements, "doc.items", { mode: "waiter" })}
</div>`
      : "";

    const group_receipts = s.print_group_receipts
      ? `
{% set item_groups = {} %}
{% for item in doc.items %}
  {% set group_name = frappe.db.get_value("Item Group", item.item_group, "item_group_name") if item.item_group else _("No Item Group") %}
  {% if group_name not in item_groups %}
    {% set _ = item_groups.update({group_name: []}) %}
  {% endif %}
  {% set _ = item_groups[group_name].append(item) %}
{% endfor %}

{% for group_name, group_items in item_groups.items() %}
  {% if ptb.has_previous and ${add_page_break} %}<div class="page-break"></div>{% endif %}
  {% set ptb.has_previous = true %}
  <div class="thermal-receipt">
    ${this.render_split_receipt_title(`${this.escape_html(group_prefix)} {{ group_name }}`, true)}
    ${this.render_print_elements(this.state.elements, "group_items", {
      mode: "group",
      include_totals: Boolean(s.include_totals_in_group_receipts),
      include_payments: Boolean(s.include_payments_in_group_receipts)
    })}
  </div>
{% endfor %}`
      : "";

    return `
{% set ptb = namespace(has_previous=false) %}
${customer_receipt}
${waiter_receipt}
${group_receipts}
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
    return (elements || [])
      .filter((element) => {
        if (context.mode === "group") {
          if (element.type === "payments" && !context.include_payments) return false;
          if ((element.type === "totals" || element.type === "taxes") && !context.include_totals) return false;
        }

        return true;
      })
      .map((element) => this.render_print_element(element, item_source, context))
      .join("\n");
  }

  render_print_element(element, item_source, context) {
    const style = this.get_print_style(element);

    if (element.type === "text" || element.type === "footer_note") {
      return `<div class="thermal-text" style="${style}">${this.escape_html(element.content || "")}</div>`;
    }

    if (element.type === "field") {
      const fieldname = this.safe_fieldname(element.fieldname || "");
      const label_html = this.render_label(element.label || fieldname, element.translate_label);

      return `
<div class="thermal-row" style="${style}">
  ${element.show_label ? `<span>${label_html}</span>` : ""}
  <span>{{ doc.${fieldname} or "" }}</span>
</div>`.trim();
    }

    if (element.type === "image") {
      return this.render_print_image(element);
    }

    if (element.type === "divider") {
      return `<div class="thermal-divider" style="border-top-style:${this.escape_attr(element.line_style || "dashed")};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${cint(element.height)}px;"></div>`;
    }

    if (element.type === "container") {
      const child_html = this.render_print_elements(element.children || [], item_source, context);
      const container_style = [
        `border:${cint(element.border_width)}px ${element.border_style || "solid"} ${element.border_color || "#000"}`,
        `border-radius:${cint(element.border_radius)}px`,
        `padding:${cint(element.padding)}px`,
        `background:${element.background_color || "#fff"}`,
        `margin-top:${cint(element.margin_top)}px`,
        `margin-bottom:${cint(element.margin_bottom)}px`
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

    if (element.type === "qr_code") {
      return this.render_print_qr_code(element);
    }

    return "";
  }

  render_print_details_table(element) {
    const rows = element.rows || [];
    const title = element.show_title
      ? `
      <tr>
        <td colspan="2" style="text-align:center;font-weight:700;background:${this.escape_attr(element.header_bg_color || "#f2f0f0")};">
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
          <td style="text-align:left;direction:ltr;">{{ doc.get_formatted("${fieldname}") or doc.${fieldname} or "" }}</td>
        </tr>
      `;
      })
      .join("");

    return `
<table class="thermal-table" style="
  font-size:${cint(element.font_size || 11)}px;
  border:${cint(element.border_width)}px ${element.border_style || "solid"} ${element.border_color || "#000"};
  border-radius:${cint(element.border_radius)}px;
  border-collapse:separate;
  overflow:hidden;
  margin-top:${cint(element.margin_top)}px;
  margin-bottom:${cint(element.margin_bottom)}px;
">
  ${title}
  <tbody>${body}</tbody>
</table>`.trim();
  }

  render_print_image(element) {
    const width = cint(element.width || 36);

    if (element.source_type === "company_logo") {
      return `
{% set company_logo = frappe.db.get_value("Company", doc.company, "company_logo") %}
{% if company_logo %}
<div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
  <img class="thermal-logo" src="{{ company_logo }}" style="width:${width}mm;">
</div>
{% endif %}`.trim();
    }

    const src = element.source_type === "url" ? element.image_url : element.file_url;

    if (!src) return "";

    return `
<div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
  <img class="thermal-logo" src="${this.escape_attr(src)}" style="width:${width}mm;">
</div>`.trim();
  }

  render_print_items_table(element, item_source) {
    const columns = element.columns || [];
    const labels = this.get_item_column_labels();
    const font_size = cint(element.font_size || 10);
    const header_bg = element.header_bg_color || "#f2f0f0";
    const header_text = element.header_text_color || "#000000";
    const header_border = element.header_border_color || "#000000";

    const header = element.show_header
      ? `
<thead style="background-color:${this.escape_attr(header_bg)}; color:${this.escape_attr(header_text)};">
  <tr>
    ${columns.map((c) => `<th style="border-color:${this.escape_attr(header_border)};">${this.render_label(labels[c] || c, true)}</th>`).join("\n    ")}
  </tr>
</thead>`
      : "";

    const cells = columns
      .map((c) => `<td>${this.get_item_cell_jinja(c, element)}</td>`)
      .join("\n      ");

    const remarks = element.show_item_remarks
      ? `
      {% if row.remarks %}
      <tr>
        <td colspan="${columns.length || 1}">#{{ row.remarks }}</td>
      </tr>
      {% endif %}`
      : "";

    return `
<table class="thermal-table" style="font-size:${font_size}px;">
  ${header}
  <tbody>
    {% for row in ${item_source || "doc.items"} %}
    <tr>
      ${cells}
    </tr>
    ${remarks}
    {% endfor %}
  </tbody>
</table>`.trim();
  }

  get_item_cell_jinja(column, element) {
    if (column === "rate") {
      const rate_field = element.rate_field === "price_list_rate" ? "price_list_rate" : "rate";
      return `{{ "{:,.1f}".format(row.${rate_field}) if row.${rate_field} else "-" }}`;
    }

    if (column === "amount") {
      if (element.amount_mode === "price_list_rate_times_qty") {
        return `{{ "{:,.1f}".format((row.price_list_rate or 0) * (row.qty or 0)) }}`;
      }

      return `{{ "{:,.1f}".format(row.amount) if row.amount else "-" }}`;
    }

    if (column === "qty") {
      return `{{ "{:,.1f}".format(row.qty) if row.qty else "-" }}`;
    }

    return `{{ row.${this.safe_fieldname(column)} or "" }}`;
  }

  render_print_totals(element, item_source) {
    const font_size = cint(element.font_size || 11);

    if (item_source === "group_items") {
      return `
{% set ns = namespace(total=0) %}
{% for row in group_items %}
  {% set ns.total = ns.total + ((row.price_list_rate or row.rate or 0) * (row.qty or 0)) %}
{% endfor %}
<div class="thermal-row" style="font-size:${font_size}px; font-weight:700;">
  <span>{{ _("Total") }}</span>
  <span>{{ "{:,.0f}".format(ns.total) }}</span>
</div>`.trim();
    }

    const rows = [];

    if (element.show_net_total) rows.push(["Net Total", "{{ doc.net_total }} {{ doc.currency }}"]);
    if (element.show_taxes) rows.push(["Taxes and Charges", "{{ doc.total_taxes_and_charges }} {{ doc.currency }}"]);
    if (element.show_grand_total) rows.push(["Grand Total", "{{ doc.grand_total }} {{ doc.currency }}"]);
    if (element.show_paid_amount) rows.push(["Paid Amount", "{{ doc.paid_amount }} {{ doc.currency }}"]);
    if (element.show_change_amount) rows.push(["Change Amount", "{{ doc.change_amount }} {{ doc.currency }}"]);

    return rows
      .map(([label, value]) => `
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>${this.render_label(label, true)}</span>
  <span>${value}</span>
</div>`.trim())
      .join("\n");
  }

  render_print_payments(element) {
    const font_size = cint(element.font_size || 11);

    return `
${element.show_header ? `<div class="thermal-text" style="font-weight:700; font-size:${font_size}px;">{{ _("Payments") }}</div>` : ""}
{% for payment in doc.payments %}
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>{{ payment.mode_of_payment or "" }}</span>
  <span>{{ payment.amount }} {{ doc.currency }}</span>
</div>
{% endfor %}`.trim();
  }

  render_print_taxes(element) {
    const font_size = cint(element.font_size || 10);

    return `
${element.show_header ? `<div class="thermal-text" style="font-weight:700; font-size:${font_size}px;">{{ _("Taxes and Charges") }}</div>` : ""}
{% for tax in doc.taxes %}
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>{{ tax.description or tax.account_head or "" }}</span>
  <span>{{ tax.tax_amount }} {{ doc.currency }}</span>
</div>
{% endfor %}`.trim();
  }

  render_print_qr_code(element) {
    const width = cint(element.width || 26);
    const qr_value = this.get_qr_value_jinja(element);

    return `
{% set ptb_qr_value = ${qr_value} %}
{% set ptb_qr_data_uri = frappe.get_attr("pos_next.api.thermal_print.get_qr_data_uri")(ptb_qr_value) %}
{% if ptb_qr_data_uri %}
<div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
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
      return `doc.${this.safe_fieldname(element.fieldname || "name")} or ""`;
    }

    if (element.content_type === "multiple_fields") {
      const fields = (element.fields || ["name"]).map((field) => `doc.${this.safe_fieldname(field)} or ""`);
      return `[${fields.join(", ")}] | join(" | ")`;
    }

    if (element.content_type === "custom_jinja") {
      return element.custom_jinja || "doc.name";
    }

    return `doc.name or ""`;
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
      `font-size:${cint(element.font_size)}px`,
      `font-weight:${element.bold ? "700" : "400"}`,
      `margin-top:${cint(element.margin_top)}px`,
      `margin-bottom:${cint(element.margin_bottom)}px`
    ].join(";");
  }

  show_generated_code(html) {
    this.$root.find("#ptb-generated-code").val(html);
    this.$root.find("#ptb-code-modal").removeClass("ptb-hidden");
  }

  copy_generated_code() {
    const code = this.$root.find("#ptb-generated-code").val();

    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
      frappe.show_alert({ message: __("Code copied"), indicator: "green" });
      return;
    }

    const textarea = this.$root.find("#ptb-generated-code")[0];
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