import type { PersistStorage, StorageValue } from "zustand/middleware";
import { toast } from "sonner";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const storageKey = "axp.workspace.v1";

// Local UI state only. Chat history lives in the control plane; older saved
// messages are dropped rather than uploaded.
const workspaceSchema = z.object({
  selectedAgentId: z.string().max(64).optional(),
  tasks: z.array(
    z.object({ id: z.string(), title: z.string().max(200), done: z.boolean() }),
  ),
  memory: z.string().max(10_000),
  sessionTheme: z.enum(["claude", "codex", "grok"]).default("claude"),
  // Preselected model for new agents.
  lastModel: z.string().max(100).optional(),
});

export type WorkspaceState = z.infer<typeof workspaceSchema>;
export type SettingsSection = "agents" | "providers" | "appearance" | "logs";
export interface SettingsState {
  open: boolean;
  section: SettingsSection;
}
/** The agent editor: closed, creating (agentId null) or editing an agent. */
export interface AgentEditorState {
  open: boolean;
  agentId: string | null;
}

type Update<T> = T | ((state: T) => T);

interface WorkspaceStore {
  /** Persisted in this browser. */
  workspace: WorkspaceState;
  draft: string;
  mobilePanel: "chat" | "workspace";
  settings: SettingsState;
  agentEditor: AgentEditorState;
  setWorkspace: (update: Update<WorkspaceState>) => void;
  setDraft: (draft: string) => void;
  setMobilePanel: (panel: "chat" | "workspace") => void;
  setSettings: (update: Update<SettingsState>) => void;
  setAgentEditor: (update: Update<AgentEditorState>) => void;
}

function apply<T>(update: Update<T>, state: T): T {
  return typeof update === "function"
    ? (update as (state: T) => T)(state)
    : update;
}

type Persisted = Pick<WorkspaceStore, "workspace">;

// Keeps the format saved before the store existed: the bare workspace object
// under the same key, validated on load.
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    try {
      const saved = localStorage.getItem(name);
      if (!saved) return null;
      const result = workspaceSchema.safeParse(JSON.parse(saved));
      return result.success ? { state: { workspace: result.data } } : null;
    } catch {
      return null; // Storage may be unavailable in private browsing.
    }
  },
  setItem: (name, value: StorageValue<Persisted>) => {
    try {
      localStorage.setItem(name, JSON.stringify(value.state.workspace));
    } catch {
      toast.error("无法保存到当前浏览器，请保持页面打开以保留内容。");
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

// A module-level store is shared by server renders, which only read its
// defaults; it changes and loads saved state in the browser only.
export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set) => ({
      workspace: { tasks: [], memory: "", sessionTheme: "claude" },
      draft: "",
      mobilePanel: "chat",
      settings: { open: false, section: "agents" },
      agentEditor: { open: false, agentId: null },
      setWorkspace: (update) =>
        set((s) => ({ workspace: apply(update, s.workspace) })),
      setDraft: (draft) => set({ draft }),
      setMobilePanel: (mobilePanel) => set({ mobilePanel }),
      setSettings: (update) =>
        set((s) => ({ settings: apply(update, s.settings) })),
      setAgentEditor: (update) =>
        set((s) => ({ agentEditor: apply(update, s.agentEditor) })),
    }),
    {
      name: storageKey,
      storage,
      partialize: (s) => ({ workspace: s.workspace }),
      // Loaded after hydration (see RootDocument) so the first client render
      // matches the server's.
      skipHydration: true,
    },
  ),
);
