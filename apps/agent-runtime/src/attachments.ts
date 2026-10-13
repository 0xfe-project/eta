// A message as the user wrote it (the control plane's parts: text, and
// files attached among it) as Codex's input. Each file is fetched through
// the runtime gateway, as this agent, onto the agent's volume once; images
// Codex can show the model go in as images, and every file is named by its
// path for the agent to read with its tools. No file's bytes go into text.

import type { UserInput } from "./protocol/v2/UserInput";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Part =
  | { type: "text"; text: string }
  | {
      type: "attachment";
      id: string;
      name: string;
      content_type: string;
      size: number;
    };

/** What the model can see as an image (Codex's localImage). */
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface Fetcher {
  gatewayUrl: string;
  agentKey: string;
  /** Where attachments are kept: <dir>/<id>/<name>. */
  dir: string;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The attachment on the volume, fetched unless it is there already. */
async function fetchAttachment(
  f: Fetcher,
  part: Extract<Part, { type: "attachment" }>,
): Promise<string> {
  const dir = join(f.dir, part.id);
  // The control plane cleaned the name: no directories in it.
  const path = join(dir, part.name);
  if (
    await stat(path).then(
      (s) => s.size === part.size,
      () => false,
    )
  ) {
    return path;
  }
  const response = await fetch(`${f.gatewayUrl}/attachments/v1/${part.id}`, {
    headers: { Authorization: `Bearer ${f.agentKey}` },
  });
  if (!response.ok || !response.body) {
    throw new Error(`attachment ${part.id}: ${response.status}`);
  }
  await mkdir(dir, { recursive: true });
  const partial = `${path}.part`;
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(partial),
  );
  await rename(partial, path);
  return path;
}

/** Codex's input for the parts, attachments fetched. */
export async function userInput(
  f: Fetcher,
  parts: Part[],
): Promise<UserInput[]> {
  const input: UserInput[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      input.push({ type: "text", text: part.text, text_elements: [] });
      continue;
    }
    const path = await fetchAttachment(f, part);
    const image = IMAGES.has(part.content_type);
    input.push({
      type: "text",
      text: `[${image ? "图片" : "附件"}：${part.name}（${part.content_type}，${size(part.size)}），已保存到 ${path}${image ? "" : "，需要时用工具读取"}]`,
      text_elements: [],
    });
    if (image) input.push({ type: "localImage", path });
  }
  return input;
}
