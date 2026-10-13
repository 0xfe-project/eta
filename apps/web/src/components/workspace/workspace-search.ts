import type { WorkspaceView } from "./types";
import { useLocation } from "@tanstack/react-router";
import {
  createParser,
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
import { useEffect } from "react";
import { useWorkspaceStore } from "./workspace-store";

/** The side panel's tabs that have a page in the full-window workspace. */
export const sectionPaths = {
  tasks: "/workspace/tasks",
  routines: "/workspace/routines",
  inbox: "/workspace/inbox",
} as const satisfies Partial<Record<WorkspaceView, string>>;

export const hasPage = (
  view: WorkspaceView,
): view is keyof typeof sectionPaths => view in sectionPaths;

/**
 * Where a section opens from the current mode: its page in the full-window
 * workspace, or its tab of the side panel beside the chat, which keeps the
 * chat (the agent is remembered in the browser, not in the URL).
 */
export function useSectionLink() {
  const fullWindow = useLocation({
    select: (location) => location.pathname.startsWith("/workspace"),
  });
  return (
    view: keyof typeof sectionPaths,
    search: { task?: string; routine?: string } = {},
  ) =>
    fullWindow
      ? ({ to: sectionPaths[view], search } as const)
      : ({ to: "/", search: { view, ...search } } as const);
}

export const views = [
  { value: "overview", label: "概览" },
  { value: "tasks", label: "任务" },
  { value: "routines", label: "定时" },
  { value: "inbox", label: "待处理" },
] as const;

const linkedViewParser = parseAsStringLiteral([
  "overview",
  "tasks",
  "routines",
  "inbox",
] as const);
// Any other view, like an old link to the memory tab the panel no longer
// has, opens the overview rather than failing the route.
const viewParser = createParser({
  parse: (value) => linkedViewParser.parse(value) ?? "overview",
  serialize: linkedViewParser.serialize,
})
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
 * Shows the panel on narrow screens, where it hides behind the chat, when
 * the URL opens one of its tabs: a link, a reload, back and forward.
 */
export function useShowLinkedView() {
  const [linked] = useQueryState("view", linkedViewParser);
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  useEffect(() => {
    if (linked) setMobilePanel("workspace");
  }, [linked, setMobilePanel]);
}
