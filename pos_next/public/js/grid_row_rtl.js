(function () {
	function on_ready(fn) {
		if (window.frappe && window.frappe.ready) {
			window.frappe.ready(fn);
		} else if (window.jQuery) {
			window.jQuery(fn);
		} else {
			setTimeout(() => on_ready(fn), 50);
		}
	}

	function is_rtl(element) {
		try {
			const dir_attr =
				document?.documentElement?.getAttribute("dir") || document?.body?.getAttribute("dir");
			if (dir_attr && dir_attr.toLowerCase() === "rtl") return true;
			if (!element) return document?.dir === "rtl";
			return window.getComputedStyle(element).direction === "rtl";
		} catch (e) {
			return false;
		}
	}

	function fix_awesomplete_position(input_el) {
		const $ = window.jQuery;
		if (!$ || !input_el) return;

		const $input = $(input_el);
		const $grid_field = $input.closest(".grid-field");
		if (!$grid_field.length) return;
		if (!is_rtl($grid_field.get(0))) return;

		const rect = input_el.getBoundingClientRect();
		const grid_offset = $grid_field.offset();
		if (!grid_offset) return;

		const $wrapper = $grid_field
			.children("div.awesomplete")
			.filter(function () {
				return $(this).children("ul").length;
			})
			.last();

		if (!$wrapper.length) return;

		const right_difference = grid_offset.left + $grid_field.outerWidth() - rect.right;
		const top_difference = rect.top - grid_offset.top + 30;

		$wrapper.css({
			position: "absolute",
			top: `${top_difference + 10}px`,
			right: `${right_difference}px`,
			left: "auto",
			minWidth: "250px",
			width: `${rect.width}px`,
		});
	}

	on_ready(() => {
		const $ = window.jQuery;
		if (!$) return;

		$(document).on(
			"focusin",
			".grid-static-col input, .grid-static-col textarea",
			function () {
				const input_el = this;
				setTimeout(() => fix_awesomplete_position(input_el), 0);
			}
		);
	});
})();
