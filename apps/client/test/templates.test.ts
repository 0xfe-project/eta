import { expect, test } from "nsh/test";
import { templates, templateSource } from "../src/pages/templates/catalog";
import { templateLinkId } from "../src/pages/templates/link";
import { parseRoleCard, unwrap } from "../src/pages/templates/role-card";
import {
  fillTemplate,
  findTemplates,
  inferredIntegrations,
  placeholdersOf,
  pluginMatchesIntegration,
  templateCategories,
} from "../src/pages/templates/template";

const card = `# Account Specialist (one per account)

**Seen on stream as:** Harbor, Northwind (Blake)
**Category:** Sales & sales engineering

A dedicated bot with the full context of one account: plan,
stakeholders, renewal.

## Owns

- The account plan in {CRM}.
- Watching the account's channels.

## Does not own

- Other accounts.

## Needs approval for

- External sends.

## Role description — paste and fill the placeholders

\`\`\`text
You are {NAME}, account specialist for {ACCOUNT}. You know
everything about them.

Each call:
1. Update the plan.
2. Tell {CHIEF}.
\`\`\`

## From the stream

> "Something a presenter said."
`;

test("a role card becomes a template; who played it on stream stays out", () => {
  expect(parseRoleCard("account-specialist.md", card)).toEqual({
    id: "account-specialist",
    name: "Account Specialist",
    note: "one per account",
    category: "Sales & sales engineering",
    summary:
      "A dedicated bot with the full context of one account: plan, stakeholders, renewal.",
    owns: ["The account plan in {CRM}.", "Watching the account's channels."],
    doesNotOwn: ["Other accounts."],
    needsApproval: ["External sends."],
    instructions:
      "You are {NAME}, account specialist for {ACCOUNT}. You know everything about them.\n\nEach call:\n1. Update the plan.\n2. Tell {CHIEF}.",
  });
  expect(() => parseRoleCard("readme.md", "# Roster\n")).toThrow();
});

test("hand-wrapped lines join; list items and paragraphs keep their own lines", () => {
  expect(unwrap("one\ntwo\n\n- a\n- b\nc")).toBe("one two\n\n- a\n- b c");
});

test("the bundled catalog: every template has a summary, instructions and a known category", () => {
  expect(templates.length).toBeGreaterThan(0);
  for (const template of templates) {
    expect(template.summary.length).toBeGreaterThan(0);
    expect(template.instructions.length).toBeGreaterThan(0);
    expect(Object.keys(templateCategories)).toContain(template.category);
  }
  // Unique ids, however many the catalog holds.
  expect(new Set(templates.map((template) => template.id)).size).toBe(
    templates.length,
  );
  // Where they came from, at one commit, and under what license.
  expect(templateSource.license).toBe("MIT");
  expect(templateSource.url).toContain(templateSource.commit);
});

test("{NAME} is the agent's name; a placeholder filled in is replaced, the rest stay", () => {
  const text = "You are {NAME} for {ACCOUNT}; tell {CHIEF} and {ACCOUNT}.";
  expect(placeholdersOf(text)).toEqual(["ACCOUNT", "CHIEF"]);
  expect(fillTemplate(text, "Ada", { ACCOUNT: "Acme", CHIEF: "  " })).toBe(
    "You are Ada for Acme; tell {CHIEF} and Acme.",
  );
  expect(fillTemplate(text, " ", {})).toBe(text);
});

