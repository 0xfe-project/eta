import type {
  ImportedBotDraft,
  LocalBotParseResult,
  LocalBotSourceKind,
} from "../src/pages/templates/local-import";
import { expect, test } from "nsh/test";
import {
  LOCAL_BOT_MAX_BYTES,
  parseLocalBot,
} from "../src/pages/templates/local-import";

const roleCardSample = `# Account Specialist (one per account)

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
`;

test("parses full json bot config with all optional fields", () => {
  const input = JSON.stringify({
    id: "PR Reviewer!",
    name: "PR Reviewer",
    note: "one per repo",
    category: "Engineering",
    summary: "Reviews pull requests thoroughly.",
    owns: ["Code review comments", "Test coverage checks"],
    doesNotOwn: ["Merging PRs"],
    needsApproval: ["Requesting changes on release branches"],
    recommendedPlugins: ["github", "linear"],
    persona: "Concise senior engineer",
    runtime: "claude",
    model: "claude:opus",
    thinkingLevel: "high",
    machineId: "mac-studio",
    plugins: ["github"],
    instructions: "Review every diff carefully and report concrete issues.",
  });

  const result: LocalBotParseResult = parseLocalBot(input, "pr-reviewer.json");
  const expectedKind: LocalBotSourceKind = "json";
  const expectedDraft: ImportedBotDraft = {
    sourceKind: expectedKind,
    filename: "pr-reviewer.json",
    runtime: "claude",
    model: "claude:opus",
    thinkingLevel: "high",
    machineId: "mac-studio",
    persona: "Concise senior engineer",
    plugins: ["github"],
    template: {
      id: "local-pr-reviewer",
      name: "PR Reviewer",
      note: "one per repo",
      category: "Engineering",
      summary: "Reviews pull requests thoroughly.",
      owns: ["Code review comments", "Test coverage checks"],
      doesNotOwn: ["Merging PRs"],
      needsApproval: ["Requesting changes on release branches"],
      recommendedPlugins: ["github", "linear"],
      instructions: "Review every diff carefully and report concrete issues.",
    },
  };
  expect(result).toEqual({
    ok: true,
    draft: expectedDraft,
  });
});

test("parses minimal json bot config and falls back to filename stem for name", () => {
  const pasted = parseLocalBot(
    JSON.stringify({
      name: "Triage Helper",
      description: "Triages incoming bugs.",
      instructions: "Label and prioritize incoming issues.",
      model: null,
      thinkingLevel: null,
      machineId: null,
    }),
  );
  expect(pasted.ok).toBe(true);
  if (!pasted.ok) return;
  expect(pasted.draft.sourceKind).toBe("json");
  expect(pasted.draft.template.id).toBe("local-triage-helper");
  expect(pasted.draft.template.category).toBe("Local");
  expect(pasted.draft.template.summary).toBe("Triages incoming bugs.");
  expect(pasted.draft.model).toBeNull();
  expect(pasted.draft.thinkingLevel).toBeNull();
  expect(pasted.draft.machineId).toBeNull();

  const namedFromFile = parseLocalBot(
    JSON.stringify({ instructions: "Watch alerts and summarize incidents." }),
    "/tmp/incident_watcher.json",
  );
  expect(namedFromFile.ok).toBe(true);
  if (!namedFromFile.ok) return;
  expect(namedFromFile.draft.template.name).toBe("Incident Watcher");
  expect(namedFromFile.draft.template.id).toBe("local-incident-watcher");
});

test("rejects invalid json, missing fields, and invalid runtime or thinkingLevel", () => {
  const badJson = parseLocalBot("{not valid json", "broken.json");
  expect(badJson.ok).toBe(false);
  if (!badJson.ok) expect(badJson.error).toContain("Invalid JSON");

  const nonObject = parseLocalBot('["not", "an", "object"]', "arr.json");
  expect(nonObject.ok).toBe(false);

  const missingName = parseLocalBot(
    JSON.stringify({ instructions: "Do work." }),
  );
  expect(missingName.ok).toBe(false);
  if (!missingName.ok) expect(missingName.error).toContain("name");

  const missingInstructions = parseLocalBot(
    JSON.stringify({ name: "Empty Bot" }),
    "empty.json",
  );
  expect(missingInstructions.ok).toBe(false);
  if (!missingInstructions.ok) {
    expect(missingInstructions.error).toContain("instructions");
  }

  const badRuntime = parseLocalBot(
    JSON.stringify({
      name: "Bad Runtime",
      runtime: "bash",
      instructions: "Hi",
    }),
  );
  expect(badRuntime.ok).toBe(false);
  if (!badRuntime.ok) expect(badRuntime.error).toContain("runtime");

  const acpRuntime = parseLocalBot(
    JSON.stringify({
      name: "ACP Bot",
      runtime: "acp.my-agent",
      instructions: "Hi",
    }),
  );
  expect(acpRuntime.ok).toBe(true);

  const badThinking = parseLocalBot(
    JSON.stringify({
      name: "Bad Thinking",
      thinkingLevel: "extreme",
      instructions: "Hi",
    }),
  );
  expect(badThinking.ok).toBe(false);
  if (!badThinking.ok) expect(badThinking.error).toContain("thinkingLevel");

  const badPlugins = parseLocalBot(
    JSON.stringify({
      name: "Bad Plugins",
      plugins: "github",
      instructions: "Hi",
    }),
  );
  expect(badPlugins.ok).toBe(false);
  if (!badPlugins.ok) expect(badPlugins.error).toContain("plugins");
});

