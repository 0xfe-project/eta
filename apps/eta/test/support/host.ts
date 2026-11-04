/** What every test here needs: a host on a free port, in a temp directory, with scripted models. */
import type { Host, HostOptions } from "../../src/host";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach } from "vitest";
import { startHost } from "../../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A fresh empty directory, removed after the test. */
export async function tempDir(prefix = "eta-app-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * A built web as the web build leaves it: `index.html`, hashed files under `assets/`, a file
 * outside it, and the `BUILD` id next to `index.html`.
 */
export async function fakeWeb(buildId: string | null = "b1"): Promise<string> {
  const dir = await tempDir("eta-web-");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>eta</title>");
  await writeFile(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(dir, "sw.js"), "// service worker");
  if (buildId !== null) await writeFile(join(dir, "BUILD"), buildId);
  return dir;
}

export async function testHost(
  overrides: Partial<HostOptions> = {},
): Promise<Host> {
  const dataDir = overrides.dataDir ?? (await tempDir());
  const host = await startHost({
    dataDir,
    port: 0,
    // The scripted model layer: the subject is the host, not a provider, and a real one would
    // make these tests depend on the network.
    models: fakeModels([
      assistantMessage({ content: [{ type: "text", text: "fake answer" }] }),
    ]) as never,
    // Personas are read from the agent's home; the real one is not this test's business.
    home: dataDir,
    network: false,
    // The machine's Claude Code or Codex are not this test's business: a test that is about
    // runtimes hands in scripted ones.
    runtimes: false,
    ...overrides,
    // The real user's akhook file is not this test's business either.
    akhook: {
      userConfigPath: join(dataDir, "no-user-akhook.yml"),
      ...overrides.akhook,
    },
  });
  hosts.push(host);
  return host;
}
