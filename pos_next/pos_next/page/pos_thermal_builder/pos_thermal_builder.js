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

    this.state = {
      paper_size: 80,
      active_id: null,
      elements: []
    };

    this.dragged_id = null;
    this.pos_fields = this.get_default_pos_fields();
    this.sample_doc = this.get_sample_doc();

    this.bind();
    this.apply_translations();
    this.load_pos_invoice_meta();
    this.render();
  }

  bind() {
    this.$root.on("click", ".ptb-add", (e) => {
      const type = $(e.currentTarget).data("type");
      this.add_element(type);
    });

    this.$root.on("click", ".ptb-add-field", (e) => {
      const $btn = $(e.currentTarget);

      this.add_element("field", {
        fieldname: $btn.data("fieldname"),
        label: $btn.data("field-label"),
        show_label: true
      });
    });

    this.$root.on("change", "#ptb-paper-size", (e) => {
      this.state.paper_size = cint(e.target.value);
      this.render_canvas();
    });

    this.$root.on("click", ".ptb-canvas-element", (e) => {
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
      this.dragged_id = $(e.currentTarget).data("id");
      e.originalEvent.dataTransfer.effectAllowed = "move";
    });

    this.$root.on("dragover", ".ptb-canvas-element", (e) => {
      e.preventDefault();
    });

    this.$root.on("drop", ".ptb-canvas-element", (e) => {
      e.preventDefault();

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

    this.$root.on("click", "#ptb-save-layout", () => this.save_layout());
    this.$root.on("click", "#ptb-load-layout", () => this.load_layout());
    this.$root.on("click", "#ptb-clear-layout", () => this.clear_layout());

    this.$root.on("click", "#ptb-generate-html", () => {
      const html = this.generate_print_format_html();
      this.show_generated_code(html);
    });

    this.$root.on("click", "#ptb-close-code", () => {
      this.$root.find("#ptb-code-modal").addClass("ptb-hidden");
    });

    this.$root.on("click", "#ptb-copy-code", () => this.copy_generated_code());
    this.$root.on("click", "#ptb-create-print-format", () => this.create_print_format());
  }

  apply_translations() {
    this.$root.find("[data-i18n]").each((_, el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = __(key);
    });

    this.$root.find("[data-i18n-title]").each((_, el) => {
      const key = el.getAttribute("data-i18n-title");
      el.setAttribute("title", __(key));
    });

    this.$root.find("[data-i18n-placeholder]").each((_, el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.setAttribute("placeholder", __(key));
    });

    const lang = ((frappe.boot && frappe.boot.lang) || "en").split("-")[0];
    const rtl_languages = ["ar", "fa", "he", "ur"];
    const direction = rtl_languages.includes(lang) ? "rtl" : "ltr";

    this.$root.find(".ptb-shell").attr("dir", direction);
    this.$root.find("#ptb-code-modal").attr("dir", direction);
  }

  load_pos_invoice_meta() {
    if (!window.frappe || !frappe.model || !frappe.model.with_doctype) return;

    frappe.model.with_doctype("POS Invoice", () => {
      const meta = frappe.get_meta("POS Invoice");

      if (!meta || !meta.fields) return;

      const excluded_fieldtypes = [
        "Section Break",
        "Column Break",
        "Tab Break",
        "Table",
        "Table MultiSelect",
        "HTML",
        "Button",
        "Fold"
      ];

      const meta_fields = meta.fields
        .filter((df) => df.fieldname && !excluded_fieldtypes.includes(df.fieldtype))
        .map((df) => ({
          fieldname: df.fieldname,
          label: df.label || df.fieldname,
          fieldtype: df.fieldtype
        }));

      const important_fields = this.get_default_pos_fields();
      const merged = [...important_fields];

      meta_fields.forEach((field) => {
        if (!merged.find((x) => x.fieldname === field.fieldname)) {
          merged.push(field);
        }
      });

      this.pos_fields = merged;
      this.render_props();
    });
  }

  get_default_pos_fields() {
    return [
      { fieldname: "name", label: "Invoice Number" },
      { fieldname: "company", label: "Company" },
      { fieldname: "customer", label: "Customer" },
      { fieldname: "posting_date", label: "Posting Date" },
      { fieldname: "posting_time", label: "Posting Time" },
      { fieldname: "pos_profile", label: "POS Profile" },
      { fieldname: "owner", label: "User" },
      { fieldname: "currency", label: "Currency" },
      { fieldname: "total_qty", label: "Total Quantity" },
      { fieldname: "net_total", label: "Net Total" },
      { fieldname: "total_taxes_and_charges", label: "Taxes and Charges" },
      { fieldname: "grand_total", label: "Grand Total" },
      { fieldname: "rounded_total", label: "Rounded Total" },
      { fieldname: "paid_amount", label: "Paid Amount" },
      { fieldname: "change_amount", label: "Change Amount" },
      { fieldname: "discount_amount", label: "Discount Amount" },
      { fieldname: "additional_discount_percentage", label: "Additional Discount Percentage" }
    ];
  }

  get_sample_doc() {
    return {
      name: "ACC-PSINV-2026-00001",
      company: "Sanad Digital",
      customer: "Cash Customer",
      posting_date: "2026-06-29",
      posting_time: "14:30:00",
      pos_profile: "Main Branch - Cashier 1",
      owner: "cashier@example.com",
      currency: "SAR",
      total_qty: 3,
      net_total: 125.0,
      total_taxes_and_charges: 18.75,
      grand_total: 143.75,
      rounded_total: 144.0,
      paid_amount: 150.0,
      change_amount: 6.0,
      discount_amount: 0,
      items: [
        {
          item_code: "ITEM-001",
          item_name: "Product One",
          qty: 1,
          uom: "Nos",
          rate: 25,
          amount: 25
        },
        {
          item_code: "ITEM-002",
          item_name: "Product Two",
          qty: 2,
          uom: "Box",
          rate: 50,
          amount: 100
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

  add_element(type, overrides = {}) {
    const element = Object.assign(this.get_default_element(type), overrides);

    this.state.elements.push(element);
    this.state.active_id = element.id;

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
        align: "right"
      },
      image: {
        src: "",
        width: 42,
        align: "center"
      },
      divider: {
        line_style: "dashed"
      },
      spacer: {
        height: 8
      },
      items_table: {
        show_header: true,
        columns: ["item_name", "qty", "rate", "amount"],
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
    this.state.active_id = id;
    this.render();
  }

  get_active_element() {
    return this.state.elements.find((el) => el.id === this.state.active_id);
  }

  delete_element(id) {
    this.state.elements = this.state.elements.filter((el) => el.id !== id);

    if (this.state.active_id === id) {
      this.state.active_id = this.state.elements[0]?.id || null;
    }

    this.render();
  }

  reorder_element(source_id, target_id) {
    if (!source_id || !target_id || source_id === target_id) return;

    const source_index = this.state.elements.findIndex((el) => el.id === source_id);
    const target_index = this.state.elements.findIndex((el) => el.id === target_id);

    if (source_index < 0 || target_index < 0) return;

    const [source] = this.state.elements.splice(source_index, 1);
    this.state.elements.splice(target_index, 0, source);

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
      .addClass(`ptb-paper-${this.state.paper_size}`);

    this.$root.find("#ptb-paper-size").val(String(this.state.paper_size));

    if (!this.state.elements.length) {
      $paper.html(`<div class="ptb-empty">${__("Start by adding elements from the elements panel")}</div>`);
      return;
    }

    const html = this.state.elements
      .map((element) => this.render_canvas_element(element))
      .join("");

    $paper.html(html);
  }

  render_canvas_element(element) {
    const active = element.id === this.state.active_id ? "ptb-active" : "";
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

    if (element.type === "text") {
      return `<div class="ptb-receipt-text" style="${style}">${this.escape_html(element.content)}</div>`;
    }

    if (element.type === "field") {
      const value = this.sample_doc[element.fieldname] ?? "";

      return `
        <div class="ptb-receipt-row" style="${style}">
          ${element.show_label ? `<span>${this.escape_html(__(element.label || element.fieldname))}</span>` : ""}
          <span>${this.escape_html(value)}</span>
        </div>
      `;
    }

    if (element.type === "image") {
      if (!element.src) {
        return `<div class="ptb-image-placeholder" style="${style}">${__("Image or Logo")}</div>`;
      }

      return `
        <div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
          <img class="ptb-image-preview" src="${this.escape_attr(element.src)}" style="width:${cint(element.width)}mm;">
        </div>
      `;
    }

    if (element.type === "divider") {
      return `<div class="ptb-divider" style="border-top-style:${this.escape_attr(element.line_style || "dashed")};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${cint(element.height)}px;"></div>`;
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

    return "";
  }

  render_preview_items_table(element) {
    const columns = element.columns || [];
    const headers = this.get_item_column_labels();

    const thead = element.show_header
      ? `<thead><tr>${columns.map((c) => `<th>${this.escape_html(__(headers[c] || c))}</th>`).join("")}</tr></thead>`
      : "";

    const rows = this.sample_doc.items
      .map((row) => {
        return `<tr>${columns.map((c) => `<td>${this.escape_html(row[c] ?? "")}</td>`).join("")}</tr>`;
      })
      .join("");

    return `
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
          <span>${this.escape_html(__(label))}</span>
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

  get_preview_style(element) {
    return [
      `text-align:${this.css_align(element.align)}`,
      `font-size:${cint(element.font_size)}px`,
      `font-weight:${element.bold ? "700" : "400"}`,
      `margin-top:${cint(element.margin_top)}px`,
      `margin-bottom:${cint(element.margin_bottom)}px`
    ].join(";");
  }

  css_align(value) {
    if (value === "right") return "right";
    if (value === "left") return "left";
    return "center";
  }

  render_props() {
    const element = this.get_active_element();
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

      ${this.input("label", __("Element Name"), element.label)}
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

    if (element.type === "text") {
      html += `
        <div class="ptb-section-label">${__("Text Properties")}</div>
        ${this.textarea("content", __("Text"), element.content)}
      `;
    }

    if (element.type === "field") {
      html += `
        <div class="ptb-section-label">${__("Field Properties")}</div>
        ${this.select(
          "fieldname",
          __("Field"),
          element.fieldname,
          this.pos_fields.map((f) => [f.fieldname, `${__(f.label)} (${f.fieldname})`])
        )}
        ${this.input("label", __("Field Label"), element.label)}
        ${this.checkbox("show_label", __("Show Field Label"), element.show_label)}
      `;
    }

    if (element.type === "image") {
      html += `
        <div class="ptb-section-label">${__("Image Properties")}</div>
        ${this.input("src", __("Image URL"), element.src || "")}
        ${this.number("width", __("Width in mm"), element.width)}
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
      html += `
        <div class="ptb-section-label">${__("Items Table Columns")}</div>
        ${this.checkbox("show_header", __("Show Table Header"), element.show_header)}
        ${this.item_columns_html(element)}
      `;
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

    return html;
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
          <span>${this.escape_html(__(labels[fieldname]))}</span>
        </label>
      `)
      .join("");
  }

  get_item_column_labels() {
    return {
      item_code: "Item Code",
      item_name: "Item Name",
      qty: "Quantity",
      uom: "UOM",
      rate: "Rate",
      amount: "Amount"
    };
  }

  update_active_from_input(input) {
    const element = this.get_active_element();

    if (!element) return;

    const $input = $(input);
    const prop = $input.data("prop");

    let value;

    if ($input.attr("type") === "checkbox") {
      value = $input.is(":checked");
    } else if ($input.attr("type") === "number") {
      value = flt($input.val());
    } else {
      value = $input.val();
    }

    const old_fieldname = element.fieldname;
    element[prop] = value;

    if (element.type === "field" && prop === "fieldname") {
      const field = this.pos_fields.find((f) => f.fieldname === value);

      if (field && (!element.label || element.label === old_fieldname)) {
        element.label = field.label;
      }
    }

    this.render_canvas();
  }

  update_table_columns(input) {
    const element = this.get_active_element();

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

  save_layout() {
    const key = this.get_local_storage_key();
    localStorage.setItem(key, JSON.stringify(this.state));

    frappe.show_alert({
      message: __("Layout saved locally"),
      indicator: "green"
    });
  }

  load_layout() {
    const key = this.get_local_storage_key();
    const raw = localStorage.getItem(key);

    if (!raw) {
      frappe.show_alert({
        message: __("No saved layout found"),
        indicator: "orange"
      });
      return;
    }

    try {
      this.state = JSON.parse(raw);
      this.render();

      frappe.show_alert({
        message: __("Layout loaded"),
        indicator: "green"
      });
    } catch (e) {
      frappe.show_alert({
        message: __("Unable to load layout"),
        indicator: "red"
      });
    }
  }

  clear_layout() {
    frappe.confirm(__("Are you sure you want to clear the layout?"), () => {
      this.state.elements = [];
      this.state.active_id = null;
      this.render();
    });
  }

  get_local_storage_key() {
    const site = frappe.boot?.sitename || window.location.host || "default";
    return `pos_thermal_builder_layout_${site}`;
  }

  generate_print_format_html() {
    const paper = this.state.paper_size;

    const body = this.state.elements
      .map((element) => this.render_print_element(element))
      .join("\n");

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
  border-bottom: 1px dashed #000;
  padding: 3px 2px;
  vertical-align: top;
}

.thermal-table th {
  font-weight: 700;
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

@media print {
  body {
    margin: 0;
    padding: 0;
  }
}
</style>

<div class="thermal-receipt">
${body}
</div>
`.trim();
  }

  render_print_element(element) {
    const style = this.get_print_style(element);

    if (element.type === "text") {
      return `<div class="thermal-text" style="${style}">${this.escape_html(element.content || "")}</div>`;
    }

    if (element.type === "field") {
      const fieldname = this.escape_html(element.fieldname || "");
      const label = this.escape_html(element.label || fieldname);

      return `
<div class="thermal-row" style="${style}">
  ${element.show_label ? `<span>{{ _("${label}") }}</span>` : ""}
  <span>{{ doc.${fieldname} or "" }}</span>
</div>`.trim();
    }

    if (element.type === "image") {
      const width = cint(element.width || 42);

      if (element.src) {
        return `
<div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
  <img class="thermal-logo" src="${this.escape_attr(element.src)}" style="width:${width}mm;">
</div>`.trim();
      }

      return `
{% set company_logo = frappe.db.get_value("Company", doc.company, "company_logo") %}
{% if company_logo %}
<div style="text-align:${this.css_align(element.align)}; margin:${cint(element.margin_top)}px 0 ${cint(element.margin_bottom)}px;">
  <img class="thermal-logo" src="{{ company_logo }}" style="width:${width}mm;">
</div>
{% endif %}`.trim();
    }

    if (element.type === "divider") {
      return `<div class="thermal-divider" style="border-top-style:${this.escape_attr(element.line_style || "dashed")};"></div>`;
    }

    if (element.type === "spacer") {
      return `<div style="height:${cint(element.height)}px;"></div>`;
    }

    if (element.type === "items_table") {
      return this.render_print_items_table(element);
    }

    if (element.type === "totals") {
      return this.render_print_totals(element);
    }

    if (element.type === "payments") {
      return this.render_print_payments(element);
    }

    if (element.type === "taxes") {
      return this.render_print_taxes(element);
    }

    return "";
  }

  render_print_items_table(element) {
    const columns = element.columns || [];
    const labels = this.get_item_column_labels();
    const font_size = cint(element.font_size || 10);

    const header = element.show_header
      ? `
<thead>
  <tr>
    ${columns.map((c) => `<th>{{ _("${this.escape_html(labels[c] || c)}") }}</th>`).join("\n    ")}
  </tr>
</thead>`
      : "";

    const cells = columns
      .map((c) => {
        if (["qty", "rate", "amount"].includes(c)) {
          return `<td>{{ row.${c} }}</td>`;
        }

        return `<td>{{ row.${c} or "" }}</td>`;
      })
      .join("\n      ");

    return `
<table class="thermal-table" style="font-size:${font_size}px;">
  ${header}
  <tbody>
    {% for row in doc.items %}
    <tr>
      ${cells}
    </tr>
    {% endfor %}
  </tbody>
</table>`.trim();
  }

  render_print_totals(element) {
    const font_size = cint(element.font_size || 11);
    const rows = [];

    if (element.show_net_total) {
      rows.push(["Net Total", "{{ doc.net_total }} {{ doc.currency }}"]);
    }

    if (element.show_taxes) {
      rows.push(["Taxes and Charges", "{{ doc.total_taxes_and_charges }} {{ doc.currency }}"]);
    }

    if (element.show_grand_total) {
      rows.push(["Grand Total", "{{ doc.grand_total }} {{ doc.currency }}"]);
    }

    if (element.show_paid_amount) {
      rows.push(["Paid Amount", "{{ doc.paid_amount }} {{ doc.currency }}"]);
    }

    if (element.show_change_amount) {
      rows.push(["Change Amount", "{{ doc.change_amount }} {{ doc.currency }}"]);
    }

    return rows
      .map(([label, value]) => `
<div class="thermal-row" style="font-size:${font_size}px;">
  <span>{{ _("${this.escape_html(label)}") }}</span>
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

      frappe.show_alert({
        message: __("Code copied"),
        indicator: "green"
      });

      return;
    }

    const textarea = this.$root.find("#ptb-generated-code")[0];
    textarea.select();
    document.execCommand("copy");

    frappe.show_alert({
      message: __("Code copied"),
      indicator: "green"
    });
  }

  create_print_format() {
    const html = this.$root.find("#ptb-generated-code").val();

    frappe.prompt(
      [
        {
          fieldname: "format_name",
          label: __("Print Format Name"),
          fieldtype: "Data",
          reqd: 1,
          default: `POS Thermal Receipt ${this.state.paper_size}mm`
        }
      ],
      (values) => {
        frappe.call({
          method: "frappe.client.insert",
          args: {
            doc: {
              doctype: "Print Format",
              name: values.format_name,
              doc_type: "POS Invoice",
              print_format_type: "Jinja",
              custom_format: 1,
              disabled: 0,
              html: html
            }
          },
          callback: () => {
            frappe.show_alert({
              message: __("Print Format created successfully"),
              indicator: "green"
            });
          }
        });
      },
      __("Create Print Format"),
      __("Create")
    );
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
}