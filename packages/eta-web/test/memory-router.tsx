import { useSyncExternalStore, type ReactNode } from "react";
import { Router } from "wouter";

/** Tiny memory router for wouter (the package ships no memory adapter). */
export function MemoryRouter({ initial = "/", children }: { initial?: string; children: ReactNode }) {
	return <Router hook={createMemoryHook(initial)}>{children}</Router>;
}

function createMemoryHook(initial: string) {
	let path = initial;
	const listeners = new Set<() => void>();
	const useLocation = (): [string, (to: string) => void] => {
		useSyncExternalStore(
			(listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			() => path,
		);
		return [
			path,
			(to: string) => {
				path = typeof to === "string" ? to : "/";
				for (const listener of [...listeners]) listener();
			},
		];
	};
	return useLocation;
}
