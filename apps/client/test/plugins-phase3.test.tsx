import { expect, open, test } from "nsh/test";

const OPEN = { width: 1100, height: 850 };

test("PluginDetail in tablet layout renders bundledAgents and invokes onImportAgent on Import", async () => {
  const app = await open("./fixtures/plugins-phase3.tsx", OPEN);
  expect(app.shows("BUNDLED AGENTS")).toBe(true);
  expect(app.shows("Code Reviewer")).toBe(true);
  expect(app.shows("Reviews pull requests for bugs and regressions.")).toBe(
    true,
  );
  expect(app.shows("Security Auditor")).toBe(true);

  await app.press("label:Import Code Reviewer");
  expect(
    app.shows(
      "text:imported:bundle-plugin:code-reviewer:Code Reviewer:agents/code-reviewer.md:Inspect diffs carefully and flag concrete defects.",
    ),
  ).toBe(true);

  await app.press("label:plain-plugin");
  expect(app.shows("BUNDLED AGENTS")).toBe(false);
});

test("PluginDetail hides Import button when onImportAgent is not provided", async () => {
  const app = await open("./fixtures/plugins-phase3.tsx", OPEN);
  await app.press("label:mode-tablet-readonly");
  expect(app.shows("BUNDLED AGENTS")).toBe(true);
  expect(app.shows("Code Reviewer")).toBe(true);
  expect(app.shows("label:Import Code Reviewer")).toBe(false);
});

test("Plugins in desktop layout exposes bundledAgents modal and fires onImportAgent", async () => {
  const app = await open("./fixtures/plugins-phase3.tsx", OPEN);
  await app.press("label:mode-desktop");
  expect(app.shows("label:Agents (2)")).toBe(true);

  await app.press("label:Agents (2)");
  expect(app.shows("Bundled agents · bundle-plugin")).toBe(true);
  expect(app.shows("Code Reviewer")).toBe(true);
  expect(app.shows("Security Auditor")).toBe(true);

  await app.press("label:Import Security Auditor");
  expect(
    app.shows(
      "text:imported:bundle-plugin:security-auditor:Security Auditor:agents/security-auditor.md:Check for injection, auth bypasses, and secret leaks.",
    ),
  ).toBe(true);
  expect(app.shows("Bundled agents · bundle-plugin")).toBe(false);
});

test("Market preview renders bundledAgents as plain text and omits section when empty", async () => {
  const app = await open("./fixtures/plugins-phase3.tsx", OPEN);
  await app.press("label:mode-market");
  await app.waitFor("label:market-with-bots");

  await app.press("label:market-with-bots");
  await app.waitFor("id:market-bundled-agents");
  expect(app.shows("Bundled agents")).toBe(true);
  expect(app.shows("Release Bot")).toBe(true);
  expect(app.shows("Automates <release> notes & checklists.")).toBe(true);
  expect(app.shows("Triage Bot")).toBe(true);

  await app.press("label:Close");
  await app.press("label:market-no-bots");
  await app.waitFor("id:market-info");
  expect(app.count("id:market-bundled-agents")).toBe(0);
});
