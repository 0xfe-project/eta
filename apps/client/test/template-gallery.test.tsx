import { expect, open, test } from "nsh/test";

// The template gallery: search and categories narrow the list, a template opens to what it does and
// the instructions it gives, and Import makes the agent with its name in place of {NAME}, the
// placeholders filled in, atomic avatarSeed, optional plugins/runtime, and passes the AgentView.
const fixture = "./fixtures/template-gallery.tsx";

function gallery(
  options: {
    phone?: boolean;
    initial?: string;
    draft?: string;
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
      draft: options.draft ?? "",
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

test("pasting invalid bot config shows an inline error, and valid YAML populates all fields on import", async () => {
  const app = await gallery({ plugins: true, external: true });
  await app.waitFor("label:Paste");
  await app.press("label:Paste");
  await app.waitFor("label:Parse & load");

  // Invalid JSON shows an inline error without closing the gallery.
  await app.type("label:Filename (optional)", "broken.json");
  await app.type("label:Bot definition", "{not valid json");
  await app.press("label:Parse & load");
  await app.waitFor("id:paste-error");
  expect(screen(app)).toContain("Invalid JSON");
  expect(app.count("label:Parse & load")).toBe(1);

  // Close and reopen Paste to load a valid YAML config with runtime, thinkingLevel, persona, and plugins.
  await app.press("label:Cancel");
  await app.press("label:Paste");
  await app.waitFor("label:Parse & load");
  await app.type("label:Filename (optional)", "ops-bot.yaml");
  await app.type(
    "label:Bot definition",
    [
      "name: Ops Bot",
      "runtime: claude",
      "model: sonnet",
      "thinkingLevel: high",
      "persona: Direct SRE",
      "plugins:",
      "  - slack-tools",
      "  - missing-plugin",
      "instructions: |",
      "  Monitor incidents and escalate critical alerts.",
    ].join("\n"),
  );
  await app.press("label:Parse & load");
  await app.waitFor("id:template:local-ops-bot");
  const details = screen(app);
  expect(details).toContain("YAML");
  expect(details).toContain("ops-bot.yaml");
  expect(details).toContain("Not installed: missing-plugin");
  expect(details).toContain("Monitor incidents and escalate critical alerts.");

  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const sentLine = app.texts().find((line) => line.startsWith("Sent:")) ?? "";
  expect(sentLine).toContain('"name":"Ops Bot"');
  expect(sentLine).toContain(
    '"instructions":"Monitor incidents and escalate critical alerts.\\n"',
  );
  expect(sentLine).toContain('"runtime":"claude"');
  expect(sentLine).toContain('"model":"claude:sonnet"');
  expect(sentLine).toContain('"persona":"Direct SRE"');
  expect(sentLine).toContain('"thinkingLevel":"high"');
  expect(sentLine).toContain('"plugins":["slack-tools"]');
  expect(sentLine).not.toContain("missing-plugin");
});

test("importing a local file via file picker loads frontmatter Markdown and imports cleanly", async () => {
  const app = await gallery();
  const encoder = new TextEncoder();
  app.onPick(() => [
    {
      name: "code-auditor.md",
      type: "text/markdown",
      data: encoder.encode(
        [
          "---",
          "name: Code Auditor",
          "description: Audits security-sensitive changes.",
          "---",
          "Inspect authentication, permissions, and input validation.",
        ].join("\n"),
      ),
    },
  ]);

  await app.waitFor("label:Import file");
  await app.press("label:Import file");
  await app.waitFor("id:template:local-code-auditor");
  expect(screen(app)).toContain("Markdown");
  expect(screen(app)).toContain("code-auditor.md");
  expect(screen(app)).toContain("Audits security-sensitive changes.");

  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const sent = screen(app);
  expect(sent).toContain('"name":"Code Auditor"');
  expect(sent).toContain(
    '"instructions":"Inspect authentication, permissions, and input validation."',
  );
});

test("plugin-bundled agents appear under From plugins, auto-select ready parent plugin, and offer Configure when needs_config", async () => {
  const app = await gallery({ plugins: true });
  await app.waitFor("label:From plugins");
  await app.press("label:From plugins");
  await app.waitFor("id:template:plugin:slack-tools:standup-bot");
  await app.waitFor("id:template:plugin:github-tools:pr-guard");

  // Select ready plugin's bundled agent -> parent plugin auto-selected on import.
  await app.press("id:template:plugin:slack-tools:standup-bot");
  expect(screen(app)).toContain("Parent plugin");
  expect(screen(app)).toContain("Collects daily team standup notes in Slack.");
  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const firstSent = screen(app);
  expect(firstSent).toContain('"name":"Standup Bot"');
  expect(firstSent).toContain('"plugins":["slack-tools"]');

  // Select needs_config plugin's bundled agent -> inline Configure offered, unconfigured plugin NOT sent.
  await app.press("id:template:plugin:github-tools:pr-guard");
  await app.waitFor("text:Checks pull requests against repo policies.");
  expect(app.count("label:Configure")).toBe(1);
  await app.press("label:Import");
  await app.waitFor("text:Count: 2");
  const secondSent = screen(app);
  expect(secondSent).toContain('"name":"PR Guard"');
  expect(secondSent).toContain('"avatarSeed":"plugin:github-tools:pr-guard"');
  expect(secondSent).not.toContain('"plugins":["github-tools"]');
});

test("opening TemplateGallery with initialDraft (and switching drafts reactively) preloads fields and plugins", async () => {
  const app = await gallery({ draft: "local-json", plugins: true });
  await app.waitFor("id:template:local-release-bot");
  expect(screen(app)).toContain("JSON");
  expect(screen(app)).toContain("release-bot.json");
  expect(screen(app)).toContain("Automates release checklists.");

  await app.press("label:Import");
  await app.waitFor("text:Created: new-agent@home-new-agent");
  const sent = screen(app);
  expect(sent).toContain('"name":"Release Bot"');
  expect(sent).toContain('"persona":"Calm release coordinator"');
  expect(sent).toContain('"thinkingLevel":"high"');
  expect(sent).toContain('"plugins":["slack-tools"]');

  // Reactive initialDraft switches the open gallery to the plugin-bundled agent draft.
  await app.press("label:Switch draft");
  await app.waitFor("text:Collects daily team standup notes in Slack.");
  expect(screen(app)).toContain("Standup Bot");
  expect(screen(app)).toContain("Parent plugin");
});
