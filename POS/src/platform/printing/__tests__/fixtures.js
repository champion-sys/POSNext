/**
 * Templates and a sale for the print template tests, and for the real-browser check
 * that draws them.
 */

/** A 64px PNG, as the server sends company logos */
export const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABJklEQVR42u2bOxbDIAwEOQQH9s1JlTbmsytQmEKt/XYk+8FKKq21cnOEvajW2kYiPYBRwbuAHC/cDSKNcBeIdMLVIEKFl+fpikgQVvG9glVAQgBECp8BYQWwS/goCAuAE4SPgJACOFG8CkJq8QoI6cWvQggX/5qRYAjDAByilTAkAFTiZed1I4RuADuEr4CYBrCafbuBIa4CafbDXBxhFciyH+7liapAkv1thqagCmzZjzA+FFVgy36U87NaBQBYAXCKLb4MYPb7zwzg+0zb3/8kAL+qwFL+OzpDAAAAAAAAAAAAIA7A3x+ErjoKX38Z4joMACwxTFFscRojtMZojtIeZ0CCERmGpBiTY1CSUVmGpRmXZ2GClRmWplibY3GS1VmWp2+ID68KoIc1InJdAAAAAElFTkSuQmCC"

export const bundle = {
	templates: [
		{
			name: "PT-0001",
			template_name: "Receipt 80mm",
			paper: "80mm",
			copies: 2,
			modified: "2026-11-08 10:00:00",
			css: `
				.receipt { padding: 2mm 3mm; font-size: 12px; }
				.center { text-align: center; }
				.logo { width: 18mm; }
				h1 { font-size: 16px; margin: 1mm 0; }
				table { width: 100%; border-collapse: collapse; }
				td, th { padding: 1px 0; text-align: start; }
				td.num, th.num { text-align: end; }
				.rule { border-top: 1px dashed #000; margin: 2mm 0; }
				.grand td { font-size: 15px; font-weight: bold; }
				.qr { width: 30mm; }
			`,
			html: `<div class="receipt">
	<div class="center">
		{% if company.logo %}<img class="logo" src="{{ company.logo }}">{% endif %}
		<h1>{{ company.company_name }}</h1>
		<div>{{ company.address }}</div>
		<div>{{ _("VAT No") }}: {{ company.tax_id }}</div>
		<div>{{ _("Simplified Tax Invoice") }} - Simplified Tax Invoice</div>
		{% if print.reprint %}<div>{{ _("Reprint") }}</div>{% endif %}
	</div>
	<div class="rule"></div>
	<div>{{ _("Invoice") }}: {{ doc.name }}</div>
	<div>{{ _("Date") }}: {{ format_date(doc.posting_date) }} {{ doc.posting_time }}</div>
	<div>{{ _("Cashier") }}: {{ cashier.full_name }}</div>
	<div>{{ _("Customer") }}: {{ customer.customer_name }}</div>
	<div class="rule"></div>
	<table>
		<tr><th>{{ _("Item") }}</th><th class="num">{{ _("Qty") }}</th><th class="num">{{ _("Amount") }}</th></tr>
		{% for item in doc.items %}
		<tr><td>{{ item.item_name }}</td><td class="num">{{ format_number(item.qty) }}</td><td class="num">{{ format_currency(item.amount, doc.currency) }}</td></tr>
		{% endfor %}
	</table>
	<div class="rule"></div>
	<table>
		<tr><td>{{ _("Net Total") }}</td><td class="num">{{ format_currency(doc.net_total, doc.currency) }}</td></tr>
		{% for tax in doc.taxes %}
		<tr class="tax"><td>{{ tax.description }} ({{ tax.rate }}%)</td><td class="num">{{ format_currency(tax.tax_amount, doc.currency) }}</td></tr>
		{% endfor %}
		<tr class="grand"><td>{{ _("Grand Total") }}</td><td class="num">{{ format_currency(doc.grand_total, doc.currency) }}</td></tr>
	</table>
	<div>{{ money_in_words(doc.grand_total, doc.currency) }}</div>
	{% for payment in doc.payments %}<div>{{ payment.mode_of_payment }}: {{ format_currency(payment.amount, doc.currency) }}</div>{% endfor %}
	<div class="center"><img class="qr" src="{{ qr(doc.name) }}"></div>
	<div class="center">{{ _("Thank you") }} - شكراً لزيارتكم</div>
</div>`,
		},
		{
			name: "PT-0002",
			template_name: "Kitchen 58mm",
			paper: "58mm",
			copies: 1,
			modified: "2026-11-08 10:00:00",
			css: ".ticket { padding: 2mm; font-size: 13px; } .big { font-size: 18px; font-weight: bold; }",
			html: `<div class="ticket">
	<div class="big">{{ doc.pos_order_type or "Order" }} #{{ doc.name }}</div>
	{% for item in doc.items %}<div>{{ item.qty }} x {{ item.item_name }}</div>{% endfor %}
</div>`,
		},
		{
			name: "PT-0003",
			template_name: "Tax Invoice A4",
			paper: "A4",
			copies: 1,
			modified: "2026-11-08 10:00:00",
			css: "table.items { width: 100%; border-collapse: collapse } table.items td, table.items th { border: 1px solid #000; padding: 4px }",
			html: `<h2>{{ company.company_name }}</h2>
<p>{{ customer.customer_name }} ({{ customer.tax_id }})</p>
<table class="items">
	<tr><th>#</th><th>Item</th><th>Rate</th><th>Amount</th></tr>
	{% for item in doc.items %}<tr><td>{{ item.idx }}</td><td>{{ item.item_name }}</td><td>{{ format_currency(item.rate, doc.currency) }}</td><td>{{ format_currency(item.amount, doc.currency) }}</td></tr>{% endfor %}
</table>
<p>{{ money_in_words(doc.grand_total, doc.currency) }}</p>`,
		},
	],
	default_template: "PT-0001",
	company: {
		name: "Sanad Trading",
		company_name: "شركة سند التجارية",
		address: "الرياض، طريق الملك فهد",
		tax_id: "300000000000003",
		phone: "+966 11 000 0000",
		email: "info@example.com",
		website: "example.com",
		logo: LOGO,
		currency: "SAR",
	},
	pos_profile: { name: "Main POS", warehouse: "Stores - S", currency: "SAR", company: "Sanad Trading" },
	modified: "2026-11-08 10:00:00",
}

