<template>
	<input
		ref="inputRef"
		:value="draft"
		type="text"
		inputmode="decimal"
		enterkeyhint="done"
		autocomplete="off"
		dir="ltr"
		data-cart-field
		:aria-label="label"
		:title="label"
		:style="{ minWidth: `calc(${draft.length} * 0.65em + 14px)` }"
		class="w-full h-11 px-1.5 text-right text-sm font-mono font-bold text-gray-900 bg-white border border-gray-400 rounded-none focus:outline-none focus:border-black focus:ring-1 focus:ring-black touch-manipulation"
		@click.stop
		@focus="handleFocus"
		@mouseup="handleMouseUp"
		@input="handleInput"
		@keydown="handleKeydown"
		@blur="commit"
	/>
</template>

<script setup>
import { isShortcutKey, parseCartNumber } from "@/utils/cartItemEdit"
import { announceScan, createScanBurst } from "@/utils/scanBurst"
import { onBeforeUnmount, ref, watch } from "vue"

const props = defineProps({
	value: {
		type: Number,
		required: true,
	},
	label: {
		type: String,
		required: true,
	},
	format: {
		type: Function,
		default: (value) => String(value),
	},
	// More digits than this can only be a barcode from a scanner too slow to be heard
	longestFigure: {
		type: Number,
		default: 7,
	},
})

const emit = defineEmits(["commit"])

const inputRef = ref(null)
const draft = ref(props.format(props.value))

let changed = false
let selectOnMouseUp = false
let beforeBurst = null

function showDraft(text) {
	draft.value = text
	if (inputRef.value) inputRef.value.value = text
}

const scanBurst = createScanBurst({
	onBurstStart() {
		beforeBurst = { draft: draft.value, changed }
	},
	onScan(barcode) {
		showDraft(beforeBurst.draft)
		changed = beforeBurst.changed
		announceScan(barcode)
	},
})

watch(
	() => props.value,
	(value) => {
		if (!changed) showDraft(props.format(value))
	},
)

function handleFocus(event) {
	event.target.select()
	selectOnMouseUp = true
}

// The click that gave focus would otherwise drop the selection
function handleMouseUp(event) {
	if (selectOnMouseUp) event.preventDefault()
	selectOnMouseUp = false
}

function handleInput(event) {
	draft.value = event.target.value
	changed = true
}

function commit() {
	if (!changed) return
	changed = false

	const typed = draft.value.trim()
	if (typed.length > props.longestFigure && /^\d+$/.test(typed)) {
		showDraft(props.format(props.value))
		announceScan(typed)
		return
	}

	emit("commit", parseCartNumber(typed))
	// A refused value stays out. An accepted one comes back through the prop.
	showDraft(props.format(props.value))
}

function returnToItemSearch() {
	const search = document.getElementById("item-search")
	if (search) search.focus()
	else inputRef.value?.blur()
}

function handleKeydown(event) {
	if (scanBurst.handleKeydown(event)) {
		event.preventDefault()
		event.stopPropagation()
		return
	}

	// A shortcut acts on the sale, so what was typed here goes in first
	if (isShortcutKey(event)) {
		commit()
		return
	}

	// The cart's shortcuts listen on the window, where Enter would open the edit dialog
	if (event.key === "Enter") {
		event.preventDefault()
		event.stopPropagation()
		commit()
		returnToItemSearch()
	} else if (event.key === "Escape") {
		event.stopPropagation()
		changed = false
		showDraft(props.format(props.value))
		inputRef.value?.select()
	}
}

onBeforeUnmount(() => scanBurst.reset())

defineExpose({ focus: () => inputRef.value?.focus() })
</script>