test("parses yaml bot config matching agent-file.ts output including comments, nulls, lists, and block literals", () => {
  const agentFileYaml = `\uFEFF# Agent configuration\r\n#\r\n# Save to apply.\r\n\r\nname: Ada\r\npersona: ""\r\nruntime: eta\r\nmodel: a:m1\r\nthinkingLevel: low\r\nmachineId: null\r\nplugins:\r\n  - notes\r\n  - github\r\ninstructions: |-\r\n  Be brief.\r\n  Answer in English.\r\n`;

  // Works both with a .yaml filename and when pasted without a filename.
  for (const filename of ["ada.yaml", undefined]) {
    const result = parseLocalBot(agentFileYaml, filename);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    expect(result.draft.sourceKind).toBe("yaml");
    expect(result.draft.template.name).toBe("Ada");
    expect(result.draft.template.id).toBe("local-ada");
    expect(result.draft.persona).toBe("");
    expect(result.draft.runtime).toBe("eta");
    expect(result.draft.model).toBe("a:m1");
    expect(result.draft.thinkingLevel).toBe("low");
    expect(result.draft.machineId).toBeNull();
    expect(result.draft.plugins).toEqual(["notes", "github"]);
    expect(result.draft.template.instructions).toBe(
      "Be brief.\nAnswer in English.",
    );
  }
});

test("parses yaml with explicit block indent, quoted scalars, inline arrays, and folded blocks", () => {
  const yaml = `
# Custom agent
name: "null"
description: 'Handles "edge" cases'' cleanly'
category: Engineering
runtime: codex
model: ~
thinkingLevel: null
plugins: [slack, "linear", 'github']
recommendedPlugins:
  - sentry
instructions: |2
    leading spaces
  key: value
  # not a comment

  trailing
`;

  const result = parseLocalBot(yaml, "edge.yml");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.draft.template.name).toBe("null");
  expect(result.draft.template.summary).toBe('Handles "edge" cases\' cleanly');
  expect(result.draft.template.category).toBe("Engineering");
  expect(result.draft.template.recommendedPlugins).toEqual(["sentry"]);
  expect(result.draft.runtime).toBe("codex");
  expect(result.draft.model).toBeNull();
  expect(result.draft.thinkingLevel).toBeNull();
  expect(result.draft.plugins).toEqual(["slack", "linear", "github"]);
  expect(result.draft.template.instructions).toBe(
    "  leading spaces\nkey: value\n# not a comment\n\ntrailing\n",
  );

  const folded = parseLocalBot(
    `name: Folder\nplugins: []\ninstructions: >-\n  First line\n  second line.\n\n  Next paragraph.\n`,
    "folder.yaml",
  );
  expect(folded.ok).toBe(true);
  if (!folded.ok) return;
  expect(folded.draft.plugins).toEqual([]);
  expect(folded.draft.template.instructions).toBe(
    "First line second line.\nNext paragraph.",
  );
});

test("rejects invalid yaml field types and malformed syntax", () => {
  const badPlugins = parseLocalBot(
    "name: Ada\nplugins: notes\ninstructions: Be brief.\n",
    "bad.yaml",
  );
  expect(badPlugins.ok).toBe(false);
  if (!badPlugins.ok) expect(badPlugins.error).toContain("plugins");

  const badPersona = parseLocalBot(
    "name: Ada\npersona: 3\ninstructions: Be brief.\n",
    "bad.yaml",
  );
  expect(badPersona.ok).toBe(false);
  if (!badPersona.ok) expect(badPersona.error).toContain("persona");

  const badRuntime = parseLocalBot(
    "name: Ada\nruntime: unknown-rt\ninstructions: Be brief.\n",
    "bad.yaml",
  );
  expect(badRuntime.ok).toBe(false);
  if (!badRuntime.ok) expect(badRuntime.error).toContain("runtime");

  const dupKey = parseLocalBot(
    "name: Ada\nname: Bea\ninstructions: Hi\n",
    "dup.yaml",
  );
  expect(dupKey.ok).toBe(false);
  if (!dupKey.ok) expect(dupKey.error).toContain("duplicate");

  const sequenceRoot = parseLocalBot("- Ada\n- Bea\n", "list.yaml");
  expect(sequenceRoot.ok).toBe(false);
});

