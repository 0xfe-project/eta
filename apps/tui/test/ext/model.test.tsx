/**
 * `/model` against a real host with two configured providers: which agent, which model, which
 * thinking level, and what the host's agent holds afterwards.
 */
import type { HostOptions } from "@eta/app/src/host";
import type {
  AgentRuntimeInfo,
  AgentView,
  MachineView,
} from "@eta/client-contracts";
import type { HostRendered } from "../ext-support/render-with-host";
import { describe, expect, it } from "vitest";
import model from "../../src/ext/model";
import { dataDirWith, hostAgents } from "../ext-support/host-data";
import { recordCalls } from "../ext-support/host-wire";
import { LIST_KEYS } from "../ext-support/keys";
import { renderWithHost } from "../ext-support/render-with-host";
import { KEYS } from "../ui-support/render";

/**
 * `m1` thinks at levels it does not name; `m2` names the five every picker used to offer; `x1`
 * names only high and max (#799's endpoint model); `p1` says nothing about thinking.
 */
const PROVIDERS = [
  {
    id: "local",
    models: [
      { id: "m1", reasoning: true },
      {
        id: "m2",
        reasoning: true,
        reasoningEfforts: ["minimal", "low", "medium", "high"],
        thinkingMode: "both",
      },
    ],
  },
  {
    id: "other",
    models: [
      { id: "x1", reasoning: true, reasoningEfforts: ["high", "max"] },
      "p1",
    ],
  },
];

function markedLine(r: HostRendered): string {
  return (
    r
      .screen()
      .split("\n")
      .find((line) => line.includes("›")) ?? ""
  );
}

async function markLine(r: HostRendered, text: string): Promise<void> {
  await r.press(LIST_KEYS.home);
  for (let step = 0; step < 12 && !markedLine(r).includes(text); step++)
    await r.press(KEYS.down);
  expect(markedLine(r)).toContain(text);
}

function lineOf(r: HostRendered, text: string): string {
  return (
    r
      .screen()
      .split("\n")
      .find((line) => line.includes(text)) ?? ""
  );
}

/**
 * The runtime catalog of a machine where Claude Code is installed and signed in. The test host
 * cannot run the real one; agents' sessions are not opened here, so `open` has nothing to do.
 */
const CLAUDE: AgentRuntimeInfo = {
  id: "claude",
  label: "Claude Code",
  status: "available",
  models: [
    { id: "sonnet", name: "Sonnet", default: true, efforts: [] },
    { id: "opus", name: "Opus", default: false, efforts: [] },
  ],
};
const claudeRuntimes = {
  open: () => undefined,
  catalog: { list: async () => [CLAUDE] },
} as unknown as NonNullable<HostOptions["runtimes"]>;

async function hostWith(
  agents: Record<string, unknown>[],
  overrides: Partial<HostOptions> = {},
): Promise<{ r: HostRendered; ids: Record<string, string> }> {
  const dataDir = await dataDirWith({ providers: PROVIDERS });
  const r = await renderWithHost({
    extensions: [model],
    host: { dataDir, overrides },
  });
  const primaryId = (
    (r.wire.store.getState().targets.machines?.sections.list ??
      []) as MachineView[]
  ).find((machine) => machine.kind === "primary")?.id;
  const ids: Record<string, string> = {};
  for (const fields of agents) {
    const external = fields.runtime !== undefined && fields.runtime !== "eta";
    // An agent on eta's own loop names a model: the host refuses one without.
    // External runtimes require a pinned machine.
    const { agent } = await r.wire.call<{ agent: AgentView }>(
      "agents",
      "create",
      {
        ...(fields.runtime === undefined && fields.model === undefined
          ? { model: "local:m1" }
          : {}),
        ...(external &&
        fields.machineId === undefined &&
        primaryId !== undefined
          ? { machineId: primaryId }
          : {}),
        ...fields,
      },
    );
    ids[agent.name] = agent.id;
  }
  return { r, ids };
}

async function agentNamed(
  r: HostRendered,
  name: string,
): Promise<AgentView | undefined> {
  return (await hostAgents(r.host)).find((agent) => agent.name === name);
}

