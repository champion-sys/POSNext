<template>
  <Dialog v-model="open" :options="{ title: __('Open POS Shift'), size: 'xl' }">
    <template #body-content>
      <div class="flex flex-col gap-3">
        <div v-if="opensOnDevice && step !== 3" class="rounded-md bg-amber-50 border border-amber-200 p-2.5">
          <p class="text-sm text-amber-800 text-start">{{ offlineMessage }}</p>
        </div>

        <!-- Step 1: Select POS Profile -->
        <div v-if="step === 1" class="flex flex-col gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2 text-start">
              {{ __('Select POS Profile') }}
            </label>
            <div v-if="profilesResource.loading" class="text-center py-4">
              <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
            <div v-else-if="profiles.length > 0" class="grid grid-cols-1 gap-2">
              <div
                v-for="profile in profiles"
                :key="profile.name"
                @click="selectPosProfile(profile)"
                :class="[
                  'px-3 py-2 border rounded-lg cursor-pointer transition-all',
                  selectedProfile?.name === profile.name
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500'
                    : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                ]"
              >
                <div class="flex justify-between items-start">
                  <div class="text-start">
                    <h3 class="font-medium text-gray-900">{{ profile.name }}</h3>
                    <p class="text-sm text-gray-500">{{ profile.company }}</p>
                  </div>
                  <span class="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    {{ profile.currency }}
                  </span>
                </div>
              </div>
            </div>
            <div v-else-if="!opensOnDevice" class="text-center py-8 text-gray-500">
              <p>{{ __('No POS Profiles available. Please contact your administrator.') }}</p>
            </div>
          </div>

          <div v-if="profilesResource.error && !opensOnDevice" class="rounded-md bg-red-50 p-2.5">
            <p class="text-sm text-red-800">{{ parseError(profilesResource.error).message }}</p>
          </div>
        </div>

        <!-- Step 2: Enter Opening Balances -->
        <div v-if="step === 2" class="flex flex-col gap-3">
          <div>
            <div class="flex items-center justify-between">
              <div class="text-start">
                <h3 class="font-medium text-gray-900">{{ selectedProfile?.name }}</h3>
                <p class="text-sm text-gray-500">{{ selectedProfile?.company }}</p>
              </div>
              <Button size="md" variant="subtle" @click="step = 1">{{ __('Change Profile') }}</Button>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2 text-start">
              {{ __('Opening Balance (Optional)') }}
            </label>

            <div v-if="dialogDataResource.loading" class="text-center py-4">
              <div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            </div>

            <div v-else-if="paymentMethods.length > 0" class="flex flex-col gap-1.5">
              <div
                v-for="method in paymentMethods"
                :key="method.mode_of_payment"
                class="flex items-center gap-3 px-3 py-1.5 border rounded-lg"
              >
                <div class="flex-1 text-start">
                  <label class="text-sm font-medium text-gray-700">
                    {{ method.mode_of_payment }}
                  </label>
                </div>
                <div class="w-32">
                  <Input
                    v-model="openingBalances[method.mode_of_payment]"
                    type="number"
                    placeholder="0.00"
                    input-class="h-pos-tap"
                    step="0.01"
                    min="0"
                  />
                </div>
              </div>
            </div>

            <div v-else class="text-center py-4 text-gray-500">
              <p class="text-sm">{{ __('No payment methods configured for this POS Profile') }}</p>
            </div>
          </div>

          <div v-if="dialogDataResource.error" class="rounded-md bg-red-50 p-2.5">
            <p class="text-sm text-red-800">{{ parseError(dialogDataResource.error).message }}</p>
          </div>

          <div v-if="createShiftResource.error" class="rounded-md bg-red-50 p-2.5">
            <p class="text-sm text-red-800">{{ parseError(createShiftResource.error).message }}</p>
          </div>
        </div>

        <!-- Step 3: Resume or Open New -->
        <div v-if="step === 3" class="flex flex-col gap-3">
          <div class="text-center">
            <div class="mx-auto flex items-center justify-center h-10 w-10 rounded-full bg-blue-100 mb-2">
              <svg class="h-6 w-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 class="text-base font-medium text-gray-900 mb-1">{{ __('Existing Shift Found') }}</h3>
            <p class="text-sm text-gray-500 mb-3">
              {{ __('You have an open shift. Would you like to resume it or close it and open a new one?') }}
            </p>

            <div v-if="existingShift" class="bg-gray-50 rounded-lg p-3 mb-3">
              <div class="text-sm text-gray-600">
                  <TranslatedHTML
                    :tag="'p'"
                    :inner="__('&lt;strong&gt;POS Profile:&lt;/strong&gt; {0}', [existingShift.pos_profile?.name])"
                  />
                  <div class="h-1"></div>
                  <TranslatedHTML
                    :tag="'p'"
                    :inner="__('&lt;strong&gt;Opened:&lt;/strong&gt; {0}', [formatDateTime(existingShift.pos_opening_shift?.period_start_date)])"
                  />
              </div>
            </div>

            <div class="flex gap-3 justify-center">
              <Button size="md" variant="solid" theme="blue" @click="resumeShift">
                {{ __('Resume Shift') }}
              </Button>
              <Button size="md"
                v-if="!mustQueue || settingsStore.allowOfflineShiftClose"
                variant="subtle"
                theme="gray"
                @click="closeAndOpenNew"
                :disabled="closingExistingShift"
              >
                {{ __('Close & Open New') }}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #actions>
      <div class="flex justify-between w-full">
        <Button size="md" v-if="step > 1 && step !== 3" variant="subtle" @click="step--">
          {{ __('Back') }}
        </Button>
        <div v-else></div>

        <div class="flex gap-2">
          <Button size="md" variant="subtle" @click="closeDialog('cancelled')" :disabled="createShiftResource.loading">
            {{ __('Cancel') }}
          </Button>
          <Button size="md"
            v-if="step === 1"
            variant="solid"
            theme="blue"
            @click="nextStep"
            :disabled="!selectedProfile"
          >
            {{ __('Next') }}
          </Button>
          <Button size="md"
            v-if="step === 2"
            variant="solid"
            theme="blue"
            @click="openShift"
            :loading="createShiftResource.loading || savingOffline"
          >
            {{ __('Open Shift') }}
          </Button>
        </div>
      </div>
    </template>
  </Dialog>

  <ShiftClosingDialog
    v-if="existingShift"
    v-model="showClosingDialog"
    :opening-shift="existingShift?.pos_opening_shift?.name"
    @shift-closed="handleExistingShiftClosed"
  />