/** A sale as the checkout queues it offline */
export const queuedSale = {
	offline_id: "pos_offline_7f3a",
	doctype: "Sales Invoice",
	pos_profile: "Main POS",
	customer: "CUST-0001",
	posting_date: "2026-11-08",
	posting_time: "14:05:09",
	pos_order_type: "Takeaway",
	discount_amount: 0,
	remarks: "",
	items: [
		{ item_code: "TEA", item_name: "شاي أخضر", qty: 2, rate: 10, price_list_rate: 10, amount: 20, uom: "Nos" },
		{ item_code: "CAKE", item_name: "Cheese Cake", qty: 1, rate: 15, price_list_rate: 15, amount: 15, uom: "Nos" },
	],
	payments: [
		{ mode_of_payment: "Cash", amount: 40.25 },
		{ mode_of_payment: "Card", amount: 0 },
	],
}

export const saleTotals = {
	grandTotal: 40.25,
	roundedTotal: 40.25,
	roundingAdjustment: 0,
	totalTax: 5.25,
	subtotal: 35,
	totalDiscount: 0,
	taxLines: [
		{ description: "ضريبة القيمة المضافة VAT", account_head: "VAT - S", charge_type: "On Net Total", rate: 15, included_in_print_rate: 0, tax_amount: 5.25 },
	],
}