describe("/model", () => {
  it("sets an agent found by name: models grouped by provider, then the thinking level", async () => {
    const { r } = await hostWith([{ name: "Bob" }, { name: "Ada" }]);
    await r.runCommand("/model Bob");
    await r.waitFor("Model for Bob");
    const screen = r.screen();
    // Each provider's models under its name; eta's own loop has no default to offer first.
    const order = ["local", "m1", "m2", "other", "x1", "p1"];
    const at = order.map((text) => screen.indexOf(text));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(screen).not.toContain("The runtime's default");
    // Bob's model now: marked as current, and the marker starts there.
    expect(markedLine(r)).toContain("m1");
    expect(lineOf(r, "m1")).toContain("current");

    await markLine(r, "m2");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Bob");
    for (const level of [
      "The model's own",
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
    ])
      expect(r.screen()).toContain(level);
    expect(markedLine(r)).toContain("The model's own");
    expect(lineOf(r, "The model's own")).toContain("current");
    await markLine(r, "High");
    await r.press(KEYS.enter);
    await r.waitForGone("Thinking for Bob");
    await r.waitFor("Bob now uses local / m2, thinking High");
    expect(await agentNamed(r, "Bob")).toMatchObject({
      model: "local:m2",
      thinkingLevel: "high",
    });
    // Ada was not touched.
    expect(await agentNamed(r, "Ada")).toMatchObject({
      model: "local:m1",
      thinkingLevel: null,
    });
    await r.close();
  });

  it("takes the start of a name, and asks which agent when it fits several", async () => {
    const { r } = await hostWith([
      { name: "Ada" },
      { name: "Adam" },
      { name: "Bob" },
    ]);
    await r.runCommand("/model bo");
    await r.waitFor("Model for Bob");
    await r.press(KEYS.escape);
    await r.waitForGone("Model for Bob");

    await r.runCommand("/model Ad");
    await r.waitFor("Which agent?");
    expect(r.screen()).toContain("Ada");
    expect(r.screen()).toContain("Adam");
    expect(r.screen()).not.toContain("Bob");
    await markLine(r, "Adam");
    await r.press(KEYS.enter);
    await r.waitFor("Model for Adam");
    await r.close();
  });

  it("asks which agent when none is named", async () => {
    const { r } = await hostWith([{ name: "Ada" }, { name: "Bob" }]);
    await r.runCommand("/model");
    await r.waitFor("Which agent?");
    expect(r.screen()).toContain("Ada");
    expect(r.screen()).toContain("Bob");
    await markLine(r, "Bob");
    await r.press(KEYS.enter);
    await r.waitFor("Model for Bob");
    await r.close();
  });

  it("says so when no agent fits the name", async () => {
    const { r } = await hostWith([{ name: "Ada" }]);
    await r.runCommand("/model Zed");
    await r.waitFor("No agent named Zed");
    expect(r.screen()).not.toContain("Model for");
    await r.close();
  });

  it("starts on the agent's current model and level", async () => {
    const { r } = await hostWith([
      { name: "Ada", model: "local:m2", thinkingLevel: "low" },
    ]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    expect(markedLine(r)).toContain("m2");
    expect(lineOf(r, "m2")).toContain("current");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    expect(markedLine(r)).toContain("Low");
    expect(lineOf(r, "Low")).toContain("current");
    await r.press(KEYS.enter);
    await r.waitFor("Ada now uses local / m2, thinking Low");
    expect(await agentNamed(r, "Ada")).toMatchObject({
      model: "local:m2",
      thinkingLevel: "low",
    });
    await r.close();
  });

  it("offers an external runtime's own default, and writes null for it", async () => {
    const { r } = await hostWith(
      [{ name: "Cody", runtime: "claude", model: "claude:sonnet" }],
      { runtimes: claudeRuntimes },
    );
    await r.runCommand("/model Cody");
    await r.waitFor("Model for Cody");
    await r.waitFor("Opus");
    expect(lineOf(r, "The runtime's default")).not.toContain("current");
    await markLine(r, "The runtime's default");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Cody");
    await r.press(KEYS.enter);
    await r.waitFor("Cody now uses the runtime's default model");
    expect(await agentNamed(r, "Cody")).toMatchObject({ model: null });
    await r.close();
  });

  it("goes back to the models on Esc at the thinking level, without changing the agent", async () => {
    const { r } = await hostWith([{ name: "Ada", model: "local:m1" }]);
    const calls = recordCalls(r.wire);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "x1");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    await r.press(KEYS.escape);
    await r.waitFor("Model for Ada");
    // Back where it was picked from.
    expect(markedLine(r)).toContain("x1");
    await r.settle();
    expect(calls.filter((call) => call.action === "update")).toEqual([]);
    expect(await agentNamed(r, "Ada")).toMatchObject({
      model: "local:m1",
      thinkingLevel: null,
    });
    await r.close();
  });

  it("offers only the levels a model declares", async () => {
    const { r } = await hostWith([{ name: "Ada" }]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "x1");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    for (const level of ["The model's own", "High", "max"])
      expect(r.screen()).toContain(level);
    for (const level of ["Off", "Minimal", "Low", "Medium", "xhigh", "ultra"])
      expect(r.screen()).not.toContain(level);
    await markLine(r, "max");
    await r.press(KEYS.enter);
    await r.waitFor("Ada now uses other / x1, thinking max");
    expect(await agentNamed(r, "Ada")).toMatchObject({
      model: "other:x1",
      thinkingLevel: "max",
    });
    await r.close();
  });

  it("offers only Off to a model that says nothing about thinking, and says why", async () => {
    const { r } = await hostWith([{ name: "Ada" }]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "p1");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    expect(r.screen()).toContain("declares no thinking levels");
    expect(r.screen()).toContain("Off");
    expect(r.screen()).not.toContain("High");
    await r.close();
  });

  it("falls back to five levels where a model's are not known, and says so", async () => {
    const { r } = await hostWith([{ name: "Ada", model: "local:m2" }]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "m1");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    expect(r.screen()).toContain("levels are not known");
    for (const level of ["Off", "Minimal", "Low", "Medium", "High"])
      expect(r.screen()).toContain(level);
    expect(r.screen()).not.toContain("xhigh");
    await r.close();
  });

  it("shows the agent's level a new model does not take, and starts on the model's own", async () => {
    const { r } = await hostWith([
      { name: "Ada", model: "local:m2", thinkingLevel: "low" },
    ]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "x1");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    expect(lineOf(r, "Low")).toContain("this model does not take it");
    expect(markedLine(r)).toContain("The model's own");
    await r.close();
  });

  it("lists a level outside the offered ones when the agent has it", async () => {
    const { r } = await hostWith([
      { name: "Ada", model: "local:m1", thinkingLevel: "xhigh" },
    ]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    expect(lineOf(r, "xhigh")).toContain("current");
    expect(markedLine(r)).toContain("xhigh");
    await r.close();
  });

  it("shows why the host refused, keeps the layer open, and lets the user pick again", async () => {
    const { r, ids } = await hostWith([{ name: "Ada" }]);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "m2");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    // The agent goes away meanwhile: the host refuses the update.
    await r.wire.call("agents", "delete", { agentId: ids.Ada });
    await markLine(r, "Medium");
    await r.press(KEYS.enter);
    await r.waitFor("no such agent");
    expect(r.screen()).toContain("Thinking for Ada");
    await r.press(KEYS.escape);
    await r.waitFor("Model for Ada");
    await r.close();
  });

  it("lists an external runtime's own models for an agent on it", async () => {
    const { r } = await hostWith(
      [{ name: "Cody", runtime: "claude", model: "claude:sonnet" }],
      { runtimes: claudeRuntimes },
    );
    await r.runCommand("/model Cody");
    await r.waitFor("Model for Cody");
    await r.waitFor("Opus");
    expect(r.screen()).toContain("Claude Code");
    expect(lineOf(r, "Sonnet")).toContain("current");
    expect(r.screen()).not.toContain("m1");
    expect(r.screen()).not.toContain("x1");
    await markLine(r, "Opus");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Cody");
    await r.press(KEYS.enter);
    await r.waitFor("Cody now uses Claude Code / Opus");
    expect(await agentNamed(r, "Cody")).toMatchObject({
      model: "claude:opus",
    });
    await r.close();
  });

  it("says so when the machine has none of an external runtime's models", async () => {
    // The test host runs no external runtimes: `agents.runtimes` answers an empty list.
    const { r } = await hostWith([{ name: "Cody", runtime: "claude" }]);
    await r.runCommand("/model Cody");
    await r.waitFor("Model for Cody");
    await r.waitFor("This machine has no models for claude");
    expect(r.screen()).toContain("The runtime's default");
    expect(r.screen()).not.toContain("m1");
    await r.close();
  });

  it("updates the agent once when Enter comes twice at once on the level", async () => {
    const { r } = await hostWith([{ name: "Ada" }]);
    const calls = recordCalls(r.wire);
    await r.runCommand("/model Ada");
    await r.waitFor("Model for Ada");
    await markLine(r, "m2");
    await r.press(KEYS.enter);
    await r.waitFor("Thinking for Ada");
    await markLine(r, "High");
    await r.press(`${KEYS.enter}${KEYS.enter}`);
    await r.waitFor("Ada now uses local / m2, thinking High");
    await r.settle(300);
    expect(calls.filter((call) => call.action === "update")).toHaveLength(1);
    await r.close();
  });
});
