/**
 * Phase 3 backend integration tests:
 * - Exposes bundled `agents/*.md` definitions on `PluginView.bundledAgents` for local native and
 *   foreign (Claude Code / Cursor) plugins without disturbing `PluginView.agents` (enabled eta agents).
 * - Exposes bundled `agents/*.md` definitions on `MarketPreview.bundledAgents` for git previews.
 */
import type { PluginView } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { MachineStore } from "../src/machines/store";
import { Market } from "../src/plugins/market";
import { Plugins } from "../src/plugins/service";
import { SettingStore } from "../src/settings/store";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
  return out.trim();
}

async function makeEnv() {
  const dataDir = await tempDir("eta-p3-");
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  applyMigrations(db, loadMigrations());
  const agents = new AgentStore(db);
  const machines = new MachineStore(db);
  machines.ensurePrimary({ name: "primary", home: "/home/u", os: "linux" });
  const settings = new SettingStore(db);
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 7),
    agents,
    machines,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  return { dataDir, db, agents, machines, settings, plugins };
}

describe("bundledAgents on PluginView for local plugins", () => {
  it("exposes bundled agents from native and Claude Code local plugins while keeping enabled agents separate", async () => {
    const { dataDir, agents, plugins } = await makeEnv();

    // 1. Native local plugin with frontmatter & plain markdown agents
    const nativeDir = join(dataDir, "plugins", "native-pack");
    await mkdir(join(nativeDir, "agents"), { recursive: true });
    await writeFile(
      join(nativeDir, "plugin.json"),
      JSON.stringify({
        $schema: PLUGIN_SCHEMA,
        name: "native-pack",
        version: "1.0.0",
        description: "Local pack",
      }),
    );
    await writeFile(
      join(nativeDir, "agents", "code-reviewer.md"),
      [
        "---",
        "name: Code Reviewer",
        "description: Reviews code for bugs and regressions.",
        "tools: Read, Grep",
        "---",
        "",
        "Carefully review pull requests and cite concrete risks.",
      ].join("\n"),
    );
    await writeFile(
      join(nativeDir, "agents", "docs-writer.md"),
      "# Docs Writer\n\nWrites clear user guides.\n\nKeep examples concise.\n",
    );

    // 2. Claude Code layout plugin with custom manifest.agents path
    const claudeDir = join(dataDir, "plugins", "claude-pack");
    await mkdir(join(claudeDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(claudeDir, "agents"), { recursive: true });
    await mkdir(join(claudeDir, "extra"), { recursive: true });
    await writeFile(
      join(claudeDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "claude-pack",
        agents: ["./agents/", "./extra/triage.md"],
      }),
    );
    await writeFile(
      join(claudeDir, "agents", "qa-bot.md"),
      "Verify edge cases before merging.",
    );
    await writeFile(
      join(claudeDir, "extra", "triage.md"),
      "---\nname: Issue Triage\ndescription: Categorizes incoming issues.\n---\n\nLabel and prioritize bug reports.",
    );

    // 3. Minimal plugin without agents/
    const plainDir = join(dataDir, "plugins", "plain-pack");
    await mkdir(plainDir, { recursive: true });
    await writeFile(
      join(plainDir, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "plain-pack" }),
    );

    await plugins.registry.refresh();
    const ada = agents.create({ name: "Ada", model: "openai:gpt-5" });
    plugins.rows.setEnabled(ada.id, ["native-pack"]);

    const byName = Object.fromEntries(
      plugins.view().map((item) => [item.name, item]),
    );

    expect(byName["native-pack"]!.agents).toEqual([
      { id: ada.id, name: "Ada" },
    ]);
    expect(byName["native-pack"]!.bundledAgents).toEqual([
      {
        id: "code-reviewer",
        name: "Code Reviewer",
        description: "Reviews code for bugs and regressions.",
        path: "agents/code-reviewer.md",
        instructions: "Carefully review pull requests and cite concrete risks.",
      },
      {
        id: "docs-writer",
        name: "Docs Writer",
        description: "Writes clear user guides.",
        path: "agents/docs-writer.md",
        instructions:
          "# Docs Writer\n\nWrites clear user guides.\n\nKeep examples concise.",
      },
    ]);

    expect(byName["claude-pack"]!.reports).toEqual([]);
    expect(byName["claude-pack"]!.bundledAgents).toEqual([
      {
        id: "qa-bot",
        name: "Qa Bot",
        description: "",
        path: "agents/qa-bot.md",
        instructions: "Verify edge cases before merging.",
      },
      {
        id: "triage",
        name: "Issue Triage",
        description: "Categorizes incoming issues.",
        path: "extra/triage.md",
        instructions: "Label and prioritize bug reports.",
      },
    ]);

    expect(byName["plain-pack"]!.bundledAgents).toEqual([]);
  });

  it("publishes bundledAgents over the live plugins wire target", async () => {
    const dataDir = await tempDir("eta-p3-wire-");
    const w = await world({ dataDir });
    const pluginDir = join(dataDir, "plugins", "wire-agents");
    await mkdir(join(pluginDir, "agents"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "wire-agents" }),
    );
    await writeFile(
      join(pluginDir, "agents", "helper.md"),
      "---\nname: Helper\ndescription: Assists with tasks.\n---\n\nBe concise and accurate.",
    );

    await w.client.call("plugins", "recheck", {});
    w.client.subscribe("plugins");
    await until(() =>
      (w.client.section<PluginView[]>("plugins", "list") ?? []).some(
        (item) => item.name === "wire-agents",
      ),
    );
    const list = w.client.section<PluginView[]>("plugins", "list") ?? [];
    const wirePlugin = list.find((item) => item.name === "wire-agents")!;
    expect(wirePlugin.bundledAgents).toEqual([
      {
        id: "helper",
        name: "Helper",
        description: "Assists with tasks.",
        path: "agents/helper.md",
        instructions: "Be concise and accurate.",
      },
    ]);
  });
});

