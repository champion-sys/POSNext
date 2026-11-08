<template>
	<div class="flex flex-col border-t border-black divide-y divide-gray-200">
		<div
			v-for="(item, index) in items"
			:key="item.item_code + '-' + (item.uom || '') + (item.is_free_item ? '-free' : '')"
			class="cart-item-row flex items-center gap-2 min-h-pos-tap ps-1.5 border-s-4 select-none"
			:class="[
				index === focusedIndex ? 'bg-gray-100 border-s-black' : 'border-s-transparent',
				item.is_free_item ? 'bg-green-50/30 cursor-default' : 'bg-white cursor-pointer hover:bg-gray-50',
			]"
			@click.stop="$emit('row-click', item, index)"
		>
			<!-- One line tall on purpose: a code with no room wraps out of sight, never half cut -->
			<div class="flex-1 min-w-0 h-5 overflow-hidden flex flex-wrap items-baseline gap-x-1.5">
				<span class="max-w-full truncate text-sm leading-5 font-bold text-gray-900" :title="item.item_name">{{ item.item_name }}</span>
				<span v-if="showsItemCode(item)" class="text-[10px] font-mono text-gray-500">{{ item.item_code }}</span>
			</div>
			<span v-if="item.discount_percentage > 0" dir="ltr" class="flex-shrink-0 text-xs font-bold text-red-700">-{{ formatPercent(item.discount_percentage) }}%</span>

			<div v-if="rulesFor(item).quantity" class="flex items-center flex-shrink-0 border border-gray-400" @click.stop>
				<button
					type="button"
					class="size-pos-tap flex items-center justify-center text-gray-900 bg-white hover:bg-gray-100 border-e border-gray-400 touch-manipulation"
					:aria-label="__('Decrease quantity')"
					:title="__('Decrease quantity')"
					@click="$emit('decrease', item)"
				>
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M20 12H4" />
					</svg>
				</button>
				<div class="w-10">
					<CartNumberField
						class="!border-0 !text-center !px-0"
						:value="item.quantity"
						:label="__('Quantity')"
						:format="formatQuantity"
						@commit="$emit('commit-quantity', item, $event)"
					/>
				</div>
				<button
					type="button"
					class="size-pos-tap flex items-center justify-center text-gray-900 bg-white hover:bg-gray-100 border-s border-gray-400 touch-manipulation"
					:aria-label="__('Increase quantity')"
					:title="__('Increase quantity')"
					@click="$emit('increase', item)"
				>
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
					</svg>
				</button>
			</div>
			<span v-else dir="ltr" class="flex-shrink-0 w-[calc(var(--pos-tap)*2+2.5rem+2px)] text-center text-sm font-mono font-bold text-gray-700">{{ formatQuantity(item.quantity) }}</span>

			<span
				v-if="item.is_free_item"
				class="flex-shrink-0 min-w-[76px] pe-2 text-end text-sm font-bold text-green-700"
			>{{ __('Free') }}</span>
			<span
				v-else
				dir="ltr"
				class="flex-shrink-0 min-w-[76px] pe-2 text-right text-sm font-mono font-bold text-gray-900"
			>{{ formatAmount(getLineTotal(item, taxInclusive)) }}</span>
		</div>
	</div>
</template>

<script setup>
import CartNumberField from "@/components/sale/CartNumberField.vue"
import { getLineEditRules, getLineTotal, showsItemCode } from "@/utils/cartItemEdit"

const props = defineProps({
	items: {
		type: Array,
		required: true,
	},
	settings: {
		type: Object,
		required: true,
	},
	taxInclusive: {
		type: Boolean,
		default: false,
	},
	focusedIndex: {
		type: Number,
		default: -1,
	},
	formatQuantity: {
		type: Function,
		required: true,
	},
	formatAmount: {
		type: Function,
		required: true,
	},
})

defineEmits(["row-click", "increase", "decrease", "commit-quantity"])

const rulesFor = (item) => getLineEditRules(item, props.settings)
const formatPercent = (value) => Number(Number(value).toFixed(2))
</script>
