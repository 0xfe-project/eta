import { expect, test } from "nsh/test";
import { templates, templateSource } from "../src/pages/templates/catalog";
import { templateLinkId } from "../src/pages/templates/link";
import { parseRoleCard, unwrap } from "../src/pages/templates/role-card";
import {
  fillTemplate,
  findTemplates,
  placeholdersOf,
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
  expect(templates.length).toBe(69);
  for (const template of templates) {
    expect(template.summary.length).toBeGreaterThan(0);
    expect(template.instructions.length).toBeGreaterThan(0);
    expect(Object.keys(templateCategories)).toContain(template.category);
  }
  expect(new Set(templates.map((template) => template.id)).size).toBe(69);
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
