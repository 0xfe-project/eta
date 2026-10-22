import { createStandardSchemaV1, useQueryStates } from "nuqs";
import { idParam } from "./id-param";

// Where the routines tab or page is: a routine, one of its runs, or an editor.
const navParsers = {
  routine: idParam,
  run: idParam,
  // "new", or the id of the routine being edited.
  edit: idParam,
};

export const validateRoutineSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useRoutineNav() {
  return useQueryStates(navParsers, { history: "push" });
}
