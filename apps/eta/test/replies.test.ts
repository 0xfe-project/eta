/**
 * A reply's life, through a real socket: joining a turn that is running, waiting behind one,
 * being stopped, asking the user something, and what a restart does to the ones in flight.
 */
import type {
  MessageView,
  ToolActivity,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** One agent who is the project's steward, and a conversation she is in. */
async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

describe("a message that arrives while the agent is answering", () => {
  it("steer joins the turn in flight: no second reply, and the model hears it", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("now with your correction");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const sent = await w.send(group.id, "write the report");
    const reply = sent.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    const steered = await w.send(group.id, "make it shorter", {
      mode: "steer",
    });
    expect(steered).toMatchObject({
      replies: [],
      joined: [agent.id],
      nobody: false,
    });
    expect(steered.message.data).toMatchObject({
      joined: [agent.id],
      woke: [],
    });
    first.open();

    const done = await w.settled(group.id, reply.id);
    // One reply, and it is the answer to the whole exchange.
    expect(done.text).toBe("now with your correction");
    expect(
      w.rows(group.id).filter((row) => row.author === "agent"),
    ).toHaveLength(1);
    // The model's second request carried the steered words.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.transcript.join("\n")).toContain("make it shorter");
  });

  it("steer with nothing running is just a message", async () => {
    const { models } = scriptedModels(() => say("hello"));
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hi", { mode: "steer" });
    expect(sent.joined).toEqual([]);
    expect(sent.replies).toHaveLength(1);
    await w.settled(group.id, sent.replies[0]!.id);
  });

  it("queue gets a reply of its own, which waits for the one before it", async () => {
    const first = gate();
    const order: string[] = [];
    const { models, requests } = scriptedModels(async (request) => {
      order.push(request.last);
      if (request.index === 0) await first.opened;
      return say(`answer ${request.index + 1}`);
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "first question");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    const two = await w.send(group.id, "second question");
    expect(two.joined).toEqual([]);
    const queued = two.replies[0]!;
    expect(queued.status).toBe("queued");
    // It does not start while the session is busy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.row(group.id, queued.id)?.status).toBe("queued");
    expect(requests).toHaveLength(1);

    first.open();
    await w.settled(group.id, one.replies[0]!.id);
    const done = await w.settled(group.id, queued.id);
    expect(done.text).toBe("answer 2");
    expect(order[1]).toContain("second question");
  });
});

describe("where a reply's run starts", () => {
  it("is on the row from the moment it works, and the run's messages come after it", async () => {
    const opened = gate();
    const { models } = scriptedModels(async (request) => {
      if (request.index === 1) await opened.opened;
      return say(`answer ${request.index + 1}`);
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "first");
    await w.settled(group.id, one.replies[0]!.id);
    const session = w.client.section<{ sessionId: string | null }[]>(
      `conversations.${group.id}`,
      "members",
    )?.[0]?.sessionId;
    w.client.subscribe(`sessions.${session}`);
    const rows = () =>
      w.client.section<{ messages: ViewMessageRow[] }>(
        `sessions.${session}`,
        "transcript",
      )?.messages ?? [];
    await until(() => rows().length === 2);
    const last = rows().at(-1)!.seq;

    const two = await w.send(group.id, "second");
    const working = await w.settled(group.id, two.replies[0]!.id, ["working"]);
    expect(working.data.runFrom).toBe(last);

    await until(() => rows().length === 3);
    expect(rows().at(-1)!.message.role).toBe("user");
    expect(rows().at(-1)!.seq).toBeGreaterThan(last);
    opened.open();
    await w.settled(group.id, two.replies[0]!.id);
  });
});

describe("stopping", () => {
  it("a reply that is working says stopping, then stopped", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "think forever");
    const reply = sent.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    const { stopped } = (await w.client.call("conversations", "stop", {
      conversationId: group.id,
      messageId: reply.id,
    })) as { stopped: MessageView[] };
    expect(stopped.map((row) => row.status)).toEqual(["stopping"]);
    const ended = await w.settled(group.id, reply.id);
    expect(ended.status).toBe("stopped");
    // Stopping again is not a second change.
    const again = (await w.client.call("conversations", "stop", {
      conversationId: group.id,
      messageId: reply.id,
    })) as { stopped: MessageView[] };
    expect(again.stopped).toEqual([]);
    expect(w.row(group.id, reply.id)?.revision).toBe(ended.revision);
  });

  it("with no reply named, stops every one in flight, and the ones still waiting never start", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const w = await world({ models });
    const { group } = await ada(w);
    const one = await w.send(group.id, "one");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    // Behind the first on the same session.
    const two = await w.send(group.id, "two");
    expect(two.replies[0]!.status).toBe("queued");

    const { stopped } = (await w.client.call("conversations", "stop", {
      conversationId: group.id,
    })) as { stopped: MessageView[] };
    expect(stopped).toHaveLength(2);
    const waiting = await w.settled(group.id, two.replies[0]!.id);
    expect(waiting).toMatchObject({ status: "stopped", text: "" });
    await w.settled(group.id, one.replies[0]!.id);
    // The queued one was never given to the model.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toHaveLength(1);
  });

  it("can only stop a reply of that conversation", async () => {
    const { models } = scriptedModels(() => HANG);
    const w = await world({ models });
    const { agent, project, group } = await ada(w);
    const other = await w.group(project.id, [agent.id]);
    await w.watch(other.id);
    const sent = await w.send(group.id, "hi");
    await w.settled(group.id, sent.replies[0]!.id, ["working"]);
    const { stopped } = (await w.client.call("conversations", "stop", {
      conversationId: other.id,
      messageId: sent.replies[0]!.id,
    })) as { stopped: MessageView[] };
    expect(stopped).toEqual([]);
    expect(w.row(group.id, sent.replies[0]!.id)?.status).toBe("working");
    await w.client.call("conversations", "stop", { conversationId: group.id });
  });
});

