import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/, "");

// What makes `vitest --changed` (the pre-commit's test:changed) run a package's whole suite
// rather than the tests that import a changed file: a package.json or bun.lock (dependencies), a
// Vitest or Vite config, or this file. Setup files Vitest adds itself.
//
// Vitest's own defaults say the same with `**/package.json/**`, matched against absolute paths,
// and `**` does not cross a directory whose name starts with a dot. Task worktrees live under
// ~/.eta/worktrees, so there a changed config selected no tests at all. Anchored at the
// repository, `**` only walks inside it.
export const forceRerunTriggers = [
  `${root}/**/package.json`,
  `${root}/bun.lock`,
  `${root}/**/{vitest,vite}.config.*`,
  `${root}/vitest.shared.ts`,
];
