import type { Host } from "../src/host";
/**
 * Tools that ask before they run (REFACTOR.md §9, P2.6 — 审批 = ask).
 *
 * The claim is the one the doc makes: with a tool on the approval list, a run *stops at that call*
 * and waits. Allowed, the call happens and the model reads its output; denied, the call does not
 * happen and the model reads the refusal — and the run carries on either way, because a refusal is
 * a tool result, not a failure.
 *
 * The list is configuration, so a test states the policy the same way a user would, and a tool that
 * is not on it never asks.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

/** A model that wants to run one command, then says whatever it is told to say. */
const scriptingModels = (command: string, last = "done") =>
  fakeModels([
    assistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall" as const,
          id: "call-bash",
          name: "bash",
          arguments: { command },
        },
      ],
    }),
    assistantMessage({ content: [{ type: "text", text: last }] }),
  ]);

interface Card {
  id: string;
  prompt: string;
  options: { value: string; label: string }[];
  status: string;
  answer: string | null;
}

async function start(
  models: ReturnType<typeof scriptingModels>,
  approvals: string[],
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-approval-"));
  roots.push(root);
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      providers: [
        {
          id: "local",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{ id: "m1" }],
        },
      ],
      defaultModel: "local:m1",
      approvals: { tools: approvals },
    }),
    "utf8",
  );
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models,
  });
  hosts.push(host);
  return host;
}

/** Send one message and follow the run until it settles, or the budget runs out. */
async function run(
  host: Host,
  groupId: string,
  agentId: string,
): Promise<{
  cards: Card[];
  texts: string[];
  replyStatus: string | undefined;
}> {
  const sent = (await (
    await send(host, "POST", "/api/v1/chat/messages", {
      group_id: groupId,
      mentions: [agentId],
      parts: [{ type: "text", text: "please run it" }],
      mode: "queue",
    })
  ).json()) as { replies: { id: string }[] };
  const replyId = sent.replies[0]!.id;

  const deadline = Date.now() + 8_000;
  for (;;) {
    const cards = (await (
      await send(host, "GET", "/api/v1/chat/interactions?limit=10")
    ).json()) as { interactions: Card[] };
    const pending = cards.interactions.find(
      (card) => card.status === "pending",
    );
    if (pending !== undefined) {
      // The run is parked on this one; whoever is testing decides what to answer.
      return {
        cards: cards.interactions,
        texts: [replyId],
        replyStatus: "waiting_for_input",
      };
    }
    const page = (await (
      await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
    ).json()) as { items: { id: string; status: string }[] };
    const reply = page.items.find((item) => item.id === replyId);
    const busy =
      reply !== undefined &&
      ["queued", "responding", "stopping", "waiting_for_input"].includes(
        reply.status,
      );
    if (!busy || Date.now() > deadline) {
      return {
        cards: cards.interactions,
        texts: [replyId],
        replyStatus: reply?.status,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const conversation = async (
  host: Host,
): Promise<{ agentId: string; groupId: string }> => {
  const agent = (await (
    await send(host, "POST", "/agents", { name: "runner" })
  ).json()) as { agent: { id: string } };
  const group = (await (
    await send(host, "POST", "/groups", {
      name: "approval test",
      agentIds: [agent.agent.id],
    })
  ).json()) as { group: { id: string } };
  return { agentId: agent.agent.id, groupId: group.group.id };
};

/** What the run's transcript says the tool call produced. */
const toolResults = async (host: Host, groupId: string): Promise<string[]> => {
  const participant = host.groups.participantsOf(groupId)[0];
  const managed = await host.sessions.session(participant?.sessionId ?? "");
  const transcript = managed?.session.journaling.transcript() ?? [];
  return transcript
    .filter((entry) => entry.role === "toolResult")
    .map((entry) =>
      typeof entry.content === "string"
        ? entry.content
        : entry.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
};

describe("a tool on the approval list", () => {
  it("stops the run at the call, and runs it once the user allows", async () => {
    const host = await start(scriptingModels("echo approved-by-user"), [
      "bash",
    ]);
    const { agentId, groupId } = await conversation(host);

    const parked = await run(host, groupId, agentId);
    const card = parked.cards.find((entry) => entry.status === "pending");
    expect(card).toMatchObject({
      id: "call-bash",
      prompt: "Run the `bash` tool?",
      options: [
        { value: "allow", label: "allow" },
        { value: "deny", label: "deny" },
      ],
      answer: null,
    });

    const answered = (await (
      await send(host, "POST", `/api/v1/chat/interactions/${card!.id}/answer`, {
        value: "allow",
      })
    ).json()) as Card;
    expect(answered.status).toBe("resolved");

    // The call happened, and the model read what it printed.
    const deadline = Date.now() + 5_000;
    let results: string[] = [];
    for (;;) {
      results = await toolResults(host, groupId);
      if (results.length > 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(results.join("\n")).toContain("approved-by-user");
  });

  it("refuses the call when the user denies, and lets the run continue", async () => {
    const host = await start(scriptingModels("echo never-runs", "understood"), [
      "bash",
    ]);
    const { agentId, groupId } = await conversation(host);

    const parked = await run(host, groupId, agentId);
    const card = parked.cards.find((entry) => entry.status === "pending");
    await send(host, "POST", `/api/v1/chat/interactions/${card!.id}/answer`, {
      value: "deny",
    });

    const deadline = Date.now() + 5_000;
    let results: string[] = [];
    let reply: { status: string; blocks: { text: string }[] } | undefined;
    for (;;) {
      results = await toolResults(host, groupId);
      const page = (await (
        await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
      ).json()) as {
        items: {
          id: string;
          role: string;
          status: string;
          blocks: { text: string }[];
        }[];
      };
      reply = page.items.find((item) => item.role === "assistant");
      if (reply?.status === "completed" || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // The command never ran, and the model was told why.
    expect(results.join("\n")).not.toContain("never-runs");
    expect(results.join("\n")).toContain("did not approve");
    // And the run finished rather than failing: the refusal is a tool result.
    expect(reply?.status).toBe("completed");
    expect(reply?.blocks[0]?.text).toBe("understood");
  });

  it("does not ask for a tool nobody listed", async () => {
    const host = await start(scriptingModels("echo unlisted"), []);
    const { agentId, groupId } = await conversation(host);
    const settled = await run(host, groupId, agentId);
    expect(settled.cards).toEqual([]);
    expect(settled.replyStatus).toBe("completed");
    expect((await toolResults(host, groupId)).join("\n")).toContain("unlisted");
  });
});