describe("a question from the agent", () => {
  it("makes its reply wait for the user, and the answer sends it back to work", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say(`Chose: ${request.last}`)
        : call("ask_user", { question: "Which colour?" }, "q-1"),
    );
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    const reply = sent.replies[0]!;

    const waiting = await w.settled(group.id, reply.id, ["waiting_for_input"]);
    expect(waiting.revision).toBeGreaterThan(reply.revision);
    // The member and the agent say so too.
    await until(
      () =>
        w.client.section<{ status: string }[]>(
          `conversations.${group.id}`,
          "members",
        )?.[0]?.status === "waiting_for_input",
    );
    const sessionId = w.client.section<{ sessionId: string }[]>(
      `conversations.${group.id}`,
      "members",
    )![0]!.sessionId;

    // The question is the session's own: it is answered where every session's are.
    w.client.subscribe(`sessions.${sessionId}`);
    await until(
      () =>
        w.client.section<{ pending?: { questionId: string } }>(
          `sessions.${sessionId}`,
          "ask",
        )?.pending?.questionId === "q-1",
    );
    await w.client.call("sessions", "answer", {
      session: sessionId,
      questionId: "q-1",
      response: { kind: "selection", selections: ["blue"] },
    });

    const done = await w.settled(group.id, reply.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("blue");
    // Back to working in between, not skipped.
    const seen: string[] = [];
    for (const frame of w.client.frames) {
      if (
        frame.type !== "state" ||
        frame.target !== `conversations.${group.id}`
      )
        continue;
      const timeline = (frame.snapshot?.sections ?? frame.patch?.sections)
        ?.timeline as { messages: MessageView[] } | undefined;
      const status = timeline?.messages.find((m) => m.id === reply.id)?.status;
      if (status !== undefined && seen.at(-1) !== status) seen.push(status);
    }
    expect(seen).toEqual([
      "queued",
      "working",
      "waiting_for_input",
      "working",
      "done",
    ]);
  });

  it("can be stopped while it waits", async () => {
    const { models } = scriptedModels(() =>
      call("ask_user", { question: "Which colour?" }, "q-1"),
    );
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    await w.settled(group.id, sent.replies[0]!.id, ["waiting_for_input"]);
    await w.client.call("conversations", "stop", { conversationId: group.id });
    const ended = await w.settled(group.id, sent.replies[0]!.id);
    expect(ended.status).toBe("stopped");
  });
});

