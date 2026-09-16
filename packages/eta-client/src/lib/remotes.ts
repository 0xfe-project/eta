import { apiFetch } from "./host.ts";
export type { RemoteConnection, RemoteDirectory, RemoteView, RemoteWorkspace } from "@eta/core/remote";
export { parseRemoteSession, remoteSessionName } from "@eta/core/remote";

export function remoteApiPath(path: string, remoteId?: string): string {
	if (!remoteId) return path;
	const [pathname, query] = path.split("?");
	const prefixed = `/api/remote/${encodeURIComponent(remoteId)}${pathname}`;
	return query ? `${prefixed}?${query}` : prefixed;
}

export async function remoteRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
	const verb = method ?? (body === undefined ? "GET" : "POST");
	const response = await apiFetch(
		path,
		verb === "GET"
			? undefined
			: { method: verb, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) },
	);
	if (!response.ok) {
		const text = await response.text();
		let message = text;
		try {
			message = (JSON.parse(text) as { error?: string }).error ?? text;
		} catch {
			/* plain HTTP error */
		}
		throw new Error(message || `HTTP ${response.status}`);
	}
	return response.json() as Promise<T>;
}

export function isRemoteViewList(value: unknown): value is import("@eta/core/remote").RemoteView[] {
	return Array.isArray(value) && value.every((item) => item && typeof item === "object" && "host" in item && "status" in item);
}
