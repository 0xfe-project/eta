/**
 * Shell commands, taken apart (akhook's `shell.rs`).
 *
 * `argv` checks need the commands a script runs, not its text: `echo gh pr create` runs `echo`,
 * and `cd x && gh -R a/b pr create` runs `gh`. tree-sitter-bash (its wasm build) splits a script
 * into simple commands: the commands of lists, pipelines, subshells and substitutions, and the
 * scripts passed to `sh`/`bash`/`zsh`/`dash`/`ksh -c`. Each has its assignments and redirections
 * dropped and its words unquoted.
 */
import type { Node } from "web-tree-sitter";
import type { ArgvItem } from "./types";
import { basename } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { shellWasm } from "./wasm";

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
/** How deep `bash -c 'bash -c ...'` is followed. */
const MAX_DEPTH = 4;

let parser: Promise<Parser> | undefined;

function loadParser(): Promise<Parser> {
  parser ??= (async () => {
    const wasm = await shellWasm();
    await Parser.init({ wasmBinary: wasm.runtime });
    const language = await Language.load(wasm.bash);
    const created = new Parser();
    created.setLanguage(language);
    return created;
  })().catch((error: unknown) => {
    // A load that failed is not remembered: the next call tries again.
    parser = undefined;
    throw error;
  });
  return parser;
}

function strip(text: string, start: string, end: string): string {
  return text.startsWith(start) && text.endsWith(end)
    ? text.slice(start.length, text.length - end.length)
    : text;
}

function unescape(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") {
      index++;
      out += text[index] ?? "";
    } else {
      out += char;
    }
  }
  return out;
}

function unquote(node: Node): string {
  switch (node.type) {
    case "command_name":
    case "concatenation":
      return node.children.map(unquote).join("");
    case "raw_string":
      return strip(node.text, "'", "'");
    case "ansi_c_string":
      return strip(node.text, "$'", "'");
    case "string":
      return unescape(strip(node.text, '"', '"'));
    case "word":
    case "number":
      return unescape(node.text);
    default:
      return node.text;
  }
}

function words(command: Node): string[] {
  const result: string[] = [];
  let named = false;
  for (const child of command.children) {
    if (!child.isNamed) continue;
    if (child.type === "command_name") named = true;
    else if (
      !named ||
      child.type.endsWith("redirect") ||
      child.type === "variable_assignment"
    )
      continue;
    result.push(unquote(child));
  }
  return result;
}

function collect(
  parserInstance: Parser,
  script: string,
  commands: string[][],
  depth: number,
): void {
  const tree = parserInstance.parse(script);
  if (tree === null) return;
  try {
    const stack: Node[] = [tree.rootNode];
    // Depth-first in source order, like the Rust walk.
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (let index = node.childCount - 1; index >= 0; index--)
        stack.push(node.child(index)!);
      if (node.type !== "command") continue;
      const found = words(node);
      if (found.length === 0) continue;
      if (depth < MAX_DEPTH && SHELLS.includes(basename(found[0]!))) {
        const flag = found.indexOf("-c");
        const inner = flag < 0 ? undefined : found[flag + 1];
        if (inner !== undefined)
          collect(parserInstance, inner, commands, depth + 1);
      }
      commands.push(found);
    }
  } finally {
    tree.delete();
  }
}

/**
 * Every simple command in a shell script, as unquoted words: the commands of lists,
 * pipelines, subshells and substitutions, and the scripts passed to `bash -c` and friends.
 */
export async function simpleCommands(script: string): Promise<string[][]> {
  const instance = await loadParser();
  const commands: string[][] = [];
  collect(instance, script, commands, 0);
  return commands;
}

const itemMatches = (item: ArgvItem, word: string): boolean =>
  typeof item === "string" ? item === word : item.includes(word);

/**
 * The first item names the program (compared by basename); the others must appear among its
 * arguments in order, though not necessarily adjacent, so options in between
 * (`gh -R owner/repo pr create`) do not hide a match.
 */
export function argvMatches(
  pattern: readonly ArgvItem[],
  commandWords: readonly string[],
): boolean {
  const [program, ...rest] = pattern;
  const [first, ...args] = commandWords;
  if (program === undefined || first === undefined) return false;
  if (!itemMatches(program, basename(first))) return false;
  let at = 0;
  for (const item of rest) {
    while (at < args.length && !itemMatches(item, args[at]!)) at++;
    if (at >= args.length) return false;
    at++;
  }
  return true;
}
