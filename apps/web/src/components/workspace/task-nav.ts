import {
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from "nuqs";

// Where the tasks tab or page is: the list, a task (its id), or "new";
// the page also lays the list out as rows or a board, for everyone or one
// kind of assignee.
const navParsers = {
  task: parseAsString,
  layout: parseAsStringLiteral(["list", "board"] as const).withDefault("list"),
  scope: parseAsStringLiteral(["all", "user", "remote"] as const).withDefault(
    "all",
  ),
};

export const validateTaskSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useTaskNav() {
  return useQueryStates(navParsers, { history: "push" });
}
