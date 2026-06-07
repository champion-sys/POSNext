<template>
	<Dialog v-model="show" :options="{ title: __('Change Password'), size: 'md' }">
		<template #body-content>
			<form @submit.prevent="submitPasswordChange" class="flex flex-col gap-4">
				<!-- Old Password -->
				<div class="flex flex-col gap-1.5">
					<label for="old-password" class="text-xs font-semibold uppercase tracking-wider text-gray-700">
						{{ __('Current Password') }}
					</label>
					<input
						id="old-password"
						v-model="oldPassword"
						type="password"
						required
						autocomplete="current-password"
						class="w-full border border-gray-300 rounded-none px-3 py-2.5 focus:outline-none focus:border-black text-sm"
						:placeholder="__('Enter current password')"
					/>
				</div>

				<!-- New Password -->
				<div class="flex flex-col gap-1.5">
					<label for="new-password" class="text-xs font-semibold uppercase tracking-wider text-gray-700">
						{{ __('New Password') }}
					</label>
					<input
						id="new-password"
						v-model="newPassword"
						type="password"
						required
						autocomplete="new-password"
						class="w-full border border-gray-300 rounded-none px-3 py-2.5 focus:outline-none focus:border-black text-sm"
						:placeholder="__('Enter new password (min. 6 chars)')"
					/>
				</div>

				<!-- Confirm New Password -->
				<div class="flex flex-col gap-1.5">
					<label for="confirm-password" class="text-xs font-semibold uppercase tracking-wider text-gray-700">
						{{ __('Confirm New Password') }}
					</label>
					<input
						id="confirm-password"
						v-model="confirmPassword"
						type="password"
						required
						autocomplete="new-password"
						class="w-full border border-gray-300 rounded-none px-3 py-2.5 focus:outline-none focus:border-black text-sm"
						:placeholder="__('Confirm new password')"
					/>
				</div>

				<!-- Server Error -->
				<div v-if="errorMsg" class="text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-none mt-1">
					{{ errorMsg }}
				</div>
			</form>
		</template>
		<template #actions>
			<div class="flex justify-end gap-2 w-full">
				<Button
					variant="subtle"
					@click="show = false"
					:disabled="loading"
					class=""
				>
					{{ __('Cancel') }}
				</Button>
				<Button
					variant="solid"
					@click="submitPasswordChange"
					:loading="loading"
					class=""
				>
					{{ __('Change Password') }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { Button, Dialog, createResource } from "frappe-ui"
import { computed, ref, watch } from "vue"
import { useToast } from "@/composables/useToast"
import { parseError } from "@/utils/errorHandler"

const props = defineProps({
	modelValue: Boolean,
})

const emit = defineEmits(["update:modelValue"])

const show = computed({
	get: () => props.modelValue,
	set: (val) => emit("update:modelValue", val),
})

const { showSuccess, showWarning } = useToast()

const oldPassword = ref("")
const newPassword = ref("")
const confirmPassword = ref("")
const errorMsg = ref("")
const loading = ref(false)

// Reset form fields when dialog opens/closes
watch(show, (newVal) => {
	if (!newVal) {
		oldPassword.value = ""
		newPassword.value = ""
		confirmPassword.value = ""
		errorMsg.value = ""
	}
})

const updatePasswordResource = createResource({
	url: "frappe.core.doctype.user.user.update_password",
	auto: false,
})

async function submitPasswordChange() {
	errorMsg.value = ""

	if (!oldPassword.value || !newPassword.value || !confirmPassword.value) {
		showWarning(__("Please fill in all fields"))
		return
	}

	if (newPassword.value.length < 6) {
		showWarning(__("New password must be at least 6 characters long"))
		return
	}

	if (newPassword.value !== confirmPassword.value) {
		showWarning(__("Confirm password does not match new password"))
		return
	}

	loading.value = true
	try {
		await updatePasswordResource.submit({
			old_password: oldPassword.value,
			new_password: newPassword.value,
			logout_all_sessions: 0,
		})
		showSuccess(__("Password updated successfully"))
		show.value = false
	} catch (err) {
		console.error("Error changing password:", err)
		const parsedError = parseError(err)
		errorMsg.value = parsedError.message || __("Failed to change password. Please verify current password.")
	} finally {
		loading.value = false
	}
}
</script>
