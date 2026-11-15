/**
 * The first-time setup against a real host: when it opens by itself, its two steps, the agents
 * it creates on the host, and `/setup`. The test host has the four built-in persona cards
 * (Thinker, Insighter, Executor, Artist) plus any card file a test writes into its home.
 */
import type { AgentView } from "@eta/client-contracts";
import type { WireState, WireStatus } from "../../src/connection/types";
import type { HostRendered } from "../ext-support/render-with-host";
import { describe, expect, it } from "vitest";
import { createSetupExtension } from "../../src/ext/setup";
import { needsSetup, readSetupFacts } from "../../src/ext/setup/first-run";
import { fakeGoogle, GOOD_KEY } from "../ext-support/fake-upstreams";
import { dataDirWith, hostAgents } from "../ext-support/host-data";
import { recordCalls, withHostWire } from "../ext-support/host-wire";
import { LIST_KEYS } from "../ext-support/keys";
import { renderWithHost } from "../ext-support/render-with-host";
import { baseUrl, closeHost, testHost } from "../support/host";
import { until } from "../support/temp";
import { KEYS } from "../ui-support/render";

const TITLE = "Esc to leave; come back later with /setup";
const STEP_ONE = "Step 1 of 2";
const STEP_TWO = "Step 2 of 2";
const BUILTIN = ["Thinker", "Insighter", "Executor", "Artist"];

/** The agents on a wire that a person made: every host also makes Captain. */
const madeAgents = (wire: { store: { getState: () => WireState } }) =>
  (
    (wire.store.getState().targets.agents?.sections.list ?? []) as AgentView[]
  ).filter((agent) => agent.systemRole !== "captain");
const LOCAL = { id: "local", models: ["m1", "m2"] };

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

/** The screen line that holds `text`. */
function lineOf(r: HostRendered, text: string): string {
  return (
    r
      .screen()
      .split("\n")
      .find((line) => line.includes(text)) ?? ""
  );
}

function byPersona(agents: AgentView[]): Record<string, AgentView[]> {
  const grouped: Record<string, AgentView[]> = {};
  for (const agent of agents) (grouped[agent.persona] ??= []).push(agent);
  return grouped;
}

