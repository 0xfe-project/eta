import { apiFetch } from "./host.ts";
export type { RemoteHostKey, RemoteConnection, RemoteDirectory, RemoteView, RemoteWorkspace } from "@eta/core/remote";
export { parseRemoteSession, remoteSessionName } from "@eta/core/remote";

export function remoteApiPath(path: string, remoteId?: string): string {
	if (!remoteId) return path;
	const [pathname, query] = path.split("?");
	const prefixed = `/api/remote/${encodeURIComponent(remoteId)}${pathname}`;
	return query ? `${prefixed}?${query}` : prefixed;
}

export class RemoteRequestError extends Error {
	readonly kind: string | undefined;
	constructor(message: string, kind?: string) { super(message); this.kind = kind; }
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
		let kind: string | undefined;
		try {
			const body = JSON.parse(text) as { error?: string; kind?: string };
			message = body.error ?? text;
			kind = body.kind;
		} catch {
			/* plain HTTP error */
		}
		throw new RemoteRequestError(message || `HTTP ${response.status}`, kind);
	}
	return response.json() as Promise<T>;
}

export function isRemoteViewList(value: unknown): value is import("@eta/core/remote").RemoteView[] {
	return Array.isArray(value) && value.every((item) => item && typeof item === "object" && "host" in item && "status" in item);
}
