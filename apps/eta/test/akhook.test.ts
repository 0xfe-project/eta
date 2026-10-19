/**
 * akhook on the host, through a real socket: the project's `.akhook.yml` in the session's
 * directory, the host's own layer, ask rules that are cards in the inbox, streaming rules that
 * interrupt a generation, and the same rules on a daemon's sessions.
 */
import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

const touching = () =>
  scriptedModels((request) => {
    if (request.lastRole === "toolResult")
      return say(`The tool said: ${request.last}`);
    const file = /touch (\w+)/.exec(request.last)?.[1] ?? "marker";
    return call("bash", { command: `touch ${file}` }, `call-${file}`);
  });

async function ada(w: World, path?: string) {
  const agent = await w.agent("Ada");
  const project = await w.project({
    stewardId: agent.id,
    ...(path === undefined ? {} : { path }),
  });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  w.client.subscribe("inbox");
  return { agent, project, group };
}

const rows = (w: World): InteractionView[] =>
  w.client.section<InteractionView[]>("inbox", "list") ?? [];
const answer = (w: World, id: string, response: InboxResponse) =>
  w.client.call("inbox", "answer", { id, response });

const RULES = `version: 1
rules:
  - id: no-touch-secret
    on: shell_exec
    checks: [{argv: [touch, secret]}]
    message: secret is off limits
  - id: ask-touch-asked
    on: shell_exec
    action: ask
    checks: [{argv: [touch, asked]}]
    message: touching asked needs a person
`;

describe("the project's .akhook.yml", () => {
  it("denies a call, and the model reads why", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(join(dir, ".akhook.yml"), RULES);
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "please touch secret");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("no-touch-secret");
    expect(done.text).toContain("secret is off limits");
    expect(existsSync(join(dir, "secret"))).toBe(false);
  });

  it("asks through the inbox, with the rule's words, and runs on allow", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(join(dir, ".akhook.yml"), RULES);
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "please touch asked");
    await until(() => rows(w).some((row) => row.status === "pending"));
    const question = rows(w).find((row) => row.status === "pending")!;
    expect(question.prompt).toContain("ask-touch-asked");
    expect(question.prompt).toContain("touching asked needs a person");
    expect(question.options).toEqual(["allow", "deny"]);
    expect(existsSync(join(dir, "asked"))).toBe(false);
    await answer(w, question.id, { kind: "selection", selections: ["allow"] });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(existsSync(join(dir, "asked"))).toBe(true);
  });

  it("applies the next time the file is saved, to a session that is already open", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const first = await w.send(group.id, "please touch one");
    await w.settled(group.id, first.replies[0]!.id);
    expect(existsSync(join(dir, "one"))).toBe(true);

    await writeFile(
      join(dir, ".akhook.yml"),
      RULES.replaceAll("secret", "two"),
    );
    const second = await w.send(group.id, "please touch two");
    const done = await w.settled(group.id, second.replies[0]!.id);
    expect(done.text).toContain("two is off limits");
    expect(existsSync(join(dir, "two"))).toBe(false);
  });

  it("an unreadable file refuses the calls instead of letting them through", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(join(dir, ".akhook.yml"), "version: [");
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "please touch one");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("akhook could not check it");
    expect(existsSync(join(dir, "one"))).toBe(false);
  });
});

describe("the host's own layer", () => {
  it("cannot be disabled or replaced by the project's file", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(
      join(dir, ".akhook.yml"),
      `version: 1\ndisabled_rules: [host-rule]\nrules:\n  - id: host-rule\n    on: shell_exec\n    checks: [{regex: 'nothing'}]\n    message: project override\n`,
    );
    const w = await world({
      models,
      akhook: {
        additional: [
          {
            name: "environment",
            text: `version: 1\nrules:\n  - id: host-rule\n    on: shell_exec\n    checks: [{argv: [touch, one]}]\n    message: set by the environment\n`,
          },
        ],
      },
    });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "please touch one");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("set by the environment");
    expect(existsSync(join(dir, "one"))).toBe(false);
  });

  it("reads akhook.yml from the data directory", async () => {
    const { models } = touching();
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "akhook.yml"),
      `version: 1\nrules:\n  - id: from-data-dir\n    on: shell_exec\n    checks: [{argv: [touch, one]}]\n    message: data dir rule\n`,
    );
    const w = await world({ models, dataDir });
    const { group, project } = await ada(w);
    const sent = await w.send(group.id, "please touch one");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("data dir rule");
    expect(existsSync(join(project.path, "one"))).toBe(false);
  });
});

