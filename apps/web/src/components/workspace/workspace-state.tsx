import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import { z } from "zod";
import { toast } from "sonner";
const storageKey = "axp.workspace.v1";
const workspaceSchema = z.object({
  messages: z.array(
    z.object({ id: z.string(), content: z.string().max(10_000) }),
  ),
  tasks: z.array(
    z.object({ id: z.string(), title: z.string().max(200), done: z.boolean() }),
  ),
  memory: z.string().max(10_000),
  sessionTheme: z.enum(["claude", "codex", "grok"]).default("claude"),
});
const initialWorkspace: z.infer<typeof workspaceSchema> = {
  messages: [],
  tasks: [],
  memory: "",
  sessionTheme: "claude",
};

type WorkspaceState = z.infer<typeof workspaceSchema>;
const WorkspaceContext = createContext<{
  workspace: WorkspaceState;
  setWorkspace: Dispatch<SetStateAction<WorkspaceState>>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  mobilePanel: "chat" | "workspace";
  setMobilePanel: Dispatch<SetStateAction<"chat" | "workspace">>;
} | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"chat" | "workspace">("chat");
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
      toast.error(
        "无法保存到当前浏览器，请保持页面打开以保留内容。",
      );
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