describe("the first-time setup opening by itself", () => {
  it("opens on a fresh host, says how to leave, and does not open again on a reconnect", async () => {
    const r = await renderWithHost({ extensions: [createSetupExtension()] });
    await r.waitFor(TITLE);
    const lines = r.screen().split("\n");
    const top = lines.findIndex((line) => line.includes("┌"));
    // The layer's first line, under its top border.
    expect(lines[top + 1]).toContain(TITLE);
    expect(r.screen()).toContain(STEP_ONE);
    // No usable model: the next step cannot be taken, and the screen says why.
    expect(r.screen()).toContain("No usable model yet");
    await markLine(r, "Next: create agents");
    await r.press(KEYS.enter);
    await r.settle();
    expect(r.screen()).toContain(STEP_ONE);
    expect(r.screen()).not.toContain(STEP_TWO);

    await r.press(KEYS.escape);
    await r.waitForGone(TITLE);
    await r.waitFor("Type /setup to come back");

    // The connection drops and comes back to the same address.
    const statuses: WireStatus[] = [];
    const stop = r.wire.store.subscribe((state) => {
      if (statuses.at(-1) !== state.status) statuses.push(state.status);
    });
    const { port, dataDir } = r.host;
    await closeHost(r.host);
    await testHost({ port, dataDir });
    await r.waitUntil(
      () => statuses.includes("reconnecting") && statuses.at(-1) === "open",
      "the shell to reconnect",
      30_000,
    );
    stop();
    await r.settle(2_000);
    expect(r.screen()).not.toContain(TITLE);
    await r.close();
  }, 90_000);

  it("starts on the second step when a model is usable, and creates the ticked cards' agents with the first usable model", async () => {
    // A `defaultModel` left in config.json from before is ignored: it neither stops the host nor
    // picks the model.
    const dataDir = await dataDirWith({
      providers: [LOCAL],
      defaultModel: "local:m2",
    });
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { dataDir },
    });
    await r.waitFor(TITLE);
    await r.waitFor(STEP_TWO);
    for (const name of BUILTIN) expect(r.screen()).toContain(`[x] ${name}`);

    await markLine(r, "Insighter");
    await r.press(LIST_KEYS.space);
    await r.waitFor("[ ] Insighter");

    // Back to the first step and forward again; the ticks stay.
    await r.press(KEYS.left);
    await r.waitFor(STEP_ONE);
    expect(r.screen()).toContain("Usable models: 2");
    expect(r.screen()).not.toContain("No usable model yet");
    await markLine(r, "Next: create agents");
    await r.press(KEYS.enter);
    await r.waitFor(STEP_TWO);
    expect(r.screen()).toContain("[ ] Insighter");

    await r.press(KEYS.enter);
    await r.waitForGone(TITLE);
    await r.waitFor("Agents created: 3");
    expect(r.screen()).toContain("/new");

    const agents = await hostAgents(r.host);
    expect(
      agents.map((agent) => [agent.name, agent.persona, agent.model]),
    ).toEqual([
      ["Artist", "Artist", "local:m1"],
      ["Executor", "Executor", "local:m1"],
      ["Thinker", "Thinker", "local:m1"],
    ]);
    await r.close();
  }, 60_000);

  it("does not open when there are both a usable model and an agent; /setup opens it, and a card with an agent is marked and skipped", async () => {
    const dataDir = await dataDirWith({ providers: [LOCAL] });
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { dataDir },
      seed: async (host) => {
        await withHostWire(host, (wire) =>
          wire.call("agents", "create", {
            name: "Exec",
            persona: "Executor",
            model: "local:m2",
          }),
        );
      },
    });
    await r.settle(2_000);
    expect(r.screen()).not.toContain(TITLE);

    await r.runCommand("/setup");
    await r.waitFor(STEP_TWO);
    expect(lineOf(r, "Executor")).toContain("[ ]");
    expect(lineOf(r, "Executor")).toContain("already created");
    await markLine(r, "Executor");
    await r.press(LIST_KEYS.space);
    await r.settle();
    expect(lineOf(r, "Executor")).toContain("[ ]");

    await r.press(KEYS.enter);
    await r.waitFor("Agents created: 3");
    const grouped = byPersona(await hostAgents(r.host));
    expect(Object.keys(grouped).sort()).toEqual([
      "Artist",
      "Executor",
      "Insighter",
      "Thinker",
    ]);
    expect(grouped.Executor?.map((agent) => agent.name)).toEqual(["Exec"]);
    // The model last used: the TUI remembers none, so it is the newest eta agent's.
    expect(grouped.Thinker?.[0]?.model).toBe("local:m2");
    await r.close();
  }, 60_000);

  it("stops at a card the host refuses, says why, skips the created ones on a retry, and finishes without that card", async () => {
    // A card whose name is a space: the host refuses an agent without a name. Card files come
    // after the built-in cards, sorted, so it is fifth and `zed` sixth.
    const dataDir = await dataDirWith({
      providers: [LOCAL],
      cards: [" ", "zed"],
    });
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { dataDir },
    });
    await r.waitFor(STEP_TWO);
    await r.waitFor("[x] zed");

    await r.press(KEYS.enter);
    await r.waitFor("agents.create needs name");
    expect(r.screen()).toContain(STEP_TWO);
    let agents = await hostAgents(r.host);
    expect(agents.map((agent) => agent.persona).sort()).toEqual(
      [...BUILTIN].sort(),
    );

    // Again: the four created ones are not created twice, and it stops at the same card.
    await r.waitFor(/Thinker\s+already created/);
    const calls = recordCalls(r.wire);
    const creates = () => calls.filter((call) => call.action === "create");
    await r.press(KEYS.enter);
    await r.waitUntil(() => creates().length > 0, "the retry to create");
    await r.settle(500);
    expect(
      creates().map((call) => (call.args as { name: string }).name),
    ).toEqual([" "]);
    await r.waitFor("agents.create needs name");
    agents = await hostAgents(r.host);
    expect(agents).toHaveLength(4);

    // Untick the refused card and finish.
    await r.press(LIST_KEYS.end);
    await r.press(KEYS.up);
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.enter);
    await r.waitForGone(TITLE);
    await r.waitFor("Agents created: 5");
    agents = await hostAgents(r.host);
    expect(agents.map((agent) => agent.persona).sort()).toEqual(
      [...BUILTIN, "zed"].sort(),
    );
    await r.close();
  }, 60_000);
});