test("parses role card markdown via parseRoleCard with local-prefixed id", () => {
  const result = parseLocalBot(roleCardSample, "account-specialist.md");
  expect(result).toEqual({
    ok: true,
    draft: {
      sourceKind: "role-card",
      filename: "account-specialist.md",
      template: {
        id: "local-account-specialist",
        name: "Account Specialist",
        note: "one per account",
        category: "Sales & sales engineering",
        summary:
          "A dedicated bot with the full context of one account: plan, stakeholders, renewal.",
        owns: [
          "The account plan in {CRM}.",
          "Watching the account's channels.",
        ],
        doesNotOwn: ["Other accounts."],
        needsApproval: ["External sends."],
        instructions:
          "You are {NAME}, account specialist for {ACCOUNT}. You know everything about them.\n\nEach call:\n1. Update the plan.\n2. Tell {CHIEF}.",
      },
    },
  });

  // Also auto-detects role cards when pasted without a filename.
  const pasted = parseLocalBot(roleCardSample);
  expect(pasted.ok).toBe(true);
  if (!pasted.ok) return;
  expect(pasted.draft.sourceKind).toBe("role-card");
  expect(pasted.draft.template.id).toBe("local-account-specialist");
});

test("parses claude and cursor frontmatter markdown agents and ignores unknown keys", () => {
  const claudeAgent = `---
name: security-auditor
description: Audits PRs for security vulnerabilities
tools: Read, Grep, Glob
color: red
model: sonnet
runtime: claude
thinkingLevel: medium
recommendedPlugins:
  - github
---

You are a security auditor.
Check authentication, authorization, and injection vectors on every change.
`;

  const result = parseLocalBot(claudeAgent, "security-auditor.md");
  expect(result).toEqual({
    ok: true,
    draft: {
      sourceKind: "markdown-agent",
      filename: "security-auditor.md",
      runtime: "claude",
      model: "sonnet",
      thinkingLevel: "medium",
      template: {
        id: "local-security-auditor",
        name: "security-auditor",
        category: "Local",
        summary: "Audits PRs for security vulnerabilities",
        owns: [],
        doesNotOwn: [],
        needsApproval: [],
        recommendedPlugins: ["github"],
        instructions:
          "You are a security auditor.\nCheck authentication, authorization, and injection vectors on every change.",
      },
    },
  });

  // Auto-detects frontmatter without filename and rejects empty body.
  const pasted = parseLocalBot(claudeAgent);
  expect(pasted.ok).toBe(true);
  if (pasted.ok) expect(pasted.draft.sourceKind).toBe("markdown-agent");

  const emptyBody = parseLocalBot(
    "---\nname: empty-agent\ndescription: No body\n---\n   \n",
    "empty.md",
  );
  expect(emptyBody.ok).toBe(false);
  if (!emptyBody.ok) expect(emptyBody.error).toContain("empty instructions");
});

test("parses plain markdown with heading and without heading (with and without filename)", () => {
  const withHeading = parseLocalBot(
    "# Release Manager\n\nCoordinate weekly releases and verify changelogs.",
  );
  expect(withHeading).toEqual({
    ok: true,
    draft: {
      sourceKind: "markdown-agent",
      template: {
        id: "local-release-manager",
        name: "Release Manager",
        category: "Local",
        summary: "Coordinate weekly releases and verify changelogs.",
        owns: [],
        doesNotOwn: [],
        needsApproval: [],
        instructions: "Coordinate weekly releases and verify changelogs.",
      },
    },
  });

  const headingOnly = parseLocalBot("# Release Manager\n\n");
  expect(headingOnly.ok).toBe(false);

  const withoutHeadingWithFile = parseLocalBot(
    "Summarize customer tickets and draft crisp replies.",
    "ticket-helper.md",
  );
  expect(withoutHeadingWithFile.ok).toBe(true);
  if (!withoutHeadingWithFile.ok) return;
  expect(withoutHeadingWithFile.draft.sourceKind).toBe("markdown-agent");
  expect(withoutHeadingWithFile.draft.template.name).toBe("Ticket Helper");
  expect(withoutHeadingWithFile.draft.template.id).toBe("local-ticket-helper");
  expect(withoutHeadingWithFile.draft.template.instructions).toBe(
    "Summarize customer tickets and draft crisp replies.",
  );

  const withoutHeadingNoFile = parseLocalBot(
    "Summarize customer tickets and draft crisp replies.",
  );
  expect(withoutHeadingNoFile.ok).toBe(false);
  if (!withoutHeadingNoFile.ok) {
    expect(withoutHeadingNoFile.error).toContain("name");
  }
});

test("rejects empty, whitespace-only, and oversized inputs", () => {
  expect(parseLocalBot("").ok).toBe(false);
  expect(parseLocalBot("   \n\t  ", "blank.md").ok).toBe(false);

  const oversized = `# Huge Bot\n\n${"a".repeat(LOCAL_BOT_MAX_BYTES)}`;
  const overRes = parseLocalBot(oversized, "huge.md");
  expect(overRes.ok).toBe(false);
  if (!overRes.ok) expect(overRes.error).toContain("256 KiB");

  // Multi-byte UTF-8 characters are counted by byte length, not code unit length.
  const multiByteOver = "汉".repeat(Math.floor(LOCAL_BOT_MAX_BYTES / 3) + 1);
  const mbRes = parseLocalBot(multiByteOver, "zh.md");
  expect(mbRes.ok).toBe(false);
  if (!mbRes.ok) expect(mbRes.error).toContain("256 KiB");
});
