import { createStandardSchemaV1, useQueryStates } from "nuqs";
import { idParam } from "./id-param";

// Where the tasks tab or page is: the list, or a task (its id). How
// the page lays the list out is remembered in the browser (workspace-store).
const navParsers = {
  task: idParam,
};

export const validateTaskSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useTaskNav() {
  return useQueryStates(navParsers, { history: "push" });
}