</template>

<script setup>
import { Button, Dialog, Input } from "frappe-ui"
import { createResource } from "frappe-ui"
import { computed, ref, watch } from "vue"
import {
	getCachedShiftProfiles,
	getCollidingShiftRecords,
	isShiftSlotTaken,
	shiftState,
	useShift,
	whenCachedShiftRestored,
} from "../composables/useShift"
import { useFormatters } from "../composables/useFormatters"
import { useOfflineStatus } from "../composables/useOfflineStatus"
import { useToast } from "../composables/useToast"
import { isPastOfflineSaleLimit } from "../platform/auth"
import { usePOSSettingsStore } from "../stores/posSettings"
import { usePOSSyncStore } from "../stores/posSync"
import { parseError } from "../utils/errorHandler"
import { getShiftOpenProblem } from "../utils/offline/entities"
import { isAnySaleHeldFromSync } from "../utils/offline/sync"
import { offlineWorker } from "../utils/offline/workerClient"
import ShiftClosingDialog from "./ShiftClosingDialog.vue"
import TranslatedHTML from "./common/TranslatedHTML.vue"

const props = defineProps({
	modelValue: Boolean,
})

const emit = defineEmits(["update:modelValue", "shift-opened", "dialog-closed"])

const open = computed({
	get: () => props.modelValue,
	set: (value) => emit("update:modelValue", value),
})

const { createOpeningShift, getOpeningDialogData, checkOpeningShift } =
	useShift()
const { formatDateTime } = useFormatters()
const { showError, showWarning } = useToast()
const { isOffline, mustQueue } = useOfflineStatus()
const settingsStore = usePOSSettingsStore()
const syncStore = usePOSSyncStore()

const step = ref(1)
const selectedProfile = ref(null)
const openingBalances = ref({})
const existingShift = ref(null)
const showClosingDialog = ref(false)
const closingExistingShift = ref(false)
const restartProfileName = ref(null)
const offlineProfiles = ref([])
const offlineProblem = ref(null)
const savingOffline = ref(false)
const waitingForShift = ref(false)

// A shift opened on the server now would collide with the last one, which has not landed
const opensOnDevice = computed(() => mustQueue.value || waitingForShift.value)

const profiles = computed(() =>
	opensOnDevice.value
		? offlineProfiles.value.map(({ pos_profile }) => pos_profile)
		: profilesResource.data || [],
)

