/**
 * `/plugins` against a real host: plugin directories under the host's `plugins/`, read through the
 * `plugins` target, and turned on per agent with `agents.update`.
 */
import type { AgentView, PluginView } from "@eta/client-contracts";
import type { HostObserver } from "../ext-support/host-observer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugins from "../../src/ext/plugins";
import { observeHost } from "../ext-support/host-observer";
import { LIST_KEYS } from "../ext-support/keys";
import { recordCalls } from "../ext-support/record-calls";
import { renderWithHost } from "../ext-support/render-with-host";
import { tempDir } from "../support/temp";
import { KEYS } from "../ui-support/render";

interface PluginSpec {
  name: string;
  version?: string;
  description?: string;
  /** A required value nobody has set: the plugin is `needs_config`. */
  needsConfig?: boolean;
  skills?: string[];
}

async function writePlugin(dataDir: string, spec: PluginSpec): Promise<void> {
  const dir = join(dataDir, "plugins", spec.name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: spec.name,
      version: spec.version ?? "1.0.0",
      description: spec.description ?? `The ${spec.name} plugin.`,
      ...(spec.needsConfig === true
        ? {
            extensions: {
              "tech.0xfe.eta": {
                config: {
                  token: { type: "string", title: "Token", required: true },
                },
              },
            },
          }
        : {}),
    }),
  );
  for (const skill of spec.skills ?? []) {
    await mkdir(join(dir, "skills", skill), { recursive: true });
    await writeFile(
      join(dir, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: The ${skill} skill.\n---\n\nDo ${skill}.\n`,
    );
  }
}

const views = (host: HostObserver) =>
  host.section<PluginView[]>("plugins", "list") ?? [];
const agents = (host: HostObserver) =>
  (host.section<AgentView[]>("agents", "list") ?? []).filter(
    (agent) => agent.systemRole !== "captain",
  );
const pluginsOf = (host: HostObserver, name: string) =>
  [
    ...(agents(host).find((agent) => agent.name === name)?.plugins ?? []),
  ].sort();

/**
 * A host with these plugin directories and agents (each with the plugins it has on), the
 * interface connected to it, and `/plugins` open.
 */
async function opened(
  specs: PluginSpec[],
  agentPlugins: Record<string, string[]> = {},
) {
  const dataDir = await tempDir("eta-tui-plugins-");
  for (const spec of specs) await writePlugin(dataDir, spec);
  const r = await renderWithHost({
    extensions: [plugins],
    host: { dataDir },
    columns: 120,
  });
  const host = await observeHost(r.host);
  await host.until(() => views(host).length === specs.length);
  for (const [name, enabled] of Object.entries(agentPlugins)) {
    await host.client.call("agents", "create", { name, plugins: enabled });
  }
  await host.until(
    () => agents(host).length === Object.keys(agentPlugins).length,
  );
  const calls = recordCalls(r.wire);
  await r.runCommand("/plugins");
  await r.waitFor("Plugins");
  const updates = () => calls.filter((call) => call.op === "agents.update");
  return { r, host, dataDir, updates };
}

async function openDetail(
  r: Awaited<ReturnType<typeof opened>>["r"],
  steps: number,
  description: string,
) {
  for (let i = 0; i < steps; i += 1) await r.press(KEYS.down);
  await r.press(KEYS.enter);
  await r.waitFor(description);
}

describe("/plugins", () => {
  it("lists each plugin's name, version, state and how many agents use it", async () => {
    const { r } = await opened(
      [
        { name: "alpha-tools", version: "1.2.3" },
        { name: "needy", version: "0.1.0", needsConfig: true },
      ],
      { Ada: ["alpha-tools"] },
    );
    await r.waitFor("needy");
    const screen = r.screen();
    expect(screen).toMatch(/alpha-tools\s+1\.2\.3 · ready · agents: 1/);
    expect(screen).toMatch(/needy\s+0\.1\.0 · needs configuring · agents: 0/);
    expect(screen).toContain("Enter open");
    expect(screen).toContain("Esc close");
  });

  it("says when there are no plugins", async () => {
    const { r } = await opened([]);
    await r.waitFor("No plugins on this host");
  });

  it("shows a plugin's problem in the list", async () => {
    const dataDir = await tempDir("eta-tui-plugins-");
    await mkdir(join(dataDir, "plugins", "broken"), { recursive: true });
    await writeFile(join(dataDir, "plugins", "broken", "plugin.json"), "{");
    const r = await renderWithHost({
      extensions: [plugins],
      host: { dataDir },
      columns: 160,
    });
    const host = await observeHost(r.host);
    await host.until(() => views(host).length === 1);
    const problem = views(host)[0]!.problem;
    expect(problem).not.toBeNull();
    await r.runCommand("/plugins");
    await r.waitFor("broken");
    // The row is cut at the screen's edge; its start is enough to know which text it is.
    expect(r.screen()).toContain(problem!.slice(0, 20));
  });

  it("shows a plugin's description and counts, and its agents ticked as the host has them", async () => {
    const { r } = await opened(
      [{ name: "alpha-tools", skills: ["lint", "fmt"] }],
      { Ada: ["alpha-tools"], Bea: [] },
    );
    await openDetail(r, 0, "The alpha-tools plugin.");
    expect(r.screen()).toContain("Skills: 2 · MCP servers: 0");
    expect(r.screen()).toContain("[x] Ada");
    expect(r.screen()).toContain("[ ] Bea");
    expect(r.screen()).toContain("Space tick");
    expect(r.screen()).toContain("Enter apply");
  });

  it("turns a plugin on for a ticked agent, keeping the agent's other plugins", async () => {
    const { r, host, updates } = await opened(
      [{ name: "alpha-tools" }, { name: "beta-tools" }],
      { Ada: ["beta-tools"], Bea: [] },
    );
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.waitFor("[ ] Ada");
    await r.press(LIST_KEYS.space);
    await r.waitFor("[x] Ada");
    await r.press(KEYS.enter);
    await host.until(
      () => pluginsOf(host, "Ada").join(",") === "alpha-tools,beta-tools",
    );
    expect(pluginsOf(host, "Bea")).toEqual([]);
    // Only the agent that changed is sent.
    expect(updates()).toHaveLength(1);
    await r.press(KEYS.escape);
    await r.waitFor(/alpha-tools\s+1\.0\.0 · ready · agents: 1/);
  });

  it("turns a plugin off for an unticked agent", async () => {
    const { r, host } = await opened(
      [{ name: "alpha-tools" }, { name: "beta-tools" }],
      { Ada: ["alpha-tools", "beta-tools"] },
    );
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.waitFor("[x] Ada");
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.enter);
    await host.until(() => pluginsOf(host, "Ada").join(",") === "beta-tools");
    await r.waitFor("[ ] Ada");
  });

  it("does not tick an agent for a plugin that needs configuring, and says to configure it on the desktop", async () => {
    const { r, host, updates } = await opened(
      [{ name: "needy", needsConfig: true }],
      { Ada: [] },
    );
    await openDetail(r, 0, "The needy plugin.");
    expect(r.screen()).toContain("Configure it in the desktop app");
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.enter);
    await r.settle(200);
    expect(r.screen()).toContain("[ ] Ada");
    expect(updates()).toEqual([]);
    expect(pluginsOf(host, "Ada")).toEqual([]);
  });

  it("lets an agent that has a plugin needing configuration turn it off", async () => {
    const { r, host, dataDir } = await opened([{ name: "late" }], {
      Ada: ["late"],
    });
    await writePlugin(dataDir, { name: "late", needsConfig: true });
    await host.client.call("plugins", "recheck", {});
    await host.until(() => views(host)[0]?.state === "needs_config");
    await r.waitFor("needs configuring");
    await openDetail(r, 0, "The late plugin.");
    await r.waitFor("[x] Ada");
    await r.press(LIST_KEYS.space);
    await r.waitFor("[ ] Ada");
    await r.press(KEYS.enter);
    await host.until(() => pluginsOf(host, "Ada").length === 0);
  });

  it("names the agent the host refused, and keeps the change it made for the other", async () => {
    const { r, host, dataDir, updates } = await opened([{ name: "flip" }], {
      Ada: ["flip"],
      Bea: [],
    });
    await openDetail(r, 0, "The flip plugin.");
    await r.waitFor("[x] Ada");
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.down);
    await r.press(LIST_KEYS.space);
    await r.waitFor("[x] Bea");
    // The plugin needs configuring from here on: the host lets Ada drop it and refuses it to Bea.
    await writePlugin(dataDir, { name: "flip", needsConfig: true });
    await host.client.call("plugins", "recheck", {});
    await r.waitFor("Configure it in the desktop app");
    await r.press(KEYS.enter);
    // The refusal's own line names the agent, so two refusals can be told apart.
    await r.waitFor(
      /│\s*Bea: plugin flip cannot be enabled: it needs configuring/,
    );
    expect(updates()).toHaveLength(2);
    await host.until(() => pluginsOf(host, "Ada").length === 0);
    expect(pluginsOf(host, "Bea")).toEqual([]);
    await r.waitFor("[ ] Ada");
    await r.waitFor("[ ] Bea");
  });

  it("sends one update for two Enters read at once", async () => {
    const { r, host, updates } = await opened([{ name: "alpha-tools" }], {
      Ada: [],
    });
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.press(LIST_KEYS.space);
    await r.waitFor("[x] Ada");
    await r.press("\r\r");
    await host.until(() => pluginsOf(host, "Ada").join(",") === "alpha-tools");
    await r.settle(300);
    expect(updates()).toHaveLength(1);
  });

  it("applies a tick made in the same read as the Enter", async () => {
    const { r, host, updates } = await opened([{ name: "alpha-tools" }], {
      Ada: [],
    });
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.waitFor("[ ] Ada");
    await r.press(" \r");
    await host.until(() => pluginsOf(host, "Ada").join(",") === "alpha-tools");
    expect(updates()).toHaveLength(1);
  });

  it("leaves an agent as it was for two Spaces read at once", async () => {
    const { r, updates } = await opened([{ name: "alpha-tools" }], {
      Ada: [],
    });
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.waitFor("[ ] Ada");
    await r.press("  ");
    await r.waitFor("[ ] Ada");
    await r.press(KEYS.enter);
    await r.settle(300);
    expect(updates()).toEqual([]);
  });

  it("goes back to the list on Esc, and closes on Esc", async () => {
    const { r } = await opened([{ name: "alpha-tools" }], { Ada: [] });
    await openDetail(r, 0, "The alpha-tools plugin.");
    await r.press(KEYS.escape);
    await r.waitForGone("The alpha-tools plugin.");
    expect(r.screen()).toContain("agents: 0");
    await r.press(KEYS.escape);
    await r.waitForGone("alpha-tools");
  });
});
