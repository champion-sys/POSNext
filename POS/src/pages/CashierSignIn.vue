<template>
	<div class="min-h-screen flex flex-col items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div class="text-center">
				<h2 class="mt-6 text-3xl font-extrabold text-gray-900">
					{{ mode === CREATE_PIN ? __('Create your PIN') : __('Sign in to POS Next') }}
				</h2>
				<p class="mt-2 text-sm text-gray-600">
					{{ subtitle }}
				</p>
			</div>

			<div class="bg-white py-8 px-6 shadow rounded-lg">
				<form class="space-y-6" @submit.prevent="submit">
					<SignInError v-if="errorMessage" :title="__('Login Failed')" :message="errorMessage" />

					<template v-if="mode === PASSWORD">
						<div>
							<Input
								v-model="form.usr"
								required
								name="email"
								type="text"
								:placeholder="__('Enter your username or email')"
								:label="__('User ID / Email')"
								:disabled="loading"
							/>
						</div>

						<div>
							<label class="block">
								<span class="mb-2 block text-sm leading-4 text-gray-700">{{ __('Password') }}</span>
								<div class="relative">
									<input
										v-model="form.pwd"
										required
										name="password"
										:type="showPassword ? 'text' : 'password'"
										:placeholder="__('Enter your password')"
										:disabled="loading"
										class="form-input block w-full border-gray-400 placeholder-gray-500 pe-10"
									/>
									<button
										type="button"
										class="absolute inset-y-0 end-0 flex items-center pe-3 text-gray-600 hover:text-gray-800 transition-colors focus:outline-none"
										:disabled="loading"
										tabindex="-1"
										:aria-label="showPassword ? __('Hide password') : __('Show password')"
										@click="showPassword = !showPassword"
									>
										<FeatherIcon
											:name="showPassword ? 'eye-off' : 'eye'"
											class="h-5 w-5"
											:stroke-width="2"
										/>
									</button>
								</div>
							</label>
						</div>
					</template>

					<template v-else-if="mode === PIN">
						<div>
							<label class="block">
								<span class="mb-2 block text-sm leading-4 text-gray-700">{{ __('Cashier') }}</span>
								<select v-model="form.user" required class="form-select block w-full border-gray-400" :disabled="loading">
									<option v-for="cashier in cashiers" :key="cashier.user" :value="cashier.user">
										{{ cashier.fullName }}
									</option>
								</select>
							</label>
						</div>

						<div>
							<label class="block">
								<span class="mb-2 block text-sm leading-4 text-gray-700">{{ __('PIN') }}</span>
								<input
									v-model="form.pin"
									required
									type="password"
									inputmode="numeric"
									autocomplete="off"
									:placeholder="__('Enter your PIN')"
									:disabled="loading"
									class="form-input block w-full border-gray-400 placeholder-gray-500"
								/>
							</label>
						</div>
					</template>

					<template v-else>
						<div>
							<label class="block">
								<span class="mb-2 block text-sm leading-4 text-gray-700">{{ __('New PIN') }}</span>
								<input
									v-model="form.newPin"
									required
									type="password"
									inputmode="numeric"
									autocomplete="off"
									:placeholder="__('6 to 8 digits')"
									:disabled="loading"
									class="form-input block w-full border-gray-400 placeholder-gray-500"
								/>
							</label>
						</div>

						<div>
							<label class="block">
								<span class="mb-2 block text-sm leading-4 text-gray-700">{{ __('Confirm PIN') }}</span>
								<input
									v-model="form.confirmPin"
									required
									type="password"
									inputmode="numeric"
									autocomplete="off"
									:placeholder="__('Enter the same PIN again')"
									:disabled="loading"
									class="form-input block w-full border-gray-400 placeholder-gray-500"
								/>
							</label>
						</div>
					</template>

					<div>
						<Button
							:loading="loading"
							variant="solid"
							class="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
							type="submit"
						>
							{{ submitLabel }}
						</Button>
					</div>

					<div v-if="mode !== CREATE_PIN && cashiers.length" class="text-center">
						<button
							type="button"
							class="text-sm text-blue-600 hover:text-blue-800 focus:outline-none"
							:disabled="loading"
							@click="switchMode"
						>
							{{ mode === PASSWORD ? __('Offline? Sign in with your PIN') : __('Sign in with your password') }}
						</button>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>

