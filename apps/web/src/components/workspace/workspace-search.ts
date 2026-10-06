import {
  createStandardSchemaV1,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
export const views = [
  { value: "overview", label: "概览" },
  { value: "tasks", label: "任务" },
  { value: "memory", label: "记忆" },
  { value: "capabilities", label: "能力" },
] as const;

const viewParser = parseAsStringLiteral([
  "overview",
  "tasks",
  "memory",
  "capabilities",
] as const)
  .withDefault("overview")
  .withOptions({ history: "push" });
export const validateWorkspaceSearch = createStandardSchemaV1(
  { view: viewParser },
  { partialOutput: true },
);
export function useWorkspaceView() {
  return useQueryState("view", viewParser);
}
