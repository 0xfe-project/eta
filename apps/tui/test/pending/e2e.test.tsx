/**
 * The whole way through, on the real controller connected to a resident host in this process:
 * two conversations open as tabs, an agent in the second asks a question, the pending entry
 * counts it, the user answers it from the first conversation without leaving it.
 */
import type {
  AgentView,
  ConversationSummary,
  InteractionView,
  ProjectView,
} from "@eta/client-contracts";
import type { TuiState as SavedState } from "../../src/config/types";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { call, say, scriptedModels } from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { createConnectionController } from "../../src/connection/controller";
import { Wire } from "../../src/connection/wire";
import { extensions } from "../../src/extensions.gen";
import { createRegistry } from "../../src/extensions/registry";
import { App } from "../../src/ui/app";
import { dataDirWith } from "../ext-support/host-data";
import { baseUrl, childEnv, closedPort, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";
import { loaded, testConfig } from "../ui-support/config";
import { flush, KEYS, plain, renderInk } from "../ui-support/render";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("answers a question from another conversation without leaving the one in front", async () => {
  const { models } = scriptedModels((request) => {
    if (request.agent !== "Ben") return say("ok");
    return request.lastRole === "toolResult"
      ? say(`Told: ${request.last}`)
      : call("ask_user", {
          question: "Which colour?",
          options: [{ title: "red" }, { title: "blue" }],
        });
  });
  // A model usable without a key, named as the scripted models name theirs: with it and the agents
  // made below, the host is set up and the first-time setup stays closed.
  const host = await testHost({
    dataDir: await dataDirWith({
      providers: [{ id: "fake", models: ["fake-model"] }],
    }),
    overrides: { models: models as never },
  });
  const url = baseUrl(host);

  // The test's own connection: it sets the host up and reads it, apart from the interface.
  const raw = new Wire({ url: wireUrl(url) });
  cleanups.push(() => raw.close());
  raw.connect();
  await until(() => raw.store.getState().status === "open", 20_000, "hello");
  cleanups.push(raw.subscribe("inbox"));
  const ask = <T,>(target: string, action: string, args: unknown) =>
    raw.call<T>(target, action, args);
  const makeRoom = async (agentName: string, name: string) => {
    const { agent } = await ask<{ agent: AgentView }>("agents", "create", {
      name: agentName,
      model: "fake:fake-model",
    });
    const { project } = await ask<{ project: ProjectView }>(
      "projects",
      "create",
      { path: await tempDir("eta-tui-project-"), stewardId: agent.id },
    );
    const { conversation } = await ask<{ conversation: ConversationSummary }>(
      "conversations",
      "create",
      { projectId: project.id, agentIds: [agent.id], name },
    );
    return conversation;
  };
  await makeRoom("Ada", "First room");
  const second = await makeRoom("Ben", "Second room");

  const home = await tempDir("eta-tui-e2e-home-");
  const dir = await tempDir("eta-tui-e2e-conf-");
  const paths = { config: `${dir}/tui.json`, state: `${dir}/tui-state.json` };
  const setting = { mode: "resident" as const, url };
  const controller = createConnectionController({
    paths,
    setting,
    env: childEnv(home),
    findHost: () => undefined,
    tuiVersion: "dev",
    // Never the real 127.0.0.1:8787.
    localUrl: `http://127.0.0.1:${await closedPort()}`,
  });
  cleanups.push(() => controller.stop());
  const saved: SavedState[] = [];
  const config = testConfig({ connection: setting });
  const r = renderInk(
    <App
      deps={{
        controller,
        registry: createRegistry(extensions),
        paths,
        initialConfig: loaded(config),
        initialState: { tabs: [], activeTab: undefined },
        env: {},
        platform: process.platform,
        tuiVersion: "dev",
        loadConfig: async () => loaded(config),
        ensureConfigFile: async () => undefined,
        saveState: async (_file, state) => {
          saved.push(structuredClone(state));
          return undefined;
        },
        runProcess: async () => 0,
        which: () => null,
        quit: async () => {
          await controller.stop();
        },
      }}
    />,
    { columns: 100, rows: 30 },
  );
  cleanups.push(() => r.unmount());
  const screenShows = (holds: (screen: string) => boolean, what: string) =>
    until(
      async () => {
        await flush();
        return holds(plain(r));
      },
      30_000,
      what,
    );
  const tabBar = () => plain(r).split("\n").at(-1) ?? "";

  await controller.start();
  await screenShows(() => tabBar().endsWith("Pending 0"), "the pending entry");

  await r.type("/open First room");
  await r.press(KEYS.enter);
  await screenShows(() => tabBar().includes("1:First room"), "the first tab");
  await screenShows((s) => s.includes("Write a message"), "the first input");
  await r.type("/open Second room");
  await r.press(KEYS.enter);
  await screenShows(() => tabBar().includes("2:Second room"), "the second tab");
  await r.press(KEYS.alt("1"));
  await until(
    () => saved.at(-1)?.activeTab === 0,
    10_000,
    "the first in front",
  );

  await ask("conversations", "send", {
    conversationId: second.id,
    text: "paint it",
  });
  await screenShows(() => tabBar().endsWith("Pending 1"), "one waiting");
  const question = (
    raw.store.getState().targets.inbox?.sections.list as InteractionView[]
  ).find((i) => i.status === "pending")!;
  expect(question.conversationId).toBe(second.id);

  await r.press(KEYS.left);
  await screenShows(
    (s) => s.includes("Waiting and conversations"),
    "the panel",
  );
  await r.press(KEYS.enter);
  await screenShows((s) => s.includes("Ben · Second room"), "the question");
  expect(plain(r)).toContain("Which colour?");
  await r.press(KEYS.down);
  await r.press(KEYS.enter);

  await screenShows(() => tabBar().endsWith("Pending 0"), "nothing waiting");
  await until(
    () =>
      (
        raw.store.getState().targets.inbox?.sections.list as InteractionView[]
      ).find((i) => i.id === question.id)?.status === "answered",
    20_000,
    "the answer on the host",
  );
  const answered = (
    raw.store.getState().targets.inbox?.sections.list as InteractionView[]
  ).find((i) => i.id === question.id)!;
  expect(answered.answer).toEqual({ kind: "selection", selections: ["blue"] });
  // The user never left the first conversation: it is still the tab in front, both still open.
  expect(saved.at(-1)).toMatchObject({
    tabs: [
      { kind: "conversation", id: expect.any(String) },
      { kind: "conversation", id: second.id },
    ],
    activeTab: 0,
  });
  expect(plain(r)).not.toContain("Which colour?");
  expect(tabBar()).toContain("1:First room");
  expect(tabBar()).toContain("2:Second room");
}, 180_000);
