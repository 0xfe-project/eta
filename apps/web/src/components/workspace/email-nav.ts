import { createStandardSchemaV1, useQueryStates } from "nuqs";
import { idParam } from "./id-param";

const navParsers = {
  thread: idParam,
};

export const validateEmailSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useEmailNav() {
  return useQueryStates(navParsers, { history: "push" });
}