describe("readSetupFacts on a connection that has been open a while", () => {
  it("decides on the agents the host has now, not on the copy that came with hello", async () => {
    const dataDir = await dataDirWith({ providers: [LOCAL] });
    const host = await testHost({ dataDir });
    await withHostWire(host, async (wire) => {
      // Hello carried no agent but Captain, and nothing on this connection follows the agents.
      expect(madeAgents(wire)).toEqual([]);
      await withHostWire(host, (other) =>
        other.call("agents", "create", { name: "Ada", model: "local:m1" }),
      );
      expect(madeAgents(wire)).toEqual([]);

      const facts = await readSetupFacts(wire, "en", 10_000);
      expect(facts?.agents.map((agent) => agent.name)).toEqual(["Ada"]);
      expect(needsSetup(facts!)).toBe(false);
    });
  });
});

describe("the first-time setup: when it opens", () => {
  it("opens when there are agents but no usable model: a configured provider without its key does not count", async () => {
    const dataDir = await dataDirWith({
      providers: [{ id: "ds", kind: "deepseek", models: ["chat"] }],
    });
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { dataDir },
      seed: async (host) => {
        await withHostWire(host, (wire) =>
          wire.call("agents", "create", { name: "Ada", model: "ds:chat" }),
        );
      },
    });
    await r.waitFor(TITLE);
    expect(r.screen()).toContain(STEP_ONE);
    expect(r.screen()).toContain("Usable models: 0");
    await r.close();
  }, 60_000);

  it("checks again on connecting to another host address in the same process", async () => {
    const r = await renderWithHost({ extensions: [createSetupExtension()] });
    await r.waitFor(TITLE);
    await r.press(KEYS.escape);
    await r.waitForGone(TITLE);

    const other = await testHost();
    await r.controller.connectResident({ url: baseUrl(other) });
    await r.waitUntil(
      () => {
        const { phase } = r.controller.getState();
        return phase.name === "connected" && phase.url === baseUrl(other);
      },
      "the shell to connect to the other host",
      30_000,
    );
    await r.waitFor(TITLE, 15_000);
    await r.close();
  }, 90_000);
});

describe("the first-time setup on a host with the model gateway", () => {
  it("opens on its first step with the gateway's connectors when no account is connected", async () => {
    const google = fakeGoogle();
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
      seed: async (host) => {
        await withHostWire(host, (wire) =>
          wire.call("agents", "create", { name: "Ada", model: "llm:any" }),
        );
      },
    });
    await r.waitFor(TITLE, 30_000);
    expect(r.screen()).toContain(STEP_ONE);
    await r.waitFor("Connect Google AI Studio", 30_000);
    expect(r.screen()).toContain("No usable model yet");
    await r.close();
  }, 120_000);

  it("does not open when a gateway account's models are usable and an agent exists", async () => {
    const google = fakeGoogle();
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
      seed: async (host) => {
        await withHostWire(host, async (wire) => {
          await wire.call("agents", "create", {
            name: "Ada",
            model: "llm:any",
          });
          const { login } = await wire.call<{ login: { id: string } }>(
            "llm",
            "loginStart",
            { connector: "gemini" },
          );
          await wire.call(
            "llm",
            "loginSubmit",
            { id: login.id, apiKey: GOOD_KEY },
            { timeoutMs: 60_000 },
          );
          // Until the gateway publishes the account's models.
          wire.subscribe("llm");
          await until(
            () =>
              (
                wire.store.getState().targets.llm?.sections.models as
                  | { connector: string; available: boolean }[]
                  | undefined
              )?.some((m) => m.connector === "gemini" && m.available) === true,
            60_000,
            "the gateway's models",
          );
        });
      },
    });
    await r.settle(3_000);
    expect(r.screen()).not.toContain(TITLE);
    await r.close();
  }, 120_000);
});

describe("the first-time setup under keys that come in one read", () => {
  it("creates each card's agent once when Enter comes twice at once", async () => {
    const dataDir = await dataDirWith({ providers: [LOCAL] });
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      host: { dataDir },
    });
    await r.waitFor(STEP_TWO);
    await r.waitFor("[x] Artist");
    await r.press(`${KEYS.enter}${KEYS.enter}`);
    await r.waitFor("Agents created: 4");
    await r.settle(500);
    const grouped = byPersona(await hostAgents(r.host));
    expect(
      Object.fromEntries(
        Object.entries(grouped).map(([persona, list]) => [
          persona,
          list.length,
        ]),
      ),
    ).toEqual({ Thinker: 1, Insighter: 1, Executor: 1, Artist: 1 });
    await r.close();
  }, 60_000);
});
