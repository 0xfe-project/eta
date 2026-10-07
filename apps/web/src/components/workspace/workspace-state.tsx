import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
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
const initialWorkspace: z.infer<typeof workspaceSchema> = {
  tasks: [],
  memory: "",
  sessionTheme: "claude",
};

type WorkspaceState = z.infer<typeof workspaceSchema>;
export type SettingsSection = "agents" | "providers" | "appearance";
export interface SettingsState {
  open: boolean;
  section: SettingsSection;
}
/** The agent editor: closed, creating (agentId null) or editing an agent. */
export interface AgentEditorState {
  open: boolean;
  agentId: string | null;
}
const WorkspaceContext = createContext<{
  workspace: WorkspaceState;
  setWorkspace: Dispatch<SetStateAction<WorkspaceState>>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  mobilePanel: "chat" | "workspace";
  setMobilePanel: Dispatch<SetStateAction<"chat" | "workspace">>;
  settings: SettingsState;
  setSettings: Dispatch<SetStateAction<SettingsState>>;
  agentEditor: AgentEditorState;
  setAgentEditor: Dispatch<SetStateAction<AgentEditorState>>;
} | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"chat" | "workspace">("chat");
  const [settings, setSettings] = useState<SettingsState>({
    open: false,
    section: "agents",
  });
  const [agentEditor, setAgentEditor] = useState<AgentEditorState>({
    open: false,
    agentId: null,
  });
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const result = workspaceSchema.safeParse(JSON.parse(saved));
        if (result.success) setWorkspace(result.data);
      }
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(workspace));
    } catch {
      toast.error("无法保存到当前浏览器，请保持页面打开以保留内容。");
    }
  }, [workspace, loaded]);

  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        setWorkspace,
        draft,
        setDraft,
        mobilePanel,
        setMobilePanel,
        settings,
        setSettings,
        agentEditor,
        setAgentEditor,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace requires WorkspaceProvider");
  return context;
}