describe("bundledAgents on MarketPreview", () => {
  it("exposes bundled agents in market previews for Claude Code and Cursor plugins", async () => {
    const { dataDir, settings, plugins } = await makeEnv();
    const repoDir = await tempDir("eta-p3-repo-");
    await git(repoDir, "init", "-q", "-b", "main");
    await git(repoDir, "config", "uploadpack.allowAnySHA1InWant", "true");

    const claudePlugin = join(repoDir, "claude-bundle");
    await mkdir(join(claudePlugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(claudePlugin, "agents"), { recursive: true });
    await writeFile(
      join(claudePlugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "claude-bundle",
        description: "Bundled agents from Claude plugin",
        agents: "./agents/",
      }),
    );
    await writeFile(
      join(claudePlugin, "agents", "security-reviewer.md"),
      [
        "---",
        "name: Security Reviewer",
        "description: >",
        "  Finds auth and injection",
        "  vulnerabilities.",
        "model: opus",
        "---",
        "",
        "Inspect all user inputs and authorization checks.",
      ].join("\n"),
    );

    const noAgentsPlugin = join(repoDir, "empty-bundle");
    await mkdir(join(noAgentsPlugin, ".cursor-plugin"), { recursive: true });
    await writeFile(
      join(noAgentsPlugin, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "empty-bundle" }),
    );

    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-qm", "initial");
    const sha = await git(repoDir, "rev-parse", "HEAD");
    const repoUrl = `file://${repoDir}`;

    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            plugins: [
              {
                name: "claude-bundle",
                description: "Bundled agents from Claude plugin",
                source: {
                  source: "git-subdir",
                  url: repoUrl,
                  path: "claude-bundle",
                  sha,
                },
              },
              {
                name: "empty-bundle",
                description: "No agents",
                source: {
                  source: "git-subdir",
                  url: repoUrl,
                  path: "empty-bundle",
                  sha,
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    cleanups.push(() => server.stop(true));

    const market = new Market({
      settings,
      plugins,
      dataDir,
      schemes: ["https:", "file:"],
    });
    const catalogUrl = `http://127.0.0.1:${server.port}/marketplace.json`;
    for (const source of market.sources()) market.removeSource(source.url);
    market.addSource(catalogUrl, "Test");

    const preview = await market.preview("claude-bundle", catalogUrl);
    expect(preview.reports).toEqual([]);
    expect(preview.bundledAgents).toEqual([
      {
        id: "security-reviewer",
        name: "Security Reviewer",
        description: "Finds auth and injection vulnerabilities.",
        path: "agents/security-reviewer.md",
        instructions: "Inspect all user inputs and authorization checks.",
      },
    ]);

    const emptyPreview = await market.preview("empty-bundle", catalogUrl);
    expect(emptyPreview.bundledAgents).toEqual([]);
  });
});