test("nested optional, variant, and example braces parse and fill cleanly across all 5 bundled templates", () => {
  const byId = (id: string) =>
    templates.find((template) => template.id === id)!;

  // 1. chief-of-staff: {OPTIONAL: start with a joke about {TOPIC}.}
  const chief = byId("chief-of-staff");
  expect(placeholdersOf(chief.instructions)).toContain("TOPIC");
  expect(
    placeholdersOf(chief.instructions).some((key) => key.includes("OPTIONAL")),
  ).toBe(false);
  const chiefEmpty = fillTemplate(chief.instructions, "Chief", {});
  expect(chiefEmpty).not.toContain("{OPTIONAL:");
  expect(chiefEmpty).toContain("and what to do next.\n\nIf a routine");
  const chiefFilled = fillTemplate(chief.instructions, "Chief", {
    TOPIC: "coffee",
  });
  expect(chiefFilled).not.toContain("{OPTIONAL:");
  expect(chiefFilled).toContain(
    "and what to do next. start with a joke about coffee.",
  );

  // 2. kanban-updater: When a card moves to In progress, {OPTIONAL: tell {BOT} to start on it}.
  const kanban = byId("kanban-updater");
  expect(placeholdersOf(kanban.instructions)).toContain("BOT");
  const kanbanEmpty = fillTemplate(kanban.instructions, "Kanban", {});
  expect(kanbanEmpty).not.toContain("{OPTIONAL:");
  expect(kanbanEmpty).not.toContain(", .");
  expect(kanbanEmpty).toContain("When a card moves to In progress. Share");
  const kanbanFilled = fillTemplate(kanban.instructions, "Kanban", {
    BOT: "Builder",
  });
  expect(kanbanFilled).toContain(
    "When a card moves to In progress, tell Builder to start on it. Share",
  );

  // 3. product-marketer: {OPTIONAL: vet claims with {EXPERT PLUGIN}.}
  const pm = byId("product-marketer");
  expect(placeholdersOf(pm.instructions)).toContain("EXPERT PLUGIN");
  const pmEmpty = fillTemplate(pm.instructions, "PM", {});
  expect(pmEmpty).not.toContain("{OPTIONAL:");
  expect(pmEmpty).toMatch(/headline, description\.$/);
  const pmFilled = fillTemplate(pm.instructions, "PM", {
    "EXPERT PLUGIN": "Legal",
  });
  expect(pmFilled).toContain("headline, description. vet claims with Legal.");

  // 4. slack-mention-responder: {e.g. ... {BOARD} ... {KB} ...}
  const slack = byId("slack-mention-responder");
  expect(placeholdersOf(slack.instructions)).toEqual([
    "HANDLE",
    "BOARD",
    "KB",
    "HUMAN / CHIEF",
  ]);
  const slackEmpty = fillTemplate(slack.instructions, "Responder", {});
  expect(slackEmpty).not.toContain("{e.g.");
  expect(slackEmpty).toContain("mark it done in {BOARD}");
  expect(slackEmpty).toContain("answer from {KB} and cite.");
  const slackFilled = fillTemplate(slack.instructions, "Responder", {
    HANDLE: "@ops",
    BOARD: "Linear",
    KB: "Notion",
    "HUMAN / CHIEF": "Alice",
  });
  expect(slackFilled).not.toContain("{");
  expect(slackFilled).not.toContain("}");
  expect(slackFilled).toContain("mark it done in Linear");
  expect(slackFilled).toContain("answer from Notion and cite.");

  // 5. support-tuner: {GIT VARIANT: ... {OWNER} ...}
  const tuner = byId("support-tuner");
  expect(placeholdersOf(tuner.instructions)).toContain("OWNER");
  const tunerEmpty = fillTemplate(tuner.instructions, "Tuner", {});
  expect(tunerEmpty).not.toContain("{GIT VARIANT:");
  expect(tunerEmpty).toMatch(/the fix for each\.$/);
  const tunerFilled = fillTemplate(tuner.instructions, "Tuner", {
    OWNER: "Ada",
  });
  expect(tunerFilled).not.toContain("{GIT VARIANT:");
  expect(tunerFilled).toContain(
    "open a PR per fix; it must pass evals on the branch and be approved by Ada before merge.",
  );
});

test("preview bullets substitute filled placeholders cleanly", () => {
  const account = templates.find(
    (template) => template.id === "account-specialist",
  )!;
  const rendered = account.owns.map((line) =>
    fillTemplate(line, "Harbor", { ACCOUNT: "Acme" }),
  );
  expect(rendered).toContain(
    'Answering "where are we with Acme" to the chief.',
  );
});

test("inferredIntegrations identifies common tool mentions and matches installed/Composio names", () => {
  const slack = templates.find(
    (template) => template.id === "slack-mention-responder",
  )!;
  expect(inferredIntegrations(slack)).toContain("slack");
  expect(pluginMatchesIntegration("@composio/slack", "slack")).toBe(true);
  expect(pluginMatchesIntegration("slack-mcp", "slack")).toBe(true);
  expect(pluginMatchesIntegration("github", "slack")).toBe(false);
});

test("search matches every word in the name, summary or category, Chinese category names too", () => {
  const ids = (query: string, category?: string) =>
    findTemplates(templates, query, category).map((template) => template.id);
  expect(ids("account specialist")).toEqual(["account-specialist"]);
  expect(ids("销售").length).toBe(16);
  expect(ids("", "Customer support").length).toBe(4);
  expect(ids("nothing matches this")).toEqual([]);
});

test("a template link names a template of the catalog, and nothing else", () => {
  expect(templateLinkId("eta://template?id=chief-of-staff")).toBe(
    "chief-of-staff",
  );
  expect(templateLinkId("https://host.example/?template=pr-reviewer")).toBe(
    "pr-reviewer",
  );
  expect(templateLinkId("eta://template?id=not-a-template")).toBeUndefined();
  expect(
    templateLinkId("eta://connect?address=h&id=chief-of-staff"),
  ).toBeUndefined();
  expect(templateLinkId("https://host.example/")).toBeUndefined();
  expect(templateLinkId("not a url")).toBeUndefined();
  expect(templateLinkId(undefined)).toBeUndefined();
});