<script setup>
import { FeatherIcon } from "frappe-ui"
import { computed, onMounted, reactive, ref } from "vue"
import { useRouter } from "vue-router"
import SignInError from "@/components/common/SignInError.vue"
import { session, sessionUser } from "@/data/session"
import { userData } from "@/data/user"
import {
	ENROLL_ROUTE,
	isServerReachable,
	knownCashiers,
	pinRefusalMessage,
	setCashierPin,
	signInCashier,
	signInWithPin,
} from "@/platform/auth"
import { readIdentity } from "@/platform/identity"
import { PIN_PATTERN } from "@/platform/offlinePin"
import { cleanupUserSession } from "@/utils/sessionCleanup"

const PASSWORD = "password"
const PIN = "pin"
const CREATE_PIN = "create-pin"

const router = useRouter()

// Set when a sign-in ended without signing out, and their sale may still be on screen
const previousUser = readIdentity().userId

const mode = ref(PASSWORD)
const loading = ref(false)
const errorMessage = ref("")
const showPassword = ref(false)
const cashiers = ref(knownCashiers())
const form = reactive({
	usr: "",
	pwd: "",
	user: previousUser || cashiers.value[0]?.user || "",
	pin: "",
	newPin: "",
	confirmPin: "",
})

const subtitle = computed(() => {
	if (mode.value === CREATE_PIN)
		return __("You will use it to sign in when this device is offline")
	if (mode.value === PIN)
		return __("The server cannot be reached. Sign in with your PIN.")
	return __("Access your point of sale system")
})

const submitLabel = computed(() => {
	if (mode.value === CREATE_PIN)
		return loading.value ? __("Saving...") : __("Save PIN")
	return loading.value ? __("Signing in...") : __("Sign in")
})

onMounted(async () => {
	if (cashiers.value.length && !(await isServerReachable())) mode.value = PIN
})

function switchMode() {
	errorMessage.value = ""
	mode.value = mode.value === PASSWORD ? PIN : PASSWORD
}

function describe(error) {
	if (error.code === "network")
		return __("Cannot reach the server. Check the connection.")
	return error.message || __("Could not sign in.")
}

async function finish() {
	form.pwd = ""
	if (previousUser && previousUser !== readIdentity().userId)
		await cleanupUserSession()

	userData.refresh()
	session.user = sessionUser()
	router.replace({ name: "POSSale" })
}

async function submitPassword() {
	const { pin } = await signInCashier({ usr: form.usr.trim(), pwd: form.pwd })
	if (pin) await finish()
	else mode.value = CREATE_PIN
}

async function submitPin() {
	const result = await signInWithPin({ user: form.user, pin: form.pin })
	form.pin = ""

	if (result.ok) {
		await finish()
		return
	}

	errorMessage.value = pinRefusalMessage(result)
	if (result.reason === "online") mode.value = PASSWORD
}

async function submitNewPin() {
	if (!PIN_PATTERN.test(form.newPin)) {
		errorMessage.value = __("The PIN must be 6 to 8 digits.")
		return
	}
	if (form.newPin !== form.confirmPin) {
		errorMessage.value = __("The two PINs do not match.")
		return
	}

	await setCashierPin({ pin: form.newPin, pwd: form.pwd })
	await finish()
}

async function submit() {
	if (loading.value) return

	loading.value = true
	errorMessage.value = ""
	try {
		const submitters = {
			[PASSWORD]: submitPassword,
			[PIN]: submitPin,
			[CREATE_PIN]: submitNewPin,
		}
		await submitters[mode.value]()
	} catch (error) {
		if (error.code === "device_refused") {
			router.replace({ name: ENROLL_ROUTE, query: { refused: 1 } })
			return
		}
		errorMessage.value = describe(error)
	} finally {
		loading.value = false
	}
}
</script>
