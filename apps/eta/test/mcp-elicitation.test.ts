/**
 * An MCP server asking the user something mid-call (`elicitation/create`), through a real socket
 * and a real stdio server: the request becomes the Inbox's question cards, and what the user does
 * with them goes back to the server as accept (with the values), decline or cancel. A tool that
 * asks nothing never shows a card.
 */
import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** The fake server's `ask` tool sends `elicitation/create` with the schema it is given. */
const FAKE_MCP = join(
  import.meta.dirname,
  "..",
  "..",
  "daemon",
  "test",
  "fixtures",
  "fake-mcp-stdio.ts",
);

/** A model that runs one script and repeats what came back. */
const scripting = (script: string) =>
  scriptedModels((request) =>
    request.lastRole === "toolResult"
      ? say(`The tool said: ${request.last}`)
      : call("esmrun", { script }, "call-1"),
  );

const asking = (schema?: unknown) =>
  scripting(
    `import fake from "mcp:fake";\nawait fake.ask(${JSON.stringify(schema === undefined ? {} : { schema })})`,
  );

async function setup(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  await writeFile(
    join(project.path, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { type: "stdio", command: process.execPath, args: [FAKE_MCP] },
      },
    }),
  );
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  w.client.subscribe("inbox");
  return { group };
}

const rows = (w: World): InteractionView[] =>
  w.client.section<InteractionView[]>("inbox", "list") ?? [];

/** The pending card, once there is one that has not been seen yet. */
async function nextCard(w: World, seen: Set<string>): Promise<InteractionView> {
  const fresh = () =>
    rows(w).find((row) => row.status === "pending" && !seen.has(row.id));
  await until(() => fresh() !== undefined);
  const card = fresh()!;
  seen.add(card.id);
  return card;
}

const answer = (w: World, card: InteractionView, response: InboxResponse) =>
  w.client.call("inbox", "answer", { id: card.id, response });

const pick = (option: string): InboxResponse => ({
  kind: "selection",
  selections: [option],
});

describe("an MCP tool that asks the user something", () => {
  it("shows the request as question cards, and accepting hands the values back", async () => {
    const { models } = asking();
    const w = await world({ models });
    const { group } = await setup(w);
    const seen = new Set<string>();

    const sent = await w.send(group.id, "ask me");
    const opening = await nextCard(w, seen);
    expect(opening).toMatchObject({
      prompt: "MCP server fake: name?\nAsks for: name",
      options: ["Continue", "Decline"],
      conversationId: group.id,
    });
    expect(opening.prompt.toLowerCase()).not.toContain("approve");
    await w.settled(group.id, sent.replies[0]!.id, ["waiting_for_input"]);
    await answer(w, opening, pick("Continue"));

    const field = await nextCard(w, seen);
    expect(field).toMatchObject({
      prompt: "name (optional: answer - to skip)",
      options: [],
    });
    // What the card's text box sends.
    await answer(w, field, pick("Ada"));

    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain('The tool said: elicit:accept:{"name":"Ada"}');
  });

  it("returns decline when the user declines", async () => {
    const { models } = asking();
    const w = await world({ models });
    const { group } = await setup(w);
    const sent = await w.send(group.id, "ask me");
    await answer(w, await nextCard(w, new Set()), pick("Decline"));
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("The tool said: elicit:decline:null");
  });

  it("returns cancel when the user gives up on a card", async () => {
    const { models } = asking();
    const w = await world({ models });
    const { group } = await setup(w);
    const seen = new Set<string>();
    const sent = await w.send(group.id, "ask me");
    await answer(w, await nextCard(w, seen), pick("Continue"));
    await answer(w, await nextCard(w, seen), { kind: "none" });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("The tool said: elicit:cancel:null");
  });

  it("asks for consent alone with Accept, and maps choices and yes/no to their values", async () => {
    const { models } = asking({
      type: "object",
      properties: {
        size: {
          type: "string",
          title: "Size",
          enum: ["s", "l"],
          enumNames: ["Small", "Large"],
        },
        gift: { type: "boolean", title: "Gift wrap" },
        count: { type: "integer", minimum: 1 },
      },
      required: ["size", "count"],
    });
    const w = await world({ models });
    const { group } = await setup(w);
    const seen = new Set<string>();
    const sent = await w.send(group.id, "ask me");

    const opening = await nextCard(w, seen);
    expect(opening.prompt).toBe(
      "MCP server fake: name?\nAsks for: Size, Gift wrap, count",
    );
    await answer(w, opening, pick("Continue"));
    const size = await nextCard(w, seen);
    expect(size).toMatchObject({ prompt: "Size", options: ["Small", "Large"] });
    await answer(w, size, pick("Large"));
    const gift = await nextCard(w, seen);
    expect(gift).toMatchObject({
      prompt: "Gift wrap (optional)",
      options: ["Yes", "No"],
    });
    await answer(w, gift, pick("No"));
    const count = await nextCard(w, seen);
    await answer(w, count, pick("lots"));
    // Not a number: the same field again, saying why.
    const again = await nextCard(w, seen);
    expect(again.prompt).toBe("count\nExpected a number.");
    await answer(w, again, pick("3"));

    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain(
      'The tool said: elicit:accept:{"size":"l","gift":false,"count":3}',
    );
  });

  it("asks for consent alone with Accept and Decline", async () => {
    const { models } = asking({ type: "object", properties: {} });
    const w = await world({ models });
    const { group } = await setup(w);
    const sent = await w.send(group.id, "ask me");
    const card = await nextCard(w, new Set());
    expect(card).toMatchObject({
      prompt: "MCP server fake: name?",
      options: ["Accept", "Decline"],
    });
    await answer(w, card, pick("Accept"));
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("The tool said: elicit:accept:{}");
  });
});

describe("an MCP tool that asks nothing", () => {
  it("runs without a card", async () => {
    const { models } = scripting(
      `import fake from "mcp:fake";\nawait fake.echo({ text: "hello" })`,
    );
    const w = await world({ models });
    const { group } = await setup(w);
    const sent = await w.send(group.id, "say hello");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("The tool said: hello");
    expect(rows(w)).toEqual([]);
  });
});
