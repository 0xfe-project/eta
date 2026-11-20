import { createHash } from "node:crypto";

const SECTIONS = ["decision", "preference", "lesson"] as const;
export type MemorySection = (typeof SECTIONS)[number];

function isSection(value: string): value is MemorySection {
  return (SECTIONS as readonly string[]).includes(value);
}

export interface FileEntry {
  id: string;
  text: string;
  section: MemorySection;
  path: string;
}

const hashText = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

export function parseMemoryFile(path: string, text: string): FileEntry[] {
  const out: FileEntry[] = [];
  let section: MemorySection | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      section = isSection(heading) ? heading : undefined;
      continue;
    }
    if (section === undefined) continue;
    const bullet = line.trimStart();
    if (!bullet.startsWith("- ")) continue;
    let body = bullet.slice(2).trim();
    const tag = /^\[[^\]]+\]\s+/.exec(body);
    if (tag !== null) body = body.slice(tag[0].length).trim();
    if (body === "") continue;
    out.push({
      id: `file:${hashText(`${path}\0${section}\0${body}`)}`,
      text: body,
      section,
      path,
    });
  }
  return out;
}

export function renderMemoryFile(entries: readonly FileEntry[]): string {
  return [
    "# eta memory (untrusted)",
    ...SECTIONS.flatMap((section) => [
      `## ${section}`,
      ...entries
        .filter((entry) => entry.section === section)
        .map((entry) => `- ${entry.text}`),
    ]),
    "",
  ].join("\n");
}
