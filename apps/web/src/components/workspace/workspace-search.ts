import {
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
export const views = [
  { value: "overview", label: "概览" },
  { value: "tasks", label: "任务" },
  { value: "routines", label: "定时" },
  { value: "memory", label: "记忆" },
  { value: "capabilities", label: "能力" },
  { value: "inbox", label: "确认" },
] as const;

const viewParser = parseAsStringLiteral([
  "overview",
  "tasks",
  "routines",
  "memory",
  "capabilities",
  "inbox",
] as const)
  .withDefault("overview")
  .withOptions({ history: "push" });
export const validateWorkspaceSearch = createStandardSchemaV1(
  // The routines tab's place: a routine, one of its runs, or its editor.
  {
    view: viewParser,
    routine: parseAsString,
    run: parseAsString,
    edit: parseAsString,
  },
  { partialOutput: true },
);
export function useWorkspaceView() {
  return useQueryState("view", viewParser);
}
