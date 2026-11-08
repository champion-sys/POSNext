<template>
	<div class="p-2 rounded hover:bg-gray-50 transition-colors">
		<label class="block text-sm font-medium text-gray-900 mb-1" :for="fieldId">{{ __('Print Template') }}</label>
		<select
			:id="fieldId"
			:value="modelValue"
			class="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-transparent bg-white cursor-pointer"
			@change="$emit('update:modelValue', $event.target.value)"
		>
			<option value="">{{ defaultLabel }}</option>
			<option :value="BUILTIN_LAYOUT">{{ __('Built-in receipt layout') }}</option>
			<option v-for="template in templates" :key="template.name" :value="template.name">
				{{ template.template_name || template.name }} ({{ template.paper }})
			</option>
			<option v-if="missing" :value="modelValue">{{ __('{0} (no longer available)', [modelValue]) }}</option>
		</select>
		<p class="text-xs text-gray-500 mt-0.5 leading-tight">
			{{ __('Templates are Print Formats in Desk with Print on POS Devices ticked, and print without a connection.') }}
		</p>
	</div>
</template>

<script setup>
import { BUILTIN_LAYOUT, getPrintBundle } from "@/platform/printing/bundle"
import { computed, ref, watch } from "vue"

const props = defineProps({
	modelValue: { type: String, default: "" },
	/** The POS Profile whose templates to list */
	profile: { type: String, default: "" },
})
defineEmits(["update:modelValue"])

const fieldId = `print-template-${Math.random().toString(36).slice(2, 8)}`
const bundle = ref(null)

const templates = computed(() => bundle.value?.templates || [])

const defaultLabel = computed(() => {
	const name = bundle.value?.default_template
	const template = templates.value.find((item) => item.name === name)
	return template
		? __("POS Profile default ({0})", [template.template_name || template.name])
		: __("POS Profile default (built-in receipt)")
})

const missing = computed(
	() =>
		Boolean(props.modelValue) &&
		props.modelValue !== BUILTIN_LAYOUT &&
		bundle.value !== null &&
		!templates.value.some((template) => template.name === props.modelValue),
)

watch(
	() => props.profile,
	async (profile) => {
		if (!profile) {
			bundle.value = { templates: [] }
			return
		}
		try {
			bundle.value = (await getPrintBundle(profile)) || { templates: [] }
		} catch {
			bundle.value = { templates: [] }
		}
	},
	{ immediate: true },
)
</script>
