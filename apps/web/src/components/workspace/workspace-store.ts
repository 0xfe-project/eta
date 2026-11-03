import type { PersistStorage, StorageValue } from "zustand/middleware";
import { toast } from "sonner";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { translate } from "@/lib/i18n";

export const storageKey = "eta.workspace.v1";

// Local UI state only; everything else lives in the control plane. Zod
// drops fields this schema does not have.
const workspaceSchema = z.object({
  selectedGroupId: z.string().max(64).optional(),
  selectedAgentId: z.string().max(64).optional(),
  // Preselected model for new agents.
  lastModel: z.string().max(100).optional(),
  // The task page as last left: rows or a board.
  taskLayout: z.enum(["list", "board"]).optional(),
  // 圈选元素 (lib/element-picker.ts); unset follows the build.
  reactGrab: z.boolean().optional(),
  // The chat's right-edge rail (transcript-rail.tsx); unset is off.
  transcriptRail: z.boolean().optional(),
  // The sidebar's agent section, folded down to its heading.
  agentsCollapsed: z.boolean().optional(),
});

export type WorkspaceState = z.infer<typeof workspaceSchema>;
export type SettingsSection =
  | "agents"
  | "providers"
  | "approvals"
  | "machines"
  | "bundles"
  | "mcp"
  | "email"
  | "connections"
  | "archived"
  | "appearance";
interface SettingsState {
  open: boolean;
  section: SettingsSection;
}
/** The agent editor: closed, creating (agentId null) or editing an agent. */
interface AgentEditorState {
  open: boolean;
  agentId: string | null;
}
/**
 * Starting a conversation: closed, or open on the project it should begin in.
 *
 * A layer like settings, not a page: the form is two choices, and leaving the conversation behind
 * to make one meant the sidebar and the panel went away and the screen was mostly empty.
 */
interface NewConversationState {
  open: boolean;
  projectId?: string | undefined;
}

type Update<T> = T | ((state: T) => T);

interface WorkspaceStore {
  /** Persisted in this browser. */
  workspace: WorkspaceState;
  mobilePanel: "chat" | "workspace";
  /**
   * The member the conversation is narrowed to, or null for everyone.
   *
   * Kept here rather than in one component because two panels write it: the member rows in the
   * sidebar and the member cards in the panel are the same action, and a focus that lives in
   * either one would be a focus the other cannot see. Not persisted — a reload is not a reason to
   * still be looking at one agent.
   */
  focusedAgentId: string | null;
  setFocusedAgent: (agentId: string | null) => void;
  settings: SettingsState;
  agentEditor: AgentEditorState;
  newConversation: NewConversationState;
  setWorkspace: (update: Update<WorkspaceState>) => void;
  setMobilePanel: (panel: "chat" | "workspace") => void;
  /** Shows the side panel: over the chat when narrow, unfolded when wide. */
  showPanel: () => void;
  setSettings: (update: Update<SettingsState>) => void;
  setAgentEditor: (update: Update<AgentEditorState>) => void;
  setNewConversation: (update: Update<NewConversationState>) => void;
}

function apply<T>(update: Update<T>, state: T): T {
  return typeof update === "function"
    ? (update as (state: T) => T)(state)
    : update;
}

type Persisted = Pick<WorkspaceStore, "workspace">;

// The bare workspace object under its key, validated on load.
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
      toast.error(translate("common:errors.storageUnavailable"));
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

// A module-level store; saved state is loaded in main.tsx before the first
// render.
export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set) => ({
      workspace: {},
      mobilePanel: "chat",
      focusedAgentId: null,
      setFocusedAgent: (focusedAgentId) => set({ focusedAgentId }),
      settings: { open: false, section: "agents" },
      agentEditor: { open: false, agentId: null },
      newConversation: { open: false },
      setWorkspace: (update) =>
        set((s) => ({ workspace: apply(update, s.workspace) })),
      setMobilePanel: (mobilePanel) => set({ mobilePanel }),
      showPanel: () =>
        set((s) => ({
          mobilePanel: "workspace",
          workspace: s.workspace,
        })),
      setSettings: (update) =>
        set((s) => ({ settings: apply(update, s.settings) })),
      setAgentEditor: (update) =>
        set((s) => ({ agentEditor: apply(update, s.agentEditor) })),
      setNewConversation: (update) =>
        set((s) => ({ newConversation: apply(update, s.newConversation) })),
    }),
    {
      name: storageKey,
      storage,
      partialize: (s) => ({ workspace: s.workspace }),
      // Loaded in main.tsx before the first render (see skipHydration).
      skipHydration: true,
    },
  ),
);
