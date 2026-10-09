import { createStandardSchemaV1, parseAsString, useQueryState } from "nuqs";

// Whose memories the memory page shows; unset shows the newest agent's.
const navParsers = {
  agent: parseAsString,
};

export const validateMemorySearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useMemoryAgent() {
  return useQueryState("agent", navParsers.agent);
}
