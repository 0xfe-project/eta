import { createStandardSchemaV1, parseAsString, useQueryStates } from "nuqs";

// Where the tasks tab or page is: the list, a task (its id), or "new". How
// the page lays the list out is remembered in the browser (workspace-store).
const navParsers = {
  task: parseAsString,
};

export const validateTaskSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useTaskNav() {
  return useQueryStates(navParsers, { history: "push" });
}
