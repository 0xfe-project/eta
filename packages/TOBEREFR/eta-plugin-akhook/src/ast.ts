/**
 * Structural matching with ast-grep (`@ast-grep/napi`).
 *
 * The napi package ships html, css, js, jsx, ts and tsx; the other languages are the
 * `@ast-grep/lang-*` parsers registered on first use. Everything is loaded lazily, so a host that
 * never evaluates an `ast` check never loads a native module.
 */
import { extname } from "node:path";

type NapiModule = typeof import("@ast-grep/napi");

/** Languages that need a `@ast-grep/lang-*` parser, by the name a rule may use. */
const DYNAMIC = new Set(["rust", "go", "python", "bash", "json", "yaml"]);

/** The parser package of a dynamic language. Literal specifiers, so bundlers can see them. */
async function parserOf(language: string): Promise<object> {
  switch (language) {
    case "rust":
      return (await import("@ast-grep/lang-rust")).default;
    case "go":
      return (await import("@ast-grep/lang-go")).default;
    case "python":
      return (await import("@ast-grep/lang-python")).default;
    case "bash":
      return (await import("@ast-grep/lang-bash")).default;
    case "json":
      return (await import("@ast-grep/lang-json")).default;
    default:
      return (await import("@ast-grep/lang-yaml")).default;
  }
}

const BUILTIN = new Set([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "html",
  "css",
]);

const ALIASES: Record<string, string> = {
  rs: "rust",
  golang: "go",
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  yml: "yaml",
};

/** akhook's path → language inference. */
const BY_EXTENSION: Record<string, string> = {
  rs: "rust",
  go: "go",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  jsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  sh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

export class AstError extends Error {
  override readonly name = "AstError";
}

/** The language a rule's `language` names, or `undefined` when it is not one we know. */
export function normalizeLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  const language = ALIASES[lower] ?? lower;
  return BUILTIN.has(language) || DYNAMIC.has(language) ? language : undefined;
}

/** The language of a file by its extension, as akhook infers it. */
export function languageForPath(path: string): string | undefined {
  return BY_EXTENSION[extname(path).slice(1).toLowerCase()];
}

let napi: Promise<NapiModule> | undefined;
let registered = new Set<string>();

async function loadNapi(): Promise<NapiModule> {
  napi ??= import("@ast-grep/napi").catch((error: unknown) => {
    napi = undefined;
    throw new AstError(
      `ast-grep is not available: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return await napi;
}

/**
 * ast-grep takes its dynamic languages in one registration (a second call does not add to the
 * first), so the first rule that needs any of them registers all of them.
 */
let dynamicRegistered: Promise<void> | undefined;

async function ensureLanguage(
  module: NapiModule,
  language: string,
): Promise<void> {
  if (BUILTIN.has(language)) return;
  if (!DYNAMIC.has(language))
    throw new AstError(`unknown AST language ${language}`);
  dynamicRegistered ??= (async () => {
    const parsers: Record<string, object> = {};
    for (const name of DYNAMIC) {
      try {
        parsers[name] = await parserOf(name);
      } catch {
        // A parser that cannot load fails only the rules that name its language.
      }
    }
    module.registerDynamicLanguage(parsers as never);
    registered = new Set(Object.keys(parsers));
  })();
  await dynamicRegistered;
  if (!registered.has(language))
    throw new AstError(`AST language ${language} is not available`);
}

/** The napi name of a language (built-ins are an enum value there). */
function langOf(module: NapiModule, language: string): string {
  const { Lang } = module;
  switch (language) {
    case "javascript":
      return Lang.JavaScript;
    case "jsx":
      return Lang.JavaScript;
    case "typescript":
      return Lang.TypeScript;
    case "tsx":
      return Lang.Tsx;
    case "html":
      return Lang.Html;
    case "css":
      return Lang.Css;
    default:
      return language;
  }
}

/**
 * The text of every match of `pattern` in `source`. A pattern that does not parse in the language
 * is an error, never a quiet non-match.
 */
export async function astMatches(
  language: string,
  pattern: string,
  source: string,
): Promise<string[]> {
  const module = await loadNapi();
  await ensureLanguage(module, language);
  try {
    const root = module.parse(langOf(module, language) as never, source).root();
    return root.findAll(pattern).map((node) => node.text());
  } catch (error) {
    throw new AstError(
      `AST pattern ${JSON.stringify(pattern)} (${language}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
