# Structural matching was removed with its native dependency

`@ast-grep/napi` is a napi addon: a compiled `.node` binary loaded into the process. eta runs
on Xmas, and Xmas loads JavaScript modules; it has no path for a native addon. The dependency is
therefore gone, and with it the `ast` check kind, which had no other way to match.

## What was deleted

- `@ast-grep/napi` and the grammar addons it needed at run time: `@ast-grep/lang-bash`,
  `lang-go`, `lang-json`, `lang-python`, `lang-rust`, `lang-yaml`. All seven are gone from
  `package.json`.
- `src/ast.ts`: the whole file (loading the addon, registering grammars, `astMatches`,
  `languageForPath`, `normalizeLanguage`).
- The `ast` arm of `CheckSpec` in `src/types.ts` and its parser in `src/config.ts`. A config
  with `ast:` is now a config error rather than a silently ignored check.
- The `ast` case in `rules.ts` (the `CompiledCheck` union, the compile arm, the `asts` field on
  compiled stream rules, the `holds()` branch) and the `astHolds` guard in `stream.ts`.
- `astCondition` in `src/preset.ts`: the preset no longer turns it into a check.

## What this costs

Five built-in rules were written with `astCondition` and no `condition`, so they now have
nothing to match on and are not packed at all:

- `go-bench-loop`
- `go-new-expr`
- `go-range-int`
- `ts-no-inline-cast-access`
- `ts-redundant-clear-guard`

The other 23 rules match on regex and are unaffected. Their Markdown sources under
`presets/omp/` are untouched: they are upstream copies, and rewriting them would hide what
upstream said.

## What was kept

`tree-sitter-bash` and `web-tree-sitter` are not napi. They ship WebAssembly, and
`src/wasm.ts` reads the `.wasm` files; `src/shell.ts` uses them to split a shell script into
commands. Both stay.

## What would bring it back

Either of these, both of which Xmas can load:

- A WebAssembly grammar (a `.wasm` tree-sitter language plus a pure-JS matcher) instead of the
  addon.
- Structural matching written into the Xmas runtime in Rust, reached through an `xmas:` module:
  the parse tree would be built where the addon currently builds it, and the pattern language
  would be ours.