describe("a run that fails", () => {
  it("ends the reply as failed, and says why", async () => {
    const w = await world();
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hi");
    await w.settled(group.id, sent.replies[0]!.id);
    // A machine reached over SSH cannot host sessions yet (the kernel stays on the primary, the
    // tools go over SSH); this is what a project on one would look like.
    w.host.db.exec("UPDATE machine SET kind = 'ssh' WHERE kind = 'primary'");
    const next = await w.send(group.id, "again");
    const failed = await w.settled(group.id, next.replies[0]!.id);
    expect(failed).toMatchObject({
      status: "failed",
      data: { code: "unavailable" },
    });
    expect(failed.text).toMatch(/cannot run/);
  });

  it("is told so by the model layer itself", async () => {
    const { models } = scriptedModels(() => {
      throw new Error("the provider fell over");
    });
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "hi");
    const failed = await w.settled(group.id, sent.replies[0]!.id);
    expect(failed).toMatchObject({
      status: "failed",
      data: { code: "run_failed" },
    });
    // The model layer's own words, not a stock line.
    expect(failed.text).toMatch(/the provider fell over/);
  });
});

describe("a restart", () => {
  it("fails what a crashed process left in flight, with the reason", async () => {
    const dataDir = await tempDir();
    const { models } = scriptedModels(() => HANG);
    const first = await world({ dataDir, models });
    const { group } = await ada(first);
    const working = await first.send(group.id, "one");
    await first.settled(group.id, working.replies[0]!.id, ["working"]);
    // Two more are behind it on the same session.
    const second = await first.send(group.id, "two");
    const third = await first.send(group.id, "three");
    const ids = [working, second, third].map((sent) => sent.replies[0]!.id);
    // Every status a reply can be in flight in.
    first.host.db.exec(
      `UPDATE message SET status = 'waiting_for_input' WHERE id = '${ids[0]}';
       UPDATE message SET status = 'stopping' WHERE id = '${ids[1]}'`,
    );
    const states = ids.map(
      (id) =>
        first.host.db
          .query<{ status: string }, [string]>(
            "SELECT status FROM message WHERE id = ?",
          )
          .get(id)?.status,
    );
    expect(states).toEqual(["waiting_for_input", "stopping", "queued"]);

    // The process dies without closing anything: what the next one finds is a copy of the file.
    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);
    const restarted = await world({ dataDir: copy });
    await restarted.watch(group.id);

    const replies = ids.map((id) => restarted.row(group.id, id)!);
    expect(replies.map((row) => row.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(replies[0]!.text).toMatch(/restarted/);
    expect(replies.every((row) => row.data.code === "restart")).toBe(true);
    // Nobody is shown as working.
    expect(
      restarted.client.section<{ status: string }[]>("agents", "list")![0]!
        .status,
    ).toBe("idle");
    // And what was said before the crash is still said.
    expect(
      restarted.rows(group.id).filter((row) => row.author === "user"),
    ).toHaveLength(3);
  });

  it("fails them as it shuts down, too", async () => {
    const dataDir = await tempDir();
    const { models, requests } = scriptedModels(() => HANG);
    const first = await world({ dataDir, models });
    const { group } = await ada(first);
    const sent = await first.send(group.id, "hi");
    await first.settled(group.id, sent.replies[0]!.id, ["working"]);
    await until(() => requests.length === 1);
    const queued = await first.send(group.id, "behind it");
    await first.host.close();

    const second = await world({ dataDir });
    await second.watch(group.id);
    const replies = second
      .rows(group.id)
      .filter((row) => row.author === "agent");
    expect(replies.map((row) => row.id)).toEqual([
      sent.replies[0]!.id,
      queued.replies[0]!.id,
    ]);
    expect(replies.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(replies.every((row) => row.data.code === "restart")).toBe(true);
  });
});

describe("the tool calls of a reply", () => {
  it("stay on the row after it ends, shortened", async () => {
    const long = "x".repeat(5000);
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("done")
        : call("create_step", { content: long }, "call-one"),
    );
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "run it");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    const activity = done.data.activity as ToolActivity[];
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      id: "call-one",
      name: "create_step",
      status: "completed",
    });
    expect(
      (activity[0]!.input as { content: string }).content.length,
    ).toBeLessThan(500);
    expect(activity[0]!.output!.length).toBeLessThanOrEqual(2001);
  });

  it("are absent from a reply that made none", async () => {
    const { models } = scriptedModels(() => say("just words"));
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "talk");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.data).not.toHaveProperty("activity");
  });
});
