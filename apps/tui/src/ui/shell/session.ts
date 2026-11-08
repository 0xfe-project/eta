import type { ReactNode } from "react";
import type { TabRef, TuiState } from "../../config/types";
import type { LayerHandle, NoticeTone } from "../../extensions/types";
import type { TabsState } from "./tabs";
import { createStore } from "zustand/vanilla";
import { closeTab, goToTab, openTab, restoreTabs, stepTab } from "./tabs";

interface Layer {
  id: number;
  render: (handle: LayerHandle) => ReactNode;
  handle: LayerHandle;
}

/** What `openLayer` hands back for a shell that is gone: there is no layer to close. */
const NO_LAYER: LayerHandle = { close: () => {} };

export interface Notice {
  id: number;
  text: string;
  tone: NoticeTone;
}

export interface SessionState extends TabsState {
  /** Bottom first; the last one is on top and receives the keys. */
  layers: Layer[];
  notice: Notice | undefined;
  /** The shell the layers belong to; undefined while there is none. */
  shell: number | undefined;
}

/** How long a notice stays, by tone. */
const NOTICE_MS: Record<NoticeTone, number> = {
  info: 5_000,
  warning: 8_000,
  error: 8_000,
};

/**
 * What the running interface holds beyond the connection: the tabs, the layers and the notice.
 * It outlives the screens, so the tabs survive the shell being replaced by another phase's screen.
 *
 * Layers belong to one shell. `followShell` names the wire the current shell is for; a different
 * wire (or none) ends that shell and closes its layers, and `openLayer` for a shell that has ended
 * opens nothing.
 */
export function createSession(saved: TuiState) {
  const store = createStore<SessionState>(() => ({
    ...restoreTabs(saved),
    layers: [],
    notice: undefined,
    shell: undefined,
  }));
  let nextId = 1;
  let shellWire: object | undefined;
  const setTabs = (change: (state: TabsState) => TabsState) => {
    const state = store.getState();
    const next = change(state);
    if (next.tabs !== state.tabs || next.activeTab !== state.activeTab)
      store.setState({ tabs: next.tabs, activeTab: next.activeTab });
  };

  return {
    store,
    openTab: (tab: TabRef) => setTabs((s) => openTab(s, tab)),
    closeTab: (tab: TabRef) => setTabs((s) => closeTab(s, tab)),
    closeActiveTab: () =>
      setTabs((s) => {
        const active =
          s.activeTab === undefined ? undefined : s.tabs[s.activeTab];
        return active ? closeTab(s, active) : s;
      }),
    stepTab: (step: 1 | -1) => setTabs((s) => stepTab(s, step)),
    goToTab: (index: number) => setTabs((s) => goToTab(s, index)),

    /**
     * Starts a new shell when `wire` is not the one the current shell is for, closing every layer;
     * undefined ends the shell. Nothing changes for the same wire.
     */
    followShell: (wire: object | undefined) => {
      if (wire === shellWire) return;
      shellWire = wire;
      store.setState({
        layers: [],
        shell: wire === undefined ? undefined : nextId++,
      });
    },

    openLayer: (
      shell: number,
      render: (handle: LayerHandle) => ReactNode,
    ): LayerHandle => {
      if (shell !== store.getState().shell) return NO_LAYER;
      const id = nextId++;
      const handle: LayerHandle = {
        close: () =>
          store.setState((s) => ({
            layers: s.layers.filter((l) => l.id !== id),
          })),
      };
      store.setState((s) => ({
        layers: [...s.layers, { id, render, handle }],
      }));
      return handle;
    },

    notify: (text: string, tone: NoticeTone = "info") => {
      const id = nextId++;
      store.setState({ notice: { id, text, tone } });
      setTimeout(() => {
        if (store.getState().notice?.id === id)
          store.setState({ notice: undefined });
      }, NOTICE_MS[tone]);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
