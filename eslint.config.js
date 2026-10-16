import antfu from "@antfu/eslint-config";
import globals from "globals";

// One config for the repository. Formatting belongs to dprint, so stylistic
// rules stay off; JSON is linted for validity and sorted package.json and
// tsconfig keys. Generated code is not linted.
export default antfu(
  {
    typescript: true,
    react: true,
    stylistic: false,
    jsonc: true,
    yaml: false,
    markdown: false,
    toml: false,
    ignores: [
      "**/*.gen.ts",
      // Generated from the pinned Codex's app-server schema.
      "apps/agent-runtime/src/protocol/**",
      // Generated from the shadcn and brainless registries.
      "apps/web/src/components/ui/**",
      "apps/web/src/components/brainless/**",
      "**/.venv/**",
      "**/out/**",
    ],
  },
  {
    // The typescript-eslint based rule misreads plain JS scopes and reports
    // every variable as "only used as a type"; use the core rule there.
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      "unused-imports/no-unused-vars": "off",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The @eta/* packages were ported verbatim from the other repository
    // (eta-old), which was formatted and linted with Biome. They stay under
    // this repository's rules except for the handful below, which are
    // Biome-era style or runtime-assumption differences rather than defects.
    // TODO: revisit the two regexes flagged by
    // regexp/no-super-linear-backtracking (harness/src/memory.ts,
    // harness/src/subagent-plan.ts) when that code is next touched.
    files: [
      "packages/eta-*/**",
      // Ported from the same place: the providers runtime, the codex auth kit and its test.
      "apps/eta/src/providers/**",
      "apps/eta/src/codex-auth.ts",
      "apps/eta/src/codex-provider.ts",
      "apps/eta/test/codex-auth.test.ts",
    ],
    rules: {
      "ts/method-signature-style": "off",
      "ts/no-use-before-define": "off",
      "antfu/no-top-level-await": "off",
      "node/prefer-global/process": "off",
      "node/prefer-global/buffer": "off",
      "unicorn/no-new-array": "off",
      "import/no-duplicates": "off",
      "no-control-regex": "off",
      "regexp/no-super-linear-backtracking": "off",
    },
  },
  {
    // dprint formats TypeScript with Biome, which writes hex literals in lower case; this
    // rule wants upper case, and the two can never both be satisfied. The repository's rule is
    // that formatting belongs to dprint, so the linter yields here.
    files: ["packages/eta-*/**", "packages/client-*/**", "apps/eta/**"],
    rules: { "unicorn/number-literal-case": "off" },
  },
  {
    // Smoke scenarios and tests print their progress on purpose; the .mjs ones
    // run under Bun and use its globals.
    files: [
      "packages/eta-*/test/**",
      "packages/eta-*/src/testing/**",
      "apps/eta/test/**",
    ],
    languageOptions: { globals: globals.bunBuiltin },
    rules: { "no-console": "off" },
  },
  {
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
    rules: { "no-restricted-globals": "off" },
  },
  {
    // Production server, run by Bun next to the built dist/.
    files: ["apps/web/server.js"],
    languageOptions: { globals: globals.bunBuiltin },
    rules: { "antfu/no-import-dist": "off" },
  },
);
