import type { TabRef, TuiState } from "../../config/types";

/** The open tabs and the one in front; `activeTab` undefined puts the home screen in front. */
export type TabsState = TuiState;

function sameTab(a: TabRef, b: TabRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** A saved state as the shell can use it: an index past the tabs means the home screen. */
export function restoreTabs(saved: TuiState): TabsState {
  const valid =
    saved.activeTab !== undefined &&
    Number.isInteger(saved.activeTab) &&
    saved.activeTab >= 0 &&
    saved.activeTab < saved.tabs.length;
  return { tabs: saved.tabs, activeTab: valid ? saved.activeTab : undefined };
}

/** Brings an open tab to the front, or appends it and brings it to the front. */
export function openTab(state: TabsState, tab: TabRef): TabsState {
  const index = state.tabs.findIndex((t) => sameTab(t, tab));
  if (index !== -1) return { ...state, activeTab: index };
  return {
    tabs: [...state.tabs, { kind: tab.kind, id: tab.id }],
    activeTab: state.tabs.length,
  };
}

/**
 * Closes a tab. Closing the one in front brings its left neighbour forward (the new first tab
 * when it was the first); closing the last one brings the home screen forward.
 */
export function closeTab(state: TabsState, tab: TabRef): TabsState {
  const index = state.tabs.findIndex((t) => sameTab(t, tab));
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  const active = state.activeTab;
  if (active === undefined) return { tabs, activeTab: undefined };
  if (tabs.length === 0) return { tabs, activeTab: undefined };
  if (index < active) return { tabs, activeTab: active - 1 };
  if (index > active) return { tabs, activeTab: active };
  return { tabs, activeTab: Math.max(0, index - 1) };
}

/** Moves the front by `step` tabs, wrapping around; from the home screen the next is the first, the previous the last. */
export function stepTab(state: TabsState, step: 1 | -1): TabsState {
  const count = state.tabs.length;
  if (count === 0) return state;
  if (state.activeTab === undefined)
    return { ...state, activeTab: step === 1 ? 0 : count - 1 };
  return { ...state, activeTab: (state.activeTab + step + count) % count };
}

/** Brings tab `index` forward; an index past the tabs changes nothing. */
export function goToTab(state: TabsState, index: number): TabsState {
  if (index < 0 || index >= state.tabs.length || index === state.activeTab)
    return state;
  return { ...state, activeTab: index };
}
