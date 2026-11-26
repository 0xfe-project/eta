import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/external-runtime-bounds.tsx";

function openPage(page: string, locale: "en-US" | "zh-CN" = "en-US") {
  return open(fixture, {
    platform: "macos",
    width: 1440,
    height: 900,
    locale,
    urlScheme: `eta://fixture/${page}`,
  });
}

test("agent creator auto-pins primary, hides Follow the project and Persona on external runtime, and creates pinned agent", async () => {
  const app = await openPage("new-agent");
  expect(app.shows("label:Runs on")).toBe(true);
  expect(app.texts()).toContain("Follow the project");
  expect(app.shows("label:Persona")).toBe(false);

  await app.type("label:Name", "NewCody");
  await app.press("label:Runtime");
  await app.waitFor("label:Claude Code");
  await app.press("label:Claude Code");

  // Follow the project is omitted; primary machine is auto-selected; Persona stays hidden in both steps.
  expect(app.shows("label:Runs on")).toBe(true);
  expect(app.texts()).not.toContain("Follow the project");
  expect(app.texts()).toContain("studio");
  expect(app.shows("label:Persona")).toBe(false);
  await app.press("label:Next");
  await app.waitFor("label:Create");
  expect(app.shows("label:Persona")).toBe(false);

  await app.press("label:Create");
  await app.waitUntil(() =>
    app.texts().some((line) => line.startsWith("agents.create ")),
  );
  const callLine = app
    .texts()
    .find((line) => line.startsWith("agents.create "))!;
  const args = JSON.parse(callLine.slice("agents.create ".length));
  expect(args).toMatchObject({
    name: "NewCody",
    runtime: "claude",
    machineId: "m-primary",
    persona: "",
  });
});

test("agent editor shows Persona and caveat when unpinned on eta, hides both and auto-pins when switching to external", async () => {
  const app = await openPage("edit-eta");
  expect(app.shows("label:Persona")).toBe(true);
  expect(app.shows("label:Follow the project")).toBe(true);
  expect(app.texts()).toContain(
    "Runtimes are listed from the primary for now, and may differ if the project is on another machine.",
  );

  // Pinning to studio hides the follow-project caveat while still on eta.
  await app.press("label:studio (primary)");
  expect(app.texts()).not.toContain(
    "Runtimes are listed from the primary for now, and may differ if the project is on another machine.",
  );

  // Switch back to Follow the project, then change Runtime -> Claude Code.
  await app.press("label:Follow the project");
  await app.press("label:Runtime");
  await app.waitFor("label:Claude Code");
  await app.press("label:Claude Code");

  expect(app.shows("label:Persona")).toBe(false);
  expect(app.shows("label:Follow the project")).toBe(false);
  await app.press("label:Instructions");
  expect(app.shows("label:Persona")).toBe(false);

  await app.press("label:Save");
  await app.waitUntil(() =>
    app.texts().some((line) => line.startsWith("agents.update ")),
  );
  const callLine = app
    .texts()
    .find((line) => line.startsWith("agents.update "))!;
  const args = JSON.parse(callLine.slice("agents.update ".length));
  expect(args).toMatchObject({
    agentId: "a-eta",
    runtime: "claude",
    machineId: "m-primary",
    persona: "",
  });
});

test("agent editor disables Save if a broken external agent has null machineId until pinned", async () => {
  const app = await openPage("edit-null-ext");
  expect(app.shows("label:Follow the project")).toBe(false);
  expect(app.enabled("label:Save")).toBe(false);

  await app.press("label:studio (primary)");
  expect(app.enabled("label:Save")).toBe(true);
});

test("agent setting subtitle and Captain proposal card omit persona for external runtimes", async () => {
  const app = await openPage("list-and-proposals");
  const texts = app.texts();
  // Phone AgentSetting shows instructions, never legacy persona string.
  expect(texts).not.toContain("legacy-should-hide");
  expect(texts.some((t) => t.includes("Work on studio"))).toBe(true);
  // eta proposal shows Persona ("Executor"), external proposal hides legacy persona ("legacy-hidden").
  expect(texts).toContain("Executor");
  expect(texts).not.toContain("legacy-hidden");
});

