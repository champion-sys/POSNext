<template>
	<Dialog v-model="show" :options="{ title: __('Keyboard Shortcuts'), size: 'lg' }">
		<template #body-content>
			<div class="flex flex-col gap-4">
				<p class="text-xs text-gray-600">
					{{ __('Tip: Press “?” (Shift + /) anytime to open this list.') }}
				</p>

				<div class="space-y-3">
					<div
						v-for="section in sections"
						:key="section.title"
						class="border border-gray-200 rounded-md"
					>
						<div class="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-700">
							{{ section.title }}
						</div>
						<div class="p-3">
							<ul class="space-y-2">
								<li
									v-for="item in section.items"
									:key="item.keys.join('|') + item.action"
									class="flex items-start justify-between gap-3"
								>
									<div class="min-w-0">
										<div class="text-sm font-medium text-gray-900">{{ item.action }}</div>
										<div v-if="item.usage" class="text-xs text-gray-500">{{ item.usage }}</div>
									</div>
									<div class="flex flex-wrap gap-1 flex-shrink-0 justify-end">
										<template v-for="(k, idx) in item.keys" :key="idx">
											<kbd class="px-2 py-1 text-xs font-mono bg-gray-900 text-white rounded">
												{{ k }}
											</kbd>
											<span
												v-if="item.join && idx < item.keys.length - 1"
												class="px-0.5 text-xs text-gray-400"
											>
												{{ item.join }}
											</span>
										</template>
									</div>
								</li>
							</ul>
						</div>
					</div>
				</div>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { computed } from "vue"

const props = defineProps({
	modelValue: {
		type: Boolean,
		default: false,
	},
})

const emit = defineEmits(["update:modelValue"])

const show = computed({
	get: () => props.modelValue,
	set: (val) => emit("update:modelValue", val),
})

const sections = computed(() => [
	{
		title: __("General"),
		items: [
			{
				action: __("Open keyboard shortcuts"),
				keys: ["?"],
				usage: __("Press Shift + /."),
			},
			{
				action: __("Focus Quick Actions"),
				keys: ["Alt", "Q"],
				join: "+",
				usage: __("Focuses the empty cart's quick action buttons (also works with F4)."),
			},
			{
				action: __("View Shift"),
				keys: ["Alt", "W"],
				join: "+",
				usage: __("Opens the current shift details when the cart is empty."),
			},
			{
				action: __("Draft Invoices"),
				keys: ["Alt", "D"],
				join: "+",
				usage: __("Opens draft invoices dialog when the cart is empty."),
			},
			{
				action: __("Invoice History"),
				keys: ["Alt", "H"],
				join: "+",
				usage: __("Opens invoice history dialog when the cart is empty."),
			},
			{
				action: __("Return Invoice"),
				keys: ["Alt", "R"],
				join: "+",
				usage: __("Opens return invoice dialog when the cart is empty."),
			},
		],
	},
	{
		title: __("Items panel"),
		items: [
			{
				action: __("Focus item search"),
				keys: ["Alt", "S"],
				join: "+",
				usage: __("Moves cursor to the item search field (also works with F2)."),
			},
			{
				action: __("Focus items list"),
				keys: ["Alt", "I"],
				join: "+",
				usage: __("Highlights the first item so you can navigate with arrow keys (also works with F3)."),
			},
			{
				action: __("Navigate items"),
				keys: ["↑", "↓", "←", "→"],
				usage: __("Moves focus across items (grid/list)."),
			},
			{
				action: __("Add focused item"),
				keys: ["Enter"],
				usage: __("Adds the currently focused item to the cart."),
			},
			{
				action: __("Increase/decrease quantity"),
				keys: ["+", "-"],
				join: "/",
				usage: __("Adjusts quantity for the currently focused item."),
			},
			{
				action: __("Set quantity"),
				keys: ["1–9"],
				usage: __("Sets quantity for the focused item to that number."),
			},
			{
				action: __("Remove item"),
				keys: ["0"],
				usage: __("Removes the focused item from the cart."),
			},
			{
				action: __("Clear item focus"),
				keys: ["Esc"],
				usage: __("Stops item navigation and returns focus to search."),
			},
		],
	},
	{
		title: __("Filters & view"),
		items: [
			{
				action: __("Previous/next item group"),
				keys: ["[", "]"],
				join: "/",
				usage: __("Switches item group filter when not typing in search."),
			},
			{
				action: __("Toggle grid/list"),
				keys: ["Alt", "V"],
				join: "+",
				usage: __("Switches between grid and list view."),
			},
			{
				action: __("Toggle sort"),
				keys: ["Alt", "O"],
				join: "+",
				usage: __("Opens/closes sort options."),
			},
		],
	},
	{
		title: __("Scanner & auto-add"),
		items: [
			{
				action: __("Toggle barcode scanner"),
				keys: ["Alt", "B"],
				join: "+",
				usage: __("Enables or disables barcode scanner input mode."),
			},
			{
				action: __("Toggle auto-add"),
				keys: ["Alt", "A"],
				join: "+",
				usage: __("Automatically adds matched item from search/scans."),
			},
		],
	},
	{
		title: __("Function keys"),
		items: [
			{
				action: __("Focus item search"),
				keys: ["F2"],
				usage: __("Alternative to Alt+S."),
			},
			{
				action: __("Focus items list"),
				keys: ["F3"],
				usage: __("Alternative to Alt+I."),
			},
			{
				action: __("Focus Quick Actions"),
				keys: ["F4"],
				usage: __("Alternative to Alt+Q."),
			},
		],
	},
])
</script>
