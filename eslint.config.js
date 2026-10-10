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
