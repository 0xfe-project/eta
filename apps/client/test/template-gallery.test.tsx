import { expect, open, test } from "nsh/test";

// The template gallery: search and categories narrow the list, a template opens to what it does and
// the instructions it gives, and Import makes the agent with its name in place of {NAME}, the
// placeholders filled in, atomic avatarSeed, optional plugins/runtime, and passes the AgentView.
const fixture = "./fixtures/template-gallery.tsx";

function gallery(
  options: {
    phone?: boolean;
    initial?: string;
    models?: boolean;
    fail?: boolean;
    chatFail?: boolean;
    plugins?: boolean;
    external?: boolean;
    existing?: string;
  } = {},
) {
  return open(fixture, {
    width: options.phone ? 390 : 1440,
    height: options.phone ? 844 : 900,
    locale: "en-US",
    platform: options.phone ? "ios" : "web",
    storage: {
      phone: options.phone ? "1" : "0",
      initial: options.initial ?? "",
      models: options.models === false ? "0" : "1",
      create: options.fail ? "fail" : "ok",
      chat: options.chatFail ? "fail" : "ok",
      plugins: options.plugins ? "1" : "0",
      external: options.external ? "1" : "0",
      existing: options.existing ?? "",
    },
  });
}
type App = Awaited<ReturnType<typeof gallery>>;
const screen = (app: App) => app.texts().join("\n");

test("searching narrows the list and syncs the detail pane; nothing is made before Import", async () => {
  const app = await gallery();
  await app.waitFor("id:template:account-specialist");
  expect(screen(app)).toContain("account specialist for {ACCOUNT}");
  await app.type("label:Search templates", "pr reviewer");
  expect(app.count("id:template:account-specialist")).toBe(0);
  // Filter desync fix: the previously shown non-matching template is replaced immediately.
  expect(screen(app)).not.toContain("account specialist for {ACCOUNT}");
  await app.press("id:template:pr-reviewer");
  expect(screen(app)).toContain("You are PR Reviewer");
  expect(screen(app)).toContain("Instructions it gets");
  expect(screen(app)).toContain("Asks you first");
  expect(screen(app)).not.toContain("agents.create");
});

test("choosing another template shows that one: its summary and instructions", async () => {
  const app = await gallery();
  await app.waitFor("id:template-instructions");
  await app.press("label:Engineering");
  await app.press("id:template:pr-reviewer");
  expect(screen(app)).not.toContain("account specialist for {ACCOUNT}");
  expect(screen(app)).toContain("You are PR Reviewer");
});

test("Import sends atomic avatarSeed and passes AgentView to onCreated", async () => {
  const app = await gallery({ initial: "account-specialist" });
  await app.waitFor("label:Import");
  await app.type("label:Name", "Harbor");
  await app.type("label:ACCOUNT", "Acme");
  // Preview bullets also substitute filled placeholders.
  expect(screen(app)).toContain('Answering "where are we with Acme"');
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const sent = screen(app);
  expect(sent).toContain(
    'agents.create {"name":"Harbor","instructions":"You are Harbor, account specialist for Acme.',
  );
  expect(sent).toContain('"model":"source:model"');
  expect(sent).toContain('"avatarSeed":"account-specialist"');
  // A placeholder left empty stays in the instructions, to fill in later.
  expect(sent).toContain("{CHIEF}");
  // No second fire-and-forget agents.update call.
  expect(sent).not.toContain("agents.update");
});

test("an agent left unnamed takes the template's name (or a unique suffix when taken)", async () => {
  const app = await gallery({ initial: "triage" });
  await app.waitFor("label:Import");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  expect(screen(app)).toContain('agents.create {"name":"Triage"');

  const second = await gallery({ initial: "triage", existing: "Triage" });
  await second.waitFor("label:Import");
  await second.press("label:Import");
  await second.waitFor("text:Created: new-agent@home-new-agent");
  expect(screen(second)).toContain('agents.create {"name":"Triage 2"');
});

test("the agent made gets a chat of its own in its home project: conversations.create, then it opens", async () => {
  const app = await gallery({ initial: "triage" });
  await app.waitFor("label:Import");
  await app.press("label:Import");
  await app.waitFor("text:Opened: new-conversation");
  const sent = screen(app);
  expect(sent).toContain(
    'conversations.create {"projectId":"home-new-agent","agentIds":["new-agent"],"stewardId":"new-agent"}',
  );
  expect(sent.split("conversations.create").length).toBe(2);
  // The host has no agents.direct: nothing asks for one.
  expect(sent).not.toContain("agents.direct");
});

test("a chat that cannot be opened says why in a toast; the agent stays made", async () => {
  const app = await gallery({ initial: "triage", chatFail: true });
  await app.waitFor("label:Import");
  await app.press("label:Import");
  await app.waitFor("id:toast");
  expect(screen(app)).toContain("Created: new-agent");
  expect(screen(app)).toContain("no such project");
  expect(screen(app)).toContain("Opened: \n");
});

test("a refused import says why and makes nothing", async () => {
  const app = await gallery({ initial: "triage", fail: true });
  await app.waitFor("label:Import");
  await app.press("label:Import");
  await app.waitFor("text:name taken");
  expect(screen(app)).toContain("Created: \n");
});

test("with no model there is nothing to import with: it points to Model services", async () => {
  const app = await gallery({ initial: "triage", models: false });
  await app.waitFor("text:Add a model service first.");
  expect(app.count("label:Model services")).toBe(1);
});

test("external runtime unblocks import when no eta models are configured", async () => {
  const app = await gallery({
    initial: "triage",
    models: false,
    external: true,
  });
  await app.waitFor("label:Runtime");
  await app.press("label:Runtime");
  await app.press("label:Claude Code");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const sent = screen(app);
  expect(sent).toContain('"runtime":"claude"');
  expect(sent).toContain('"model":null');
});

test("plugins can be selected on import, unconfigured plugins offer Configure, and Market opens", async () => {
  const app = await gallery({ initial: "pr-reviewer", plugins: true });
  await app.waitFor("label:slack-tools");
  expect(app.count("label:Configure")).toBe(1);
  await app.press("label:slack-tools");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  expect(screen(app)).toContain('"plugins":["slack-tools"]');
  await app.press("label:Browse the market");
  await app.waitFor("text:Market: open");
});

test("instructions can be edited before import and reactive initialId switches templates while open", async () => {
  const app = await gallery({ initial: "triage" });
  await app.waitFor("label:Edit");
  await app.press("label:Edit");
  await app.type("label:Instructions it gets", " Extra custom rule.");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  expect(screen(app)).toContain("Extra custom rule.");
  // Reactive initialId switches the open gallery to the newly linked template.
  await app.press("label:Switch link");
  expect(screen(app)).toContain("You are PR Reviewer");
});

test("on a phone the list comes first, a template opens over it, and Back goes back", async () => {
  const app = await gallery({ phone: true });
  await app.waitFor("id:template:triage");
  expect(screen(app)).not.toContain("Instructions it gets");
  await app.press("id:template:triage");
  await app.waitFor("text:Instructions it gets");
  await app.press("label:Back");
  await app.waitFor("id:template:triage");
  expect(screen(app)).not.toContain("Instructions it gets");
});
