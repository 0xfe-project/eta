import antfu from "@antfu/eslint-config";
import globals from "globals";

// Formatting belongs to dprint (Biome), so stylistic rules stay off; JSON,
// YAML and Markdown are only formatted, not linted.
export default antfu(
  {
    react: true,
    stylistic: false,
    jsonc: false,
    yaml: false,
    markdown: false,
    toml: false,
    ignores: ["dist/**", "out/**", "src/routeTree.gen.ts"],
  },
  {
    // Fast refresh hints are advice, not errors. TanStack route files must
    // export `Route`, and shadcn components export their variants.
    rules: { "react-refresh/only-export-components": "warn" },
  },
  {
    files: ["src/routes/**", "src/components/ui/**"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // The typescript-eslint based rule misreads plain JS scopes and reports
    // every variable as "only used as a type"; use the core rule there.
    files: ["**/*.js"],
    rules: {
      "unused-imports/no-unused-vars": "off",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
    rules: { "no-restricted-globals": "off" },
  },
  {
    // Production server, run by Bun next to the built dist/.
    files: ["server.js"],
    languageOptions: { globals: { Bun: "readonly" } },
    rules: { "antfu/no-import-dist": "off", "no-console": "off" },
  },
);
