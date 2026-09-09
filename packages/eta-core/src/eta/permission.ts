/**
 * Permission gate (S4, old B7): fail-closed by default, unlike the upstream
 * fail-open hook chain. A tool that needs approval stays blocked when nobody
 * answers, when the approver throws, or when it takes too long.
 * Wire as a `before_tool` handler.
 */

export interface PermissionRequest {
	toolName: string;
	args: Record<string, unknown>;
}

export interface PermissionGateDeps {
	requiresApproval(toolName: string): boolean;
	/** The UI/hook decides; anything but a clean true counts as denial. */
	approve(request: PermissionRequest): Promise<boolean>;
	/** Nobody answered in time = denied. Default 30s. */
	timeoutMs?: number;
}

export interface ToolCallEvent {
	toolName: string;
	args: Record<string, unknown>;
}

export function permissionGate(deps: PermissionGateDeps) {
	return async (event: ToolCallEvent): Promise<{ block: { reason: string } } | undefined> => {
		if (!deps.requiresApproval(event.toolName)) return undefined;
		const timeoutMs = deps.timeoutMs ?? 30_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const verdict = await Promise.race([
			deps.approve({ toolName: event.toolName, args: event.args }).catch(() => false),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		return verdict ? undefined : { block: { reason: "permission denied" } };
	};
}
