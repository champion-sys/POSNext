import { describe, expect, it } from "vitest"
import { resolveRequest } from "../http"

const target = { serverUrl: "https://shop.example.com", token: "abc" }

describe("resolveRequest", () => {
	it("sends API calls to the server with the device token", () => {
		const { url, init } = resolveRequest("/api/method/ping", { method: "POST" }, target)

		expect(url).toBe("https://shop.example.com/api/method/ping")
		expect(init.method).toBe("POST")
		expect(init.credentials).toBe("omit")
		expect(init.headers.get("Authorization")).toBe("Bearer abc")
		expect(init.headers.get("X-Frappe-Site-Name")).toBe("shop.example.com")
	})

	it("keeps the headers the caller set", () => {
		const { init } = resolveRequest("/api/x", { headers: { Accept: "application/json" } }, target)
		expect(init.headers.get("Accept")).toBe("application/json")
	})

	it("covers files and print views", () => {
		expect(resolveRequest("/files/a.png", {}, target).url).toBe("https://shop.example.com/files/a.png")
		expect(resolveRequest("/printview?doctype=x", {}, target).url).toContain("/printview?doctype=x")
	})

	it("leaves the app's own files and other hosts alone", () => {
		expect(resolveRequest("./assets/index.js", {}, target).url).toBe("./assets/index.js")
		expect(resolveRequest("/index.html", {}, target).url).toBe("/index.html")
		expect(resolveRequest("https://other.example.com/api/x", {}, target).url).toBe(
			"https://other.example.com/api/x",
		)
	})

	it("changes nothing without a server", () => {
		const init = { method: "POST" }
		expect(resolveRequest("/api/x", init, { serverUrl: "", token: null })).toEqual({ url: "/api/x", init })
	})
})
