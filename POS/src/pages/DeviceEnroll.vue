<template>
	<div class="min-h-screen flex flex-col items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div class="text-center">
				<h2 class="mt-6 text-3xl font-extrabold text-gray-900">
					{{ __('Set up this device') }}
				</h2>
				<p class="mt-2 text-sm text-gray-600">
					{{ __('Enter the server address and the code from your manager') }}
				</p>
			</div>

			<div class="bg-white py-8 px-6 shadow rounded-lg">
				<form class="space-y-6" @submit.prevent="submit">
					<SignInError v-if="errorMessage" :title="__('Enrollment Failed')" :message="errorMessage" />

					<div>
						<Input
							v-model="form.serverUrl"
							required
							name="server"
							type="text"
							:placeholder="__('shop.example.com')"
							:label="__('Server Address')"
							:disabled="loading"
						/>
					</div>

					<div>
						<Input
							v-model="form.code"
							required
							name="code"
							type="text"
							:placeholder="__('XXXXX-XXXXX')"
							:label="__('Enrollment Code')"
							:disabled="loading"
						/>
					</div>

					<div>
						<Button
							:loading="loading"
							variant="solid"
							class="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
							type="submit"
						>
							{{ loading ? __('Enrolling...') : __('Enroll Device') }}
						</Button>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>

<script setup>
import { reactive, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import SignInError from "@/components/common/SignInError.vue"
import { SIGN_IN_ROUTE, enrollDevice } from "@/platform/auth"
import { getServerUrl } from "@/platform/runtime"

const route = useRoute()
const router = useRouter()

const form = reactive({ serverUrl: getServerUrl(), code: "" })
const loading = ref(false)
const errorMessage = ref(
	route.query.refused
		? __(
				"This device is not enrolled. Ask a manager for a new enrollment code.",
			)
		: "",
)

function describe(error) {
	switch (error.code) {
		case "bad_url":
			return __("That server address is not valid.")
		case "insecure_url":
			return __(
				"The server must use https, unless it is on your local network.",
			)
		case "network":
			return __(
				"Cannot reach the server. Check the address and the connection.",
			)
		case "unsent_sales":
			return __(
				"This device still has sales waiting to sync with {0}. Enroll it with that server again so they can finish, then move it to the new one.",
				[getServerUrl() || __("its previous server")],
			)
		case "local_data":
			return __(
				"Could not clear the previous server's data from this device. Try again.",
			)
		default:
			return error.message || __("Could not enroll this device.")
	}
}

async function submit() {
	if (loading.value) return

	loading.value = true
	errorMessage.value = ""
	try {
		const previousServer = getServerUrl()
		await enrollDevice({ serverUrl: form.serverUrl, code: form.code })

		// This run still holds the old server's items and its realtime connection. The root,
		// because the desktop build's relative asset paths only resolve from there.
		if (previousServer && previousServer !== getServerUrl()) window.location.assign("/")
		else router.replace({ name: SIGN_IN_ROUTE })
	} catch (error) {
		errorMessage.value = describe(error)
	} finally {
		loading.value = false
	}
}
</script>