const offlineMessage = computed(() => {
	switch (offlineProblem.value) {
		case "past_limit":
			return __("This device has been offline too long to open a shift. Connect to the server and sign in with your password.")
		case "slot_taken":
			return __("Another cashier's shift is still on this device. It has to be closed, or the device has to connect to the server, before you can open a shift here.")
		case "no_profile":
			return __("This device has no POS Profile saved for you. Connect to the server once to open a shift.")
		case "not_allowed":
			return __("Opening a shift offline is not allowed for your POS Profile, or this device has not received that setting yet. Connect to the server to open a shift.")
		case "shift_unsettled":
			return __("A shift opened on this device is still on its way to the server, so another cannot open yet. Try again once it has arrived, or ask a manager.")
		case "shift_finishing":
			return __("The last shift is still on its way to the server, and this POS Profile cannot open a shift until it arrives. Try again shortly, or ask a manager.")
		default:
			return isOffline.value
				? __("You are offline. The shift opens on this device and is created on the server when it connects.")
				: __("The last shift is still on its way to the server. This shift opens on this device and follows it there.")
	}
})

// Get POS Profiles
const profilesResource = createResource({
	url: "pos_next.api.pos_profile.get_pos_profiles",
	auto: false,
})

// Get dialog data (payment methods)
const dialogDataResource = createResource({
	url: "pos_next.api.shifts.get_opening_dialog_data",
	auto: false,
})

// Create shift resource
const createShiftResource = createOpeningShift

// Computed payment methods for selected profile
const paymentMethods = computed(() => {
	if (!selectedProfile.value) return []
	if (opensOnDevice.value) {
		return offlineProfiles.value.find(({ pos_profile }) => pos_profile.name === selectedProfile.value.name)?.methods || []
	}
	if (!dialogDataResource.data) return []

	return (dialogDataResource.data.payments_method || []).filter(
		(method) => method.parent === selectedProfile.value.name,
	)
})

// Watch dialog open state
// Use { immediate: true } to ensure initDialog runs even when
// the component mounts with open already true (e.g., after logout with dialog open)
watch(
	open,
	(isOpen) => {
		if (isOpen) {
			initDialog()
		} else {
			resetDialog()
		}
	},
	{ immediate: true },
)

watch(isOffline, () => {
	if (open.value) {
		initDialog()
	}
})

watch(showClosingDialog, (isOpen) => {
	closingExistingShift.value = isOpen
	if (!isOpen && existingShift.value) {
		restartProfileName.value = null
	}
})

async function initDialog() {
	step.value = 1
	selectedProfile.value = null
	existingShift.value = null
	openingBalances.value = {}
	dialogDataResource.reset()

	waitingForShift.value = !isOffline.value && (await hasCollidingShiftRecords())
	if (waitingForShift.value && !shiftState.value.isOpen) {
		// Its server copy, or another shift of theirs, is there to resume instead
		await checkOpeningShift.fetch().catch(() => {})
		await whenCachedShiftRestored()
	}

	if (opensOnDevice.value) {
		await loadOfflineOpening()
		return
	}

	try {
		// Await profile fetch to ensure data is loaded before proceeding
		await profilesResource.fetch()

		// Check if user already has an open shift
		const checkResult = await checkOpeningShift.fetch()
		if (checkResult) {
			existingShift.value = checkResult
			step.value = 3
		}
	} catch (error) {
		console.error("Error initializing shift dialog:", error)
		// Error will be displayed via profilesResource.error in the UI
	}
}

/** A colleague's records count only on a POS Profile that keeps one shift for everyone */
function getCollisions(posProfile) {
	return getCollidingShiftRecords(
		posProfile && settingsStore.keepsOneShift(posProfile) ? posProfile : undefined,
	)
}

async function hasCollidingShiftRecords(posProfile) {
	const { closes, unclosed } = await getCollisions(posProfile)
	return closes.length + unclosed.length > 0
}

/**
 * What a shift can open from here, all of it as this device last heard it. A shift already
 * open stays the only one: it is offered to resume, as the server's would be.
 */
