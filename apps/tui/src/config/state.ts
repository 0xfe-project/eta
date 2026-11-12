/** `tui-state.json`: what the TUI remembers between runs. It is the TUI's own file, so anything
 * it cannot use is dropped without a word. */
import type { SaveProblem, TabRef, TuiState } from "./types";
import { readFile } from "node:fs/promises";
import { messageOf, writeFileAtomically } from "./write-file";

const EMPTY: TuiState = { tabs: [], activeTab: undefined };

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

function tabOf(value: unknown): TabRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return nonEmptyString(kind) && nonEmptyString(id) ? { kind, id } : undefined;
}

/**
 * Read the state. Never throws: a missing or broken file is no tabs; tabs that are not a kind
 * and an id are dropped, and an active tab that does not point at one of the rest is undefined.
 */
export async function loadState(file: string): Promise<TuiState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ...EMPTY, tabs: [] };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { ...EMPTY, tabs: [] };
  const { tabs: rawTabs, activeTab } = parsed as {
    tabs?: unknown;
    activeTab?: unknown;
  };
  if (!Array.isArray(rawTabs)) return { ...EMPTY, tabs: [] };
  const tabs = rawTabs.map(tabOf).filter((tab) => tab !== undefined);
  const active =
    typeof activeTab === "number" &&
    Number.isInteger(activeTab) &&
    activeTab >= 0 &&
    activeTab < tabs.length
      ? activeTab
      : undefined;
  return { tabs, activeTab: active };
}

/** Write the state, all at once and private to the user. Never throws. */
export async function saveState(
  file: string,
  state: TuiState,
): Promise<SaveProblem | undefined> {
  const written = {
    tabs: state.tabs.map(({ kind, id }) => ({ kind, id })),
    ...(state.activeTab === undefined ? {} : { activeTab: state.activeTab }),
  };
  try {
    await writeFileAtomically(file, `${JSON.stringify(written, null, 2)}\n`);
  } catch (error) {
    return { reason: "io", file, detail: messageOf(error) };
  }
  return undefined;
}
