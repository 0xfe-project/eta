import { afterEach } from "vitest";
import { cleanup } from "./render.tsx";
import { FakeSocket } from "./fake-socket.ts";
import { resetEtaStoreForTests } from "../src/lib/eta-store.ts";

afterEach(() => {
	if (typeof window !== "undefined") cleanup();
	FakeSocket.reset();
	resetEtaStoreForTests();
});

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
}