async function loadOfflineOpening() {
	if (shiftState.value.isOpen) {
		existingShift.value = shiftState.value
		step.value = 3
		return
	}

	const cached = await getCachedShiftProfiles()
	const usable = []
	let held = 0
	for (const entry of cached) {
		const name = entry.pos_profile.name
		if (!settingsStore.allowsOfflineShiftOpen(name)) continue

		if ((await getCollisions(name)).unclosed.length > 0) {
			held++
			continue
		}

		const methods = await offlineWorker.getCachedPaymentMethods(name)
		const openable = methods.filter((method) => !method.is_wallet_payment)
		if (openable.length > 0) usable.push({ ...entry, methods: openable })
	}

	const { unclosed } = await getCollidingShiftRecords()
	offlineProblem.value = getShiftOpenProblem({
		pastLimit: isPastOfflineSaleLimit(),
		// Offline it would stay out of its cashier's reach. Online it moves aside for them.
		slotTaken: isOffline.value && (await isShiftSlotTaken()),
		unsettled: unclosed.length > 0 || (held > 0 && usable.length === 0),
		online: !isOffline.value,
		cached: cached.length,
		usable: usable.length,
	})
	offlineProfiles.value = offlineProblem.value ? [] : usable
}

function resetDialog() {
	step.value = 1
	selectedProfile.value = null
	openingBalances.value = {}
	existingShift.value = null
	offlineProfiles.value = []
	offlineProblem.value = null
	waitingForShift.value = false
	profilesResource.reset()
	dialogDataResource.reset()
	createShiftResource.reset()
}

function selectPosProfile(profile) {
	selectedProfile.value = profile
}

/** Where a POS Profile keeps one shift, a colleague's collides like this cashier's own */
async function queueBehindColleague() {
	const name = selectedProfile.value.name
	if (!(await hasCollidingShiftRecords(name))) return

	waitingForShift.value = true
	await loadOfflineOpening()
	if (offlineProfiles.value.some(({ pos_profile }) => pos_profile.name === name)) return

	const { unclosed } = await getCollisions(name)
	offlineProblem.value = offlineProblem.value || (unclosed.length > 0 ? "shift_unsettled" : "shift_finishing")
	offlineProfiles.value = []
	selectedProfile.value = null
}

async function nextStep() {
	if (step.value === 1 && selectedProfile.value) {
		if (!opensOnDevice.value) await queueBehindColleague()
		if (!selectedProfile.value) return

		if (!opensOnDevice.value) await dialogDataResource.fetch()
		step.value = 2
	}
}

async function openShiftOffline(balanceDetails) {
	if (savingOffline.value) return false

	savingOffline.value = true
	try {
		// The limit may have passed while the dialog was open
		await loadOfflineOpening()
		const entry = offlineProfiles.value.find(({ pos_profile }) => pos_profile.name === selectedProfile.value.name)
		if (!entry) return false

		await syncStore.saveShiftOpenOffline(entry, balanceDetails)
		return true
	} finally {
		savingOffline.value = false
	}
}

async function openShift() {
	if (!selectedProfile.value) return

	// Prepare balance details
	const balance_details = paymentMethods.value.map((method) => ({
		mode_of_payment: method.mode_of_payment,
		opening_amount: Number.parseFloat(
			openingBalances.value[method.mode_of_payment] || 0,
		),
	}))

	try {
		if (opensOnDevice.value) {
			if (!(await openShiftOffline(balance_details))) return
		} else {
			await createShiftResource.submit({
				pos_profile: selectedProfile.value.name,
				company: selectedProfile.value.company,
				balance_details,
			})
		}

		emit("shift-opened")
		closeDialog("shift-opened")
	} catch (error) {
		console.error("Error opening shift:", error)
		const err = parseError(error)
		showError(err.message || __("Failed to open shift"))
	}
}

function resumeShift() {
	emit("shift-opened")
	closeDialog("resumed")
}

function closeAndOpenNew() {
	if (!existingShift.value?.pos_opening_shift?.name) {
		return
	}
	if (isAnySaleHeldFromSync()) {
		showWarning(__("Finish or clear the queued invoice you are editing first"))
		return
	}

	restartProfileName.value = existingShift.value.pos_profile?.name || null
	showClosingDialog.value = true
}

function closeDialog(reason) {
	open.value = false
	emit("dialog-closed", { reason })
}

async function handleExistingShiftClosed() {
	showClosingDialog.value = false
	const profileToRestore = restartProfileName.value
	restartProfileName.value = null
	existingShift.value = null
	step.value = 1
	openingBalances.value = {}

	if (mustQueue.value || (await hasCollidingShiftRecords())) {
		await initDialog()
		return
	}

	await checkOpeningShift.fetch()

	if (!profilesResource.data || profilesResource.data.length === 0) {
		await profilesResource.fetch()
	}

	if (profileToRestore) {
		const matchedProfile = profilesResource.data?.find(
			(profile) => profile.name === profileToRestore,
		)

		if (matchedProfile) {
			selectedProfile.value = matchedProfile
			await dialogDataResource.fetch()
			step.value = 2
		}
	}
}
</script>
