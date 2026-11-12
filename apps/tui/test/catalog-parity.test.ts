/**
 * Every interface text exists in both languages with the same placeholders. This walks the
 * catalogs exported anywhere under `src/` and every extension in the registry, so texts added by
 * later features are held to it without anyone listing them here.
 */
import type { Localized, MessageCatalog } from "../src/extensions/types";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { extensions } from "../src/extensions.gen";
import { placeholdersOf } from "../src/i18n/messages";

const srcDir = resolve(import.meta.dirname, "../src");
// The entry point runs the program when imported.
const NOT_IMPORTED = new Set(["main.tsx"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function isCatalog(value: unknown): value is MessageCatalog {
  if (typeof value !== "object" || value === null) return false;
  const { en, zh } = value as Record<string, unknown>;
  return isStringRecord(en) && isStringRecord(zh);
}

interface Pair {
  where: string;
  en: Record<string, string>;
  zh: Record<string, string>;
}

const catalogFiles = new Map<string, MessageCatalog[]>();
for (const file of sourceFiles(srcDir)) {
  const name = relative(srcDir, file).replaceAll("\\", "/");
  if (NOT_IMPORTED.has(name)) continue;
  const exports = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  catalogFiles.set(name, Object.values(exports).filter(isCatalog));
}

function pairs(): Pair[] {
  const found: Pair[] = [];
  for (const [file, catalogs] of catalogFiles)
    catalogs.forEach((c, i) =>
      found.push({ where: `${file} catalog #${i + 1}`, ...c }),
    );
  const one = (where: string, text: Localized) =>
    found.push({ where, en: { text: text.en }, zh: { text: text.zh } });
  for (const ext of extensions) {
    if (ext.messages)
      found.push({ where: `extension ${ext.id} messages`, ...ext.messages });
    for (const command of ext.commands ?? []) {
      const at = `extension ${ext.id} /${command.name}`;
      one(`${at} summary`, command.summary);
      for (const arg of command.args)
        one(`${at} argument ${arg.name}`, arg.summary);
      for (const example of command.examples)
        one(`${at} example ${example.input}`, example.summary);
    }
  }
  return found;
}

describe("interface texts in both languages", () => {
  const all = pairs();

  it("walks the foundation's own catalog files, not only the registry", () => {
    // Files known to define catalogs: if the walk of src/ breaks, one of them goes missing.
    for (const file of [
      "ui/shell/messages.ts",
      "ui/screens/messages.ts",
      "ui/entry-messages.ts",
      "extensions/command-line.ts",
      "ext/help/messages.ts",
      "ext/install-service/messages.ts",
    ]) {
      expect(catalogFiles.get(file)?.length ?? 0, file).toBeGreaterThan(0);
      expect(
        all.some((p) => p.where.startsWith(`${file} catalog`)),
        file,
      ).toBe(true);
    }
  });

  it("exports every catalog a source file defines, so this walk sees it", () => {
    for (const [file, catalogs] of catalogFiles) {
      const text = readFileSync(join(srcDir, file), "utf8");
      const defined = [...text.matchAll(/\bdefineMessages\s*\(/g)].length;
      const isDefinition = file === "i18n/messages.ts";
      if (isDefinition) continue;
      expect(
        catalogs.length,
        `${file} defines catalogs it does not export`,
      ).toBeGreaterThanOrEqual(defined);
    }
  });

  it.each(all.map((p) => [p.where, p] as const))(
    "%s: same keys",
    (_where, pair) => {
      expect(Object.keys(pair.zh).sort()).toEqual(Object.keys(pair.en).sort());
    },
  );

  it.each(all.map((p) => [p.where, p] as const))(
    "%s: same placeholders per key",
    (_where, pair) => {
      for (const key of Object.keys(pair.en)) {
        expect(placeholdersOf(pair.zh[key] ?? ""), `key ${key}`).toEqual(
          placeholdersOf(pair.en[key] ?? ""),
        );
      }
    },
  );

  it.each(all.map((p) => [p.where, p] as const))(
    "%s: no empty text",
    (_where, pair) => {
      for (const [key, text] of [
        ...Object.entries(pair.en),
        ...Object.entries(pair.zh),
      ])
        expect(text.trim(), `key ${key}`).not.toBe("");
    },
  );
});