test("ConversationMembers disables cross-machine external agents with Only on <machine> in en-US and zh-CN", async () => {
  const en = await openPage("conv-members", "en-US");
  expect(en.enabled("label:PrimaryClaude")).toBe(true);
  expect(en.enabled("label:DaemonAcp")).toBe(false);
  expect(en.texts()).toContain("Only on gpu-box");

  await en.press("label:Pick gpu-box");
  await en.waitFor("text:Only on studio");
  expect(en.enabled("label:PrimaryClaude")).toBe(false);
  expect(en.enabled("label:DaemonAcp")).toBe(true);

  const zh = await openPage("conv-members", "zh-CN");
  expect(zh.texts()).toContain("仅限 gpu-box");
  await zh.press("label:Pick gpu-box");
  await zh.waitFor("text:仅限 studio");
});

test("NewConversation drops incompatible selections when switching directory machine", async () => {
  const app = await openPage("new-conv");
  await app.waitFor("text:studio");
  await app.press("text:studio");
  await app.waitFor("text:Search directories");
  await app.press("text:Search directories");
  await app.waitFor("text:Studio App");
  await app.press("text:Studio App");

  await app.waitFor("label:PrimaryClaude");
  expect(app.enabled("label:DaemonAcp")).toBe(false);
  expect(app.texts()).toContain("Only on gpu-box");

  // Pick only PrimaryClaude (toggle Ada off, PrimaryClaude on).
  await app.press("label:Ada");
  await app.press("label:PrimaryClaude");

  // Go back to machine picker and switch to gpu-box.
  await app.press("label:Back");
  await app.waitFor("text:Studio App");
  await app.press("label:Back");
  await app.waitFor("text:How do you want to add it?");
  await app.press("label:Back");
  await app.waitFor("text:gpu-box");
  await app.press("text:gpu-box");
  await app.waitFor("text:Search directories");
  await app.press("text:Search directories");
  await app.waitFor("text:GPU Job");
  await app.press("text:GPU Job");

  await app.waitFor("label:DaemonAcp");
  expect(app.enabled("label:PrimaryClaude")).toBe(false);
  expect(app.texts()).toContain("Only on studio");
  // Previously selected PrimaryClaude is incompatible on gpu-box and was dropped, so Start is disabled.
  expect(app.enabled("label:Start")).toBe(false);
});

test("InviteAgents disables cross-machine external agents with Only on <machine>", async () => {
  const app = await openPage("invite");
  await app.waitFor("label:PrimaryClaude");
  expect(app.enabled("label:PrimaryClaude")).toBe(true);
  expect(app.enabled("label:DaemonAcp")).toBe(false);
  expect(app.texts()).toContain("Only on gpu-box");
});

test("NewTask excludes cross-machine external agents from Executor choices", async () => {
  const app = await openPage("new-task");
  await app.waitFor("label:Executor");
  await app.press("label:Executor");
  await app.waitFor("label:PrimaryClaude");
  expect(app.shows("label:Ada")).toBe(true);
  expect(app.shows("label:PrimaryClaude")).toBe(true);
  expect(app.shows("label:DaemonAcp")).toBe(false);
});

test("task comment @ mentions exclude cross-machine external agents", async () => {
  const app = await openPage("task-detail");
  await app.waitFor("label:Comment");
  await app.type("label:Comment", "@");
  await app.waitFor("label:Mention Ada");
  expect(app.shows("label:Mention Ada")).toBe(true);
  expect(app.shows("label:Mention PrimaryClaude")).toBe(true);
  expect(app.shows("label:Mention DaemonAcp")).toBe(false);
});

test("modelWarning shows See it in Runtimes instead of Go to model services for external runtimes", async () => {
  const ext = await openPage("edit-ext-missing-model");
  await ext.waitFor(
    "text:This model is no longer available. Choose another one.",
  );
  expect(ext.shows("label:Go to model services")).toBe(false);
  expect(ext.shows("label:See it in Runtimes")).toBe(true);
  await ext.press("label:See it in Runtimes");
  await ext.waitFor("text:open Runtimes");
  expect(ext.texts()).not.toContain("open modelServices");

  const eta = await openPage("edit-eta-missing-model");
  await eta.waitFor(
    "text:This model is no longer available. Choose another one.",
  );
  expect(eta.shows("label:Go to model services")).toBe(true);
  await eta.press("label:Go to model services");
  await eta.waitFor("text:open modelServices");
  expect(eta.texts()).not.toContain("open Runtimes");
});
