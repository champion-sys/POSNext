import { shiftState } from "@/composables/useShift"
import { userResource } from "@/data/user"
import {
	ENROLL_ROUTE,
	SIGN_IN_ROUTE,
	isEnrolled,
	isWithinOfflineLimit,
	nativeRedirect,
} from "@/platform/auth"
import { isNative } from "@/platform/runtime"
import { logger } from "@/utils/logger"
import { createRouter, createWebHistory } from "vue-router"
import { session } from "./data/session"

const log = logger.create("Router")

const nativeRoutes = [
	{
		name: ENROLL_ROUTE,
		path: "/device/enroll",
		component: () => import("@/pages/DeviceEnroll.vue"),
	},
	{
		name: SIGN_IN_ROUTE,
		path: "/device/sign-in",
		component: () => import("@/pages/CashierSignIn.vue"),
	},
]

const routes = [
	{
		path: "/",
		name: "POSSale",
		component: () => import("@/pages/POSSale.vue"),
	},
	{
		name: "Login",
		path: "/account/login",
		component: () => import("@/pages/Login.vue"),
	},
	...(isNative ? nativeRoutes : []),
	// Catch-all route
	{
		path: "/:pathMatch(.*)*",
		redirect: "/",
	},
]

const router = createRouter({
	history: createWebHistory(import.meta.env.VITE_ROUTER_BASE ?? "/pos"),
	routes,
})

router.beforeEach((to, from, next) => {
	// Check authentication status (session.user is already set in main.js before app mount)
	const isLoggedIn = session.isLoggedIn

	log.debug(`${to.name} (from: ${from.name || "initial"}), auth: ${isLoggedIn}`)

	if (isNative) {
		const redirect = nativeRedirect(to.name, {
			enrolled: isEnrolled(),
			signedIn: isLoggedIn && isWithinOfflineLimit(),
		})
		next(redirect ? { name: redirect } : undefined)
		return
	}

	// Redirect logic
	if (to.name === "Login" && isLoggedIn) {
		next({ name: "POSSale" })
	} else if (to.name !== "Login" && !isLoggedIn) {
		next({ name: "Login" })
	} else {
		next()
	}
})

export default router
