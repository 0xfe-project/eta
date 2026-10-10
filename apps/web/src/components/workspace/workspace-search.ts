import type { WorkspaceView } from "./types";
import {
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";

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
