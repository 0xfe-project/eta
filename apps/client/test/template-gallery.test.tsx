import { expect, open, test } from "nsh/test";

// The template gallery: search and categories narrow the list, a template opens to what it does and
// the instructions it gives, and Import makes the agent with its name in place of {NAME}, the
// placeholders filled in, and the template's face. The fixture's host has one model, source:model.
const fixture = "./fixtures/template-gallery.tsx";

function gallery(
  options: {
    phone?: boolean;
    initial?: string;
    models?: boolean;
    fail?: boolean;
    chatFail?: boolean;
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
    },
  });
}
type App = Awaited<ReturnType<typeof gallery>>;
const screen = (app: App) => app.texts().join("\n");

test("searching narrows the list; a template opens to its instructions before anything is made", async () => {
  const app = await gallery();
  await app.waitFor("id:template:account-specialist");
  await app.type("label:Search templates", "pr reviewer");
  expect(app.count("id:template:account-specialist")).toBe(0);
  await app.press("id:template:pr-reviewer");
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

test("Import makes the agent: its name for {NAME}, the placeholders filled in, the template's face", async () => {
  const app = await gallery({ initial: "account-specialist" });
  await app.waitFor("label:Import");
  await app.type("label:Name", "Harbor");
  await app.type("label:ACCOUNT", "Acme");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent");
  const sent = screen(app);
  expect(sent).toContain(
    'agents.create {"name":"Harbor","instructions":"You are Harbor, account specialist for Acme.',
  );
  expect(sent).toContain('"model":"source:model"');
  // A placeholder left empty stays in the instructions, to fill in later.
  expect(sent).toContain("{CHIEF}");
  expect(sent).toContain(
    'agents.update {"agentId":"new-agent","avatarSeed":"account-specialist"}',
  );
});

test("an agent left unnamed takes the template's name", async () => {
  const app = await gallery({ initial: "triage" });
  await app.waitFor("label:Import");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent");
  expect(screen(app)).toContain('agents.create {"name":"Triage"');
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
