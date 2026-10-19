/** Bundles for tests: a directory written under the home a test host reads, and a fake MCP server. */
import type { BundleView } from "@eta/client-contracts";
import type { Client } from "./client";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The fake MCP server (stdio) the daemon's tests use. */
const FAKE_MCP = fileURLToPath(
  new URL("../../../daemon/test/fixtures/fake-mcp-stdio.ts", import.meta.url),
);

/** A value no test output may contain. */
export const SECRET = "tok-4f9a8b7c6d5e-secret";

/** What the fake server's `env` tool answers for a variable that holds `value`. */
export const digestOf = (value: string): string =>
  `set:${value.length}:${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;

/** Write a bundle into `<home>/.eta/bundles/<name>`; `files` map a path to its text. */
export async function writeBundle(
  home: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(home, ".eta", "bundles", name);
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
  return dir;
}

const RULES = `version: 1
rules:
  - id: no-forbidden
    on: shell_exec
    checks: [{argv: [touch, forbidden]}]
    message: the demo bundle forbids this
  - id: recall
    on: prompt_submit
    run:
      argv: [sh, -c, 'printf "{\\"context\\": \\"hook-token-len:%s\\"}" "\${#DEMO_TOKEN}"']
`;

/**
 * The bundle most tests use: a secret and a plain setting, a skill with a reference, the fake
 * MCP server as `fake`, and hook rules (one that denies a command, one that adds a line to the
 * prompt using the secret).
 */
export function demoFiles(
  extra: { name?: string; requires?: string[] } = {},
): Record<string, string> {
  return {
    "plugin.json": JSON.stringify({
      name: extra.name ?? "demo",
      version: "1.0.0",
      description: "Demo",
      requires: extra.requires ?? [],
      config: {
        type: "object",
        required: ["DEMO_TOKEN"],
        properties: {
          DEMO_TOKEN: {
            type: "string",
            title: "Token",
            writeOnly: true,
            maxLength: 100,
          },
          DEMO_REGION: { type: "string", title: "Region", maxLength: 20 },
        },
      },
    }),
    "mcp.json": JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [FAKE_MCP] },
      },
    }),
    "skills/demo-skill/SKILL.md":
      "---\nname: demo-skill\ndescription: Use the demo bundle's things.\n---\n# Demo\nSee references/setup.md.\n",
    "skills/demo-skill/references/setup.md": "How to set the demo up.\n",
    "akhook.yml": RULES,
  };
}

/** The bundles the client has been told of, once it holds them. */
export function listed(client: Client): BundleView[] {
  return client.section<BundleView[]>("bundles", "list") ?? [];
}

/** Every file under `dir`, by path; for finding where a value was written down. */
export async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(dir);
  return found;
}

/** The files under `dir` whose bytes contain `needle`. */
export async function filesContaining(
  dir: string,
  needle: string,
): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await filesUnder(dir)) {
    // The database's journal and the fake model's streams are not text we care to skip: read all.
    const data = await readFile(file).catch(() => undefined);
    if (data?.includes(needle) === true) hits.push(file);
  }
  return hits;
}
