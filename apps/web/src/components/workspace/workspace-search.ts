import type { WorkspaceView } from "./types";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
import { useWorkspaceStore } from "./workspace-store";

/** The sections with a page in the full-window workspace. */
export const sectionPaths = {
  tasks: "/workspace/tasks",
  routines: "/workspace/routines",
  memory: "/workspace/memory",
  inbox: "/workspace/inbox",
} as const satisfies Partial<Record<WorkspaceView, string>>;

export const hasPage = (
  view: WorkspaceView,
): view is keyof typeof sectionPaths => view in sectionPaths;

export const views = [
  { value: "overview", label: "概览" },
  { value: "tasks", label: "任务" },
  { value: "routines", label: "定时" },
  { value: "memory", label: "记忆" },
  { value: "inbox", label: "待处理" },
] as const;

const viewParser = parseAsStringLiteral([
  "overview",
  "tasks",
  "routines",
  "memory",
  "inbox",
] as const)
  .withDefault("overview")
  .withOptions({ history: "push" });
export const validateWorkspaceSearch = createStandardSchemaV1(
  // The routines tab's place: a routine, one of its runs, or its editor;
  // the tasks tab's: a task or "new".
  {
    view: viewParser,
    task: parseAsString,
    routine: parseAsString,
    run: parseAsString,
    edit: parseAsString,
  },
  { partialOutput: true },
);
export function useWorkspaceView() {
  return useQueryState("view", viewParser);
}

/**
 * Shows a section: as the side panel's tab on the home page, or as its own
 * full-window page anywhere else (the tabs without one, on the home page).
 */
export function useShowSection() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const [, setView] = useWorkspaceView();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  return (view: WorkspaceView) => {
    if (pathname === "/") {
      void setView(view);
      setMobilePanel("workspace");
    } else if (hasPage(view)) void navigate({ to: sectionPaths[view] });
    else {
      setMobilePanel("workspace");
      void navigate({ to: "/", search: { view } });
    }
  };
}
