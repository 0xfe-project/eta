import { parseAsString, useQueryStates } from "nuqs";

// Where the tasks tab is: the list, a task (its id), or "new".
const navParsers = { task: parseAsString };

export function useTaskNav() {
  return useQueryStates(navParsers, { history: "push" });
}
