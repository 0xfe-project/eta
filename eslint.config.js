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
      // Generated from the shadcn registry.
      "apps/web/src/components/ui/**",
      "**/.venv/**",
      "**/out/**",
    ],
  },
  {
    // dprint's Biome plugin writes hex digits in lowercase (0xc0), and this
    // rule wants them uppercase (0xC0): the two fight on every save.
    rules: { "unicorn/number-literal-case": "off" },
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
    // Programs, not modules: the entry points of the server and the host and
    // the Bun scripts that check a package's production imports. They await at
    // the top level and print to the terminal on purpose.
    files: [
      "packages/eta-server/src/main.ts",
      "apps/eta/src/main.ts",
      // The desktop shell: it starts the host, then opens the window.
      "apps/desktop/src/bun/index.ts",
      "packages/eta-computer/scripts/*.ts",
      "packages/*/test/*.smoke.mjs",
    ],
    rules: { "antfu/no-top-level-await": "off", "no-console": "off" },
  },
  {
    files: ["packages/*/test/*.smoke.mjs"],
    languageOptions: { globals: globals.bunBuiltin },
  },
  {
    // The real-model smoke runs report what the model did on the terminal.
    files: [
      "packages/*/test/*.e2e.test.ts",
      "packages/eta-harness/src/testing/smoke-scenario.ts",
    ],
    rules: { "no-console": "off" },
  },
  {
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
    rules: { "no-restricted-globals": "off" },
  },
  {
    // `form.watch("x")` is a plain read of mutable state outside React. The React Compiler
    // memoises a component on its props, and `form` is the same object on every render, so that
    // read never invalidates the memo: the component keeps its old render and the field keeps its
    // old label until something remounts it. useWatch is a hook, so the compiler can see it.
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='watch']",
          message:
            "Use useWatch({ control: form.control, name }) — the React Compiler memoises form.watch reads away.",
        },
      ],
    },
  },
);
