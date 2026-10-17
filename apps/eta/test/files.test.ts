import type { Host } from "../src/host";
/**
 * The project's files, for the composer's `@` (FRONTEND_REFACTOR.md §5.2, P9).
 *
 * Two things are being asserted, and neither is about listing a directory: paths come back
 * relative to the group's folder (that is what a mention means), and the directories nobody means
 * are skipped rather than filtered afterwards.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (host: Host, method: string, path: string, body?: unknown) =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

async function project(): Promise<string> {
  const root = await scratch("eta-project-");
  await mkdir(join(root, "src", "app"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "# project\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(root, "src", "app", "main.ts"), "export {};\n", "utf8");
  await writeFile(
    join(root, "node_modules", "left-pad", "index.js"),
    "",
    "utf8",
  );
  await writeFile(join(root, ".git", "config"), "", "utf8");
  return root;
}

async function start(): Promise<Host> {
  const host = await assembleHost({
    dataDir: await scratch("eta-files-"),
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

describe("a group's files", () => {
  it("are listed relative to the group's folder, with the noise left out", async () => {
    const host = await start();
    const root = await project();
    const agent = (await (
      await send(host, "POST", "/agents", { name: "builder" })
    ).json()) as {
      id: string;
    };
    const group = (await (
      await send(host, "POST", "/groups", {
        name: "app",
        cwd: root,
        agentIds: [agent.id],
      })
    ).json()) as { group: { id: string } };

    const body = (await (
      await send(host, "GET", `/api/v1/files?group_id=${group.group.id}`)
    ).json()) as { files: string[]; cwd: string | null };
    expect(body.cwd).toBe(root);
    expect(body.files).toEqual([
      "README.md",
      "src/app/main.ts",
      "src/index.ts",
    ]);
    // Relative, not absolute: a mention is a path the agent can open from where it runs.
    expect(body.files.every((file) => !file.startsWith("/"))).toBe(true);
  });

  it("narrows when the caller already knows what it is looking for", async () => {
    const host = await start();
    const root = await project();
    const agent = (await (
      await send(host, "POST", "/agents", { name: "builder" })
    ).json()) as {
      id: string;
    };
    const group = (await (
      await send(host, "POST", "/groups", {
        name: "app",
        cwd: root,
        agentIds: [agent.id],
      })
    ).json()) as { group: { id: string } };
    const body = (await (
      await send(host, "GET", `/api/v1/files?group_id=${group.group.id}&q=main`)
    ).json()) as { files: string[] };
    expect(body.files).toEqual(["src/app/main.ts"]);
  });

  it("answers an unbound group with no files, not with the host's own directory", async () => {
    const host = await start();
    const group = (await (
      await send(host, "POST", "/groups", { name: "loose" })
    ).json()) as { group: { id: string } };
    const body = (await (
      await send(host, "GET", `/api/v1/files?group_id=${group.group.id}`)
    ).json()) as { files: string[]; cwd: string | null };
    expect(body).toEqual({ files: [], cwd: null });
  });
});
