// Text size goes through the type scale (`typeScale` in src/components/theme.ts):
// `Label variant="small"`, `Markdown variant=…`, `type("small").size`. This fails
// on a size or line height written as a number, so a new one cannot slip in.
// Icon and control sizes are not text and are left alone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dir, "..");
const theme = join(root, "src", "components", "theme.ts");

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) =>
    sources(join(path, name)).filter((file) => /\.tsx?$/.test(file)),
  );
}

/** The opening tags of `name` in `source`, with the offset each starts at. */
function tags(source: string, name: string) {
  const found: { at: number; text: string }[] = [];
  const start = new RegExp(`<${name}\\b`, "g");
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 0;
    let end = match.index + name.length + 1;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    found.push({ at: match.index, text: source.slice(match.index, end + 1) });
  }
  return found;
}

const rules: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(?:fontSize|lineHeight):[^,;}\n]*\d/g,
    message: "a font size or line height written as a number",
  },
  {
    pattern:
      /\b(?:label|title|description|count|detail)(?:Size|Line)[=:][^,;}\n]*\d/g,
    message: "a text size passed as a number",
  },
];

const problems: string[] = [];
const line = (source: string, at: number) =>
  source.slice(0, at).split("\n").length;

for (const file of [...sources(join(root, "src")), join(root, "App.tsx")]) {
  if (file === theme) continue;
  const source = readFileSync(file, "utf8");
  const where = (at: number) => `${relative(root, file)}:${line(source, at)}`;
  for (const rule of rules) {
    for (const match of source.matchAll(rule.pattern)) {
      const text = source.split("\n")[line(source, match.index) - 1]!.trim();
      problems.push(`${where(match.index)}: ${rule.message}: ${text}`);
    }
  }
  for (const name of ["Label", "Caption", "Markdown"]) {
    for (const tag of tags(source, name)) {
      const attribute = /\s(size|line)=\{/.exec(tag.text);
      if (attribute) {
        problems.push(
          `${where(tag.at + attribute.index)}: <${name} ${attribute[1]}=…> takes a variant from the type scale instead`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(
    `Text sizes must come from the type scale (typeScale in src/components/theme.ts):\n${problems.join("\n")}`,
  );
  process.exit(1);
}
