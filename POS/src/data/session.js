import router from "@/router"
import { createResource } from "frappe-ui"
import { computed, reactive } from "vue"

import { signOut } from "@/platform/auth"
import { readIdentity } from "@/platform/identity"
import { isNative } from "@/platform/runtime"
import { ensureCSRFToken } from "@/utils/csrf"
import { cleanupUserSession } from "@/utils/sessionCleanup"
import { userResource, userData } from "./user"

export function sessionUser() {
	return readIdentity().userId
}

export const session = reactive({
	login: createResource({
		url: "login",
		makeParams({ email, password }) {
			return {
				usr: email,
				pwd: password,
			}
		},
		async onSuccess(data) {
			// Initialize CSRF token immediately after successful login
			await ensureCSRFToken()

			await userResource.reload()

			// Refresh userData from cookies after login
			// The auto-refresh interval will also pick this up, but we do it immediately for responsiveness
			userData.refresh()

			session.user = sessionUser()
			session.login.reset()
			// Don't redirect here - let the Login page watcher handle navigation
			// This prevents conflicts with the shift opening dialog flow
		},
		onError(error) {
			console.error("Login error:", error)
		},
	}),
	logout: createResource({
		url: "logout",
		// Frappe's logout ends cookies. The apps end the cashier's grant instead.
		resourceFetcher: isNative ? signOut : undefined,
		async onSuccess() {
			await cleanupUserSession()
			userResource.reset()
			session.user = sessionUser()
			router.replace({ name: "Login" })
		},
		async onError(error) {
			console.error("Logout error:", error)
			// Even if logout fails on server, clear local session
			await cleanupUserSession()
			userResource.reset()
			session.user = null
			router.replace({ name: "Login" })
		},
	}),
	user: sessionUser(),
	isLoggedIn: computed(() => !!session.user),
})
