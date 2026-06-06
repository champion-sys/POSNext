<template>
	<!-- Icon-Only Sidebar - Hidden on Mobile, Visible on Desktop -->
	<div class="hidden lg:flex w-12 flex-shrink-0 bg-white border-e border-gray-200 flex-col items-center py-0 flex flex-col gap-1.5">
		<!-- Logo / POS Icon -->
		<button
			class="w-full h-[41px] flex items-center justify-center flex-shrink-0 hover:from-blue-600 hover:to-blue-700 active:scale-95 transition-all mb-0 mt-0 border-b border-gray-200"
			:aria-label="'POS Next'"
			:title="__('POS Next')"
		>
			<svg class="w-5 h-5 text-black -mt-0.5" fill="currentColor" viewBox="0 0 24 24">
				<path d="M20 7h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zM10 4h4v3h-4V4zm10 16H4V9h16v11z"/>
			</svg>
		</button>

		<!-- Promotions -->
		<button
			@click="handleMenuClick('promotions')"
			:class="[
				'w-11 h-11 rounded-sm flex items-center justify-center transition-all relative group',
				activeMenu === 'promotions'
					? 'bg-green-100 text-green-600'
					: 'text-gray-600 hover:text-gray-900'
			]"
			:title="__('Promotions')"
		>
			<FeatherIcon name="tag" class="w-5 h-5" />
			<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
				{{ __('Promotions') }}
			</div>
		</button>

		<!-- Products -->
		<button
			@click="handleMenuClick('products')"
			:class="[
				'w-11 h-11 rounded-sm flex items-center justify-center transition-all relative group',
				activeMenu === 'products'
					? 'bg-purple-100 text-purple-600'
					: 'text-gray-600 hover:text-gray-900'
			]"
			:title="__('Products')"
		>
			<FeatherIcon name="package" class="w-5 h-5" />
			<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
				{{ __('Products') }}
			</div>
		</button>

		<!-- Invoices -->
		<button
			@click="handleMenuClick('invoices')"
			:class="[
				'w-11 h-11 rounded-sm flex items-center justify-center transition-all relative group',
				activeMenu === 'invoices'
					? 'bg-indigo-100 text-indigo-600'
					: 'text-gray-600 hover:text-gray-900'
			]"
			:title="__('Invoice Management')"
		>
			<FeatherIcon name="file-text" class="w-5 h-5" />
			<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
				{{ __('Invoice Management') }}
			</div>
		</button>

		<!-- Spacer to push settings to bottom -->
		<div class="flex-1"></div>

		<!-- Divider -->
		<div class="w-8 border-t border-gray-200 my-2"></div>

		<!-- Keyboard Shortcuts -->
		<button
			@click="openKeyboardShortcuts"
			:class="[
				'w-11 h-11 rounded-sm flex items-center justify-center transition-all relative group',
				showKeyboardShortcuts
					? 'bg-gray-100 text-gray-900'
					: 'text-gray-600 hover:text-gray-900'
			]"
			:title="__('Keyboard Shortcuts')"
		>
			<FeatherIcon name="command" class="w-5 h-5" />
			<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
				{{ __('Keyboard Shortcuts') }}
			</div>
		</button>

		<!-- Settings -->
		<button
			@click="handleMenuClick('settings')"
			v-if="showSettings"
			:class="[
				'w-11 h-11 rounded-sm flex items-center justify-center transition-all relative group',
				activeMenu === 'settings'
					? 'bg-gray-100 text-gray-900'
					: 'text-gray-600 hover:text-gray-900'
			]"
			:title="__('Settings')"
		>
			<FeatherIcon name="settings" class="w-5 h-5" />
			<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
				{{ __('Settings') }}
			</div>
		</button>

		<!-- User Menu -->
		<UserMenu
			:user-name="userName"
			:profile-name="profileName"
			:profile-image="userImage"
			@logout="$emit('logout')"
			@menu-opened="$emit('menu-opened')"
			@menu-closed="$emit('menu-closed')"
			class="mt-1 mb-1"
		>
			<template #menu-items>
				<slot name="menu-items"></slot>
			</template>
			<template #additional-actions>
				<slot name="additional-actions"></slot>
			</template>
		</UserMenu>
	</div>

	<KeyboardShortcutsDialog v-model="showKeyboardShortcuts" />
</template>

<script setup>
import { FeatherIcon } from "frappe-ui"
import { onMounted, onUnmounted, ref } from "vue"
import KeyboardShortcutsDialog from "@/components/pos/KeyboardShortcutsDialog.vue"
import UserMenu from "@/components/common/UserMenu.vue"

const props = defineProps({
	showSettings: {
		type: Boolean,
		default: false,
	},
	userName: {
		type: String,
		required: true,
	},
	profileName: {
		type: String,
		default: null,
	},
	userImage: {
		type: String,
		default: null,
	},
})

const emit = defineEmits(["menu-clicked", "logout", "menu-opened", "menu-closed"])

const activeMenu = ref("")
const showKeyboardShortcuts = ref(false)

function openKeyboardShortcuts() {
	showKeyboardShortcuts.value = true
}

function isTypingTarget(el) {
	if (!el) return false
	const tag = el.tagName
	if (tag === "TEXTAREA") return true
	if (tag === "INPUT") {
		const type = (el.getAttribute("type") || "").toLowerCase()
		return (
			type !== "checkbox" &&
			type !== "radio" &&
			type !== "button" &&
			type !== "submit"
		)
	}
	return !!el.isContentEditable
}

function handleGlobalShortcutKeydown(event) {
	// Open shortcuts with ? (Shift + /)
	if (event.key !== "?") return
	const activeEl = document.activeElement
	if (isTypingTarget(activeEl)) return
	event.preventDefault()
	openKeyboardShortcuts()
}

onMounted(() => {
	window.addEventListener("keydown", handleGlobalShortcutKeydown)
})

onUnmounted(() => {
	window.removeEventListener("keydown", handleGlobalShortcutKeydown)
})

function handleMenuClick(menuItem) {
	if (menuItem === "settings" && !props.showSettings) return

	activeMenu.value = menuItem
	emit("menu-clicked", menuItem)
}
</script>
