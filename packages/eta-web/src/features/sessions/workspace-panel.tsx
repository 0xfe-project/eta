import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { TranslationKey } from "@eta/i18n";
import { useAppI18n } from "../../i18n.ts";
import type { GitDiff, GitDiffKind, GitFile, GitStatus } from "../../lib/protocol.ts";

// Read-only git view of the session cwd (GUI-PLAN v2 T6/X3). Hue is reserved
// for what it means: additions green, deletions red, conflicts loud.
type GroupKey = keyof GitStatus["groups"];
type PanelKey = Extract<TranslationKey, `workspace.${string}`>;

const GROUPS: readonly { key: GroupKey; label: PanelKey; kind: GitDiffKind }[] = [
	{ key: "conflicted", label: "workspace.conflicted", kind: "worktree" },
	{ key: "staged", label: "workspace.staged", kind: "index" },
	{ key: "changes", label: "workspace.changes", kind: "worktree" },
	{ key: "untracked", label: "workspace.untracked", kind: "untracked" },
];

const VIEW_DEBOUNCE_MS = 800;

interface DiffLine {
	text: string;
	kind: "hunk" | "meta" | "add" | "del" | "ctx";
}

function parseDiff(text: string): DiffLine[] {
	return text.split("\n").map((line) => ({
		text: line,
		kind: line.startsWith("@@")
			? "hunk"
			: line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
				? "meta"
				: line.startsWith("+")
					? "add"
					: line.startsWith("-")
						? "del"
						: "ctx",
	}));
}

export function WorkspacePanel(props: { session: string }) {
	const i18n = useAppI18n();
	const [status, setStatus] = createSignal<GitStatus | null>(null);
	const [failed, setFailed] = createSignal(false);
	const [selected, setSelected] = createSignal<{ path: string; kind: GitDiffKind } | null>(null);
	const [diff, setDiff] = createSignal<GitDiff | null>(null);

	const load = async (): Promise<void> => {
		try {
			const response = await fetch(`/api/git/status?session=${encodeURIComponent(props.session)}`);
			if (!response.ok) {
				setFailed(true);
				return;
			}
			setStatus((await response.json()) as GitStatus);
			setFailed(false);
		} catch {
			setFailed(true);
		}
	};

	const openDiff = async (path: string, kind: GitDiffKind): Promise<void> => {
		setSelected({ path, kind });
		try {
			const response = await fetch(
				`/api/git/diff?session=${encodeURIComponent(props.session)}&path=${encodeURIComponent(path)}&kind=${kind}`,
			);
			setDiff(response.ok ? ((await response.json()) as GitDiff) : null);
		} catch {
			setDiff(null);
		}
	};

	createEffect(
		on(
			() => props.session,
			() => {
				setSelected(null);
				setDiff(null);
				void load();
			},
		),
	);

	// A streaming run pushes many view frames; one refetch per quiet moment.
	const pending: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined };
	const onView = (event: Event): void => {
		const detail = (event as CustomEvent<{ session?: string }>).detail;
		if (detail?.session !== props.session) return;
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			pending.timer = undefined;
			void load();
		}, VIEW_DEBOUNCE_MS);
	};
	window.addEventListener("eta:view", onView);
	onCleanup(() => {
		window.removeEventListener("eta:view", onView);
		if (pending.timer !== undefined) clearTimeout(pending.timer);
	});

	const shown = createMemo(() =>
		GROUPS.map((group) => ({ ...group, entries: status()?.groups[group.key] ?? [] })).filter(
			(group) => group.entries.length > 0,
		),
	);
	const totals = createMemo(() => {
		let files = 0;
		let added = 0;
		let deleted = 0;
		for (const group of shown()) {
			files += group.entries.length;
			for (const entry of group.entries) {
				added += entry.added ?? 0;
				deleted += entry.deleted ?? 0;
			}
		}
		return { files, added, deleted };
	});
	const emptyKey = createMemo((): PanelKey | null => {
		if (failed()) return "workspace.error";
		const current = status();
		if (current === null) return "workspace.loading";
		if (current.notGit) return "workspace.notGit";
		return shown().length === 0 ? "workspace.clean" : null;
	});

	return (
		<div class="flex h-full min-h-0 flex-col" data-testid="workspace-panel">
			<div class="flex items-center gap-2 border-b border-border px-2 py-1">
				<Show when={status()?.branch}>
					{(branch) => <span class="header-chip mono max-w-[120px] truncate">{branch()}</span>}
				</Show>
				<span data-testid="git-summary" class="mono text-[10px] text-muted">
					{totals().files} files · <span class="git-add">+{totals().added}</span>{" "}
					<span class="git-del">-{totals().deleted}</span>
				</span>
				<button
					data-testid="git-refresh"
					onClick={() => void load()}
					class="ml-auto border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground"
				>
					{i18n.t("workspace.refresh")}
				</button>
			</div>

			<div class="max-h-[46%] min-h-0 shrink-0 overflow-y-auto">
				<Show
					when={emptyKey() === null}
					fallback={
						<p data-testid="git-empty" class="p-3 text-center text-[11px] text-muted">
							{i18n.t(emptyKey() ?? "workspace.clean")}
						</p>
					}
				>
					<For each={shown()}>
						{(group) => (
							<div>
								<div class="git-group-head">
									<span>{i18n.t(group.label)}</span>
									<span class="text-muted">{group.entries.length}</span>
								</div>
								<For each={group.entries}>
									{(file) => (
										<button
											data-testid={`git-file-${file.path}`}
											onClick={() => void openDiff(file.path, group.kind)}
											class={`git-file-row ${
												selected()?.path === file.path && selected()?.kind === group.kind ? "active" : ""
											}`}
										>
											<span class={`git-badge${badgeClass(file)}`}>{file.status}</span>
											<span class="mono min-w-0 flex-1 truncate text-left text-[11px]">{file.path}</span>
											<span class="mono shrink-0 text-[10px]">
												<span class="git-add">+{file.added ?? 0}</span>{" "}
												<Show when={file.deleted !== undefined}>
													<span class="git-del">-{file.deleted}</span>
												</Show>
											</span>
										</button>
									)}
								</For>
							</div>
						)}
					</For>
				</Show>
			</div>

			<div data-testid="git-diff" class="git-diff min-h-0 flex-1 overflow-auto border-t border-dashed border-border">
				<Show
					when={selected() !== null && diff() !== null}
					fallback={
						<p class="p-3 text-center text-[11px] text-muted">
							{i18n.t(selected() === null ? "workspace.pickFile" : "workspace.noDiff")}
						</p>
					}
				>
					<Show when={diff() !== null}>
						<div data-testid="git-diff-body">
							<For each={parseDiff(diff() === null ? "" : diff()!.text)}>
								{(line) => <div class={`git-diff-line ${line.kind}`}>{line.text === "" ? " " : line.text}</div>}
							</For>
							<Show when={diff()?.truncated === true}>
								<div class="git-diff-line meta">{i18n.t("workspace.truncated")}</div>
							</Show>
						</div>
					</Show>
				</Show>
			</div>
		</div>
	);
}

function badgeClass(file: GitFile): string {
	if (file.status === "A" || file.status === "??" || file.status === "?") return " add";
	if (file.status === "D") return " del";
	if (file.status === "U" || file.status.includes("U")) return " conf";
	return "";
}
