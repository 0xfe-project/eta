/**
 * Client-side preferences, one localStorage key, exposed as signals so the
 * settings page and the sidebar agree without a reload. Server-side defaults
 * (persona, model, thinking level) live behind GET/POST /api/settings instead —
 * these are only things the browser itself decides.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "eta:sidebar:prefs";

export type ProjectSort = "recent" | "name";

export interface SidebarPrefs {
	sort: ProjectSort;
	/** cwd — or the ungrouped sentinel — of every collapsed group. */
	collapsed: string[];
}

function load(): SidebarPrefs {
	const fallback: SidebarPrefs = { sort: "recent", collapsed: [] };
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<SidebarPrefs>;
		return {
			sort: parsed.sort === "name" ? "name" : "recent",
			collapsed: Array.isArray(parsed.collapsed)
				? parsed.collapsed.filter((entry): entry is string => typeof entry === "string")
				: fallback.collapsed,
		};
	} catch {
		return fallback;
	}
}

const [prefs, setPrefs] = createSignal<SidebarPrefs>(load());

function write(next: SidebarPrefs): void {
	setPrefs(next);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		/* private mode: the prefs hold for this load only */
	}
}

export const sidebarPrefs = {
	get sort(): ProjectSort {
		return prefs().sort;
	},
	get collapsed(): string[] {
		return prefs().collapsed;
	},
	setSort(sort: ProjectSort): void {
		write({ ...prefs(), sort });
	},
	toggleCollapsed(key: string): void {
		const { collapsed } = prefs();
		write({
			...prefs(),
			collapsed: collapsed.includes(key) ? collapsed.filter((entry) => entry !== key) : [...collapsed, key],
		});
	},
	setCollapsed(collapsed: string[]): void {
		write({ ...prefs(), collapsed });
	},
};
