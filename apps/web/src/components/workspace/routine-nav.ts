import { parseAsString, useQueryStates } from "nuqs";

// Where the routines tab is: a routine, one of its runs, or an editor.
const navParsers = {
  routine: parseAsString,
  run: parseAsString,
  // "new", or the id of the routine being edited.
  edit: parseAsString,
};

export function useRoutineNav() {
  return useQueryStates(navParsers, { history: "push" });
}