describe("the approval list and an ask rule are one question", () => {
  it("a call both want to ask about is asked once", async () => {
    const { models } = touching();
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(join(dir, ".akhook.yml"), RULES);
    const w = await world({ models });
    const { group } = await ada(w, dir);
    await w.client.call("inbox", "setApprovals", { tools: ["bash"] });
    const sent = await w.send(group.id, "please touch asked");
    await until(() => rows(w).some((row) => row.status === "pending"));
    expect(rows(w)).toHaveLength(1);
    await answer(w, rows(w)[0]!.id, {
      kind: "selection",
      selections: ["allow"],
    });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(rows(w)).toHaveLength(1);
    expect(existsSync(join(dir, "asked"))).toBe(true);
  });
});

describe("streaming rules", () => {
  const stream = `version: 1
rules:
  - id: no-forbidden
    on: stream
    checks: [{regex: 'forbidden'}]
    message: Do not use the word forbidden; say something else.
`;

  it("interrupt a generation, and the reply is the one generated again", async () => {
    const dir = await tempDir("eta-akhook-project-");
    await writeFile(join(dir, ".akhook.yml"), stream);
    const { models, requests } = scriptedModels((request) =>
      request.transcript.some((line) =>
        line.includes("Do not use the word forbidden"),
      )
        ? say("a perfectly allowed answer")
        : say("this is forbidden"),
    );
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "say something");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("a perfectly allowed answer");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.transcript.join("\n")).toContain("rule_violation");
    expect(requests[1]!.transcript.join("\n")).not.toContain(
      "this is forbidden",
    );
  });
});

describe("lifecycle rules", () => {
  it("prompt_submit's context goes ahead of the briefing; stop is told how the reply ended", async () => {
    const dir = await tempDir("eta-akhook-project-");
    const hook = join(dir, "hook.sh");
    await writeFile(
      hook,
      `#!/bin/sh\ncat > "${dir}/$1.in"\nif [ "$1" = "recall" ]; then echo '{"context":"[remembered: the user likes tea]"}'; fi\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, ".akhook.yml"),
      `version: 1\nrules:\n  - id: recall\n    on: prompt_submit\n    run: {argv: ["${hook}", recall]}\n  - id: capture\n    on: stop\n    run: {argv: ["${hook}", capture]}\n`,
    );
    const { models, requests } = scriptedModels(() => say("noted, tea it is"));
    const w = await world({ models });
    const { group } = await ada(w, dir);
    const sent = await w.send(group.id, "what do I like?");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.transcript.join("\n")).toContain(
      "[remembered: the user likes tea]",
    );
    await until(() => existsSync(join(dir, "capture.in")));
    expect(existsSync(join(dir, "recall.in"))).toBe(true);
  });
});

describe("on a daemon's machine", () => {
  it("the project's .akhook.yml there applies to the session", async () => {
    const { models } = touching();
    const r = await remoteWorld({ models });
    await writeFile(join(r.dir, ".akhook.yml"), RULES);
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "please touch secret");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("secret is off limits");
    expect(existsSync(join(r.dir, "secret"))).toBe(false);
  });

  it("the host's layer travels to the daemon, and an ask rule is a card in the primary's inbox", async () => {
    const { models } = touching();
    const r = await remoteWorld({
      models,
      akhook: {
        additional: [
          {
            name: "environment",
            text: RULES,
          },
        ],
      },
    });
    const { group } = await r.agents("Ada");
    r.client.subscribe("inbox");
    const sent = await r.send(group.id, "please touch asked");
    await until(() => rows(r).some((row) => row.status === "pending"));
    const question = rows(r).find((row) => row.status === "pending")!;
    expect(question.prompt).toContain("touching asked needs a person");
    expect(existsSync(join(r.dir, "asked"))).toBe(false);
    await answer(r, question.id, { kind: "selection", selections: ["allow"] });
    await r.settled(group.id, sent.replies[0]!.id);
    expect(existsSync(join(r.dir, "asked"))).toBe(true);

    const denied = await r.send(group.id, "please touch secret");
    const done = await r.settled(group.id, denied.replies[0]!.id);
    expect(done.text).toContain("secret is off limits");
    expect(existsSync(join(r.dir, "secret"))).toBe(false);
  });
});
