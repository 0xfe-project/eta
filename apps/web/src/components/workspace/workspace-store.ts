import type { PersistStorage, StorageValue } from "zustand/middleware";
import { toast } from "sonner";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { translate } from "@/lib/i18n";

export const storageKey = "eta.workspace.v1";

// Local UI state only; everything else lives in the control plane. Read one
// field at a time (readWorkspace): what this schema does not have is dropped.
const workspaceSchema = z.object({
  selectedGroupId: z.string().max(64).optional(),
  selectedAgentId: z.string().max(64).optional(),
  // Preselected model for new agents.
  lastModel: z.string().max(100).optional(),
  // Element picker (lib/element-picker.ts); unset follows the build.
  reactGrab: z.boolean().optional(),
  // The chat's right-edge rail (transcript-rail.tsx); unset is off.
  transcriptRail: z.boolean().optional(),
  // How wide the chat's content runs (chat-panel.tsx); unset is standard.
  chatWidth: z.enum(["extra-narrow", "narrow", "standard", "full"]).optional(),
  // A font put in front of Eta Sans (lib/custom-font.ts); unset is the shipped face.
  customFont: z.string().max(64).optional(),
  // Its counterpart for the "mono" surfaces; unset follows customFont.
  customMonoFont: z.string().max(64).optional(),
  // The sidebar's agent section, folded down to its heading.
  agentsCollapsed: z.boolean().optional(),
  // The most height that section takes, dragged on its top edge (sidebar-tree.tsx); unset is
  // its content's height, up to two fifths of the screen.
  agentsHeight: z.number().int().positive().max(10_000).optional(),
  // Directories chosen on each machine, newest first, from before the host kept them
  // (`places.recent`). Read only to hand them over once (import-recent.ts), then removed.
  recentDirectories: z
    .record(z.string().max(64), z.array(z.string().max(4096)).max(5))
    .optional(),
  // Who each group's messages keep going to (lib/mentions.ts); no entry is the steward.
  stickyTargets: z
    .record(
      z.string().max(64),
      z.union([z.literal("everyone"), z.array(z.string().max(64))]),
    )
    .optional(),
});

export type WorkspaceState = z.infer<typeof workspaceSchema>;
export type SettingsSection =
  | "agents"
  | "providers"
  | "approvals"
  | "machines"
  | "mcp"
  | "acp"
  | "plugins"
  | "email"
  | "archived"
  | "appearance"
  | "host"
  | "update";
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

/**
 * The saved workspace, read one field at a time: a field that fails its own
 * schema costs only itself, and a field this schema does not have is dropped.
 * Null when the saved value is not an object at all (a torn write, `[]`,
 * `null`), so the caller keeps the state it has. Silent: the value may be a
 * hand edit or an older build's, and there is nothing for the user to do.
 */
function readWorkspace(saved: unknown): WorkspaceState | null {
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return null;
  }
  const fields = saved as Record<string, unknown>;
  const workspace: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(workspaceSchema.shape)) {
    if (!Object.hasOwn(fields, key)) continue;
    const result = schema.safeParse(fields[key]);
    if (result.success && result.data !== undefined) {
      workspace[key] = result.data;
    }
  }
  return workspace as WorkspaceState;
}

// The bare workspace object under its key, validated field by field on load.
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    try {
      const saved = localStorage.getItem(name);
      if (!saved) return null;
      const workspace = readWorkspace(JSON.parse(saved));
      return workspace ? { state: { workspace } } : null;
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
