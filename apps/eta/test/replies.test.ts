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
import { holdNextDelivery, uploadNote } from "./support/briefing";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** One agent who is the project's steward, and a conversation she is in. */
async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project();
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
    // Drawn in the message whose turn it joined, as an Insert from that message is.
    expect(steered.message.data).toMatchObject({
      joined: [agent.id],
      woke: [],
      into: sent.message.id,
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

  it("steer into a turn that ends while it is being briefed gets a reply of its own, answered once", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("the shorter one");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const sent = await w.send(group.id, "write the report");
    const reply = sent.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    // The steer is joinable when it is sent, and is held in its briefing (its file is being put
    // where the session can read it) while the turn ends.
    const hold = holdNextDelivery();
    const note = await uploadNote(w.client, group.id);
    const steering = w.send(group.id, "make it shorter", {
      mode: "steer",
      attachments: [note],
    });
    await hold.reached;
    first.open();
    expect((await w.settled(group.id, reply.id)).text).toBe("on it");
    hold.release();
    const steered = await steering;

    // Not joined: answered as a reply of its own, which is written back.
    expect(steered.joined).toEqual([]);
    expect(steered.replies).toHaveLength(1);
    expect(steered.message.data).toMatchObject({
      joined: [],
      woke: [agent.id],
    });
    const own = await w.settled(group.id, steered.replies[0]!.id);
    expect(own).toMatchObject({ status: "done", text: "the shorter one" });
    // Sent once: one request carried the words, and it is the one this reply answers.
    expect(requests).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.transcript.join("\n").includes("make it shorter"),
      ),
    ).toHaveLength(1);
  });

  it("put into a message, it joins every agent answering that message and is marked as part of it", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index < 2) {
        await first.opened;
        return say(`on it ${request.index}`);
      }
      return say("with your addition");
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const cy = await w.agent("Cy");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id, cy.id]);
    await w.watch(group.id);

    const asked = await w.send(group.id, "compare the two", {
      mentions: [ada.id, bob.id],
    });
    expect(asked.replies).toHaveLength(2);
    for (const reply of asked.replies)
      await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 2);

    // What the client names and asks for does not matter: the message's own answerers get it.
    const inserted = await w.send(group.id, "and the price", {
      into: asked.message.id,
      mentions: [cy.id],
    });
    expect(inserted.replies).toEqual([]);
    expect([...inserted.joined].sort()).toEqual([ada.id, bob.id].sort());
    expect(inserted.message.data).toMatchObject({ into: asked.message.id });
    first.open();
    for (const reply of asked.replies) await w.settled(group.id, reply.id);
    expect(
      requests.filter((request) =>
        request.transcript.join("\n").includes("and the price"),
      ),
    ).toHaveLength(2);
    // Cy was not answering, and was not woken.
    expect(
      w.rows(group.id).filter((row) => row.agentId === cy.id),
    ).toHaveLength(0);
  });

  it("put into a message nobody is answering any more, it is a message of its own", async () => {
    const { models } = scriptedModels(() => say("hello"));
    const w = await world({ models });
    const { agent, group } = await ada(w);
    const asked = await w.send(group.id, "hi");
    await w.settled(group.id, asked.replies[0]!.id);

    const late = await w.send(group.id, "one more thing", {
      into: asked.message.id,
      mentions: [agent.id],
      mode: "steer",
    });
    expect(late.joined).toEqual([]);
    expect(late.replies).toHaveLength(1);
    expect(late.message.data).not.toHaveProperty("into");
    await w.settled(group.id, late.replies[0]!.id);
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

  it("put into the root prompt during an @mention chain joins the mentioned agent answering it", async () => {
    const bobGate = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.agent === "Ada") {
        return request.lastRole === "toolResult"
          ? say("Asked Bob.")
          : call("mention", { agents: ["Bob"], message: "check tests" });
      }
      if (!request.transcript.join("\n").includes("also check Safari")) {
        await bobGate.opened;
        return say("Bob checked.");
      }
      return say("Bob checked Safari too.");
    });
    const w = await world({ models });
    const adaAgent = await w.agent("Ada");
    const bobAgent = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [adaAgent.id, bobAgent.id]);
    await w.watch(group.id);

    const asked = await w.send(group.id, "please review");
    await w.settled(group.id, asked.replies[0]!.id);
    await until(() =>
      w
        .rows(group.id)
        .some(
          (row) =>
            row.author === "agent" &&
            row.agentId === bobAgent.id &&
            row.status === "working",
        ),
    );
    const bobReply = w
      .rows(group.id)
      .find((row) => row.author === "agent" && row.agentId === bobAgent.id)!;
    await until(() => requests.some((request) => request.agent === "Bob"));

    const inserted = await w.send(group.id, "also check Safari", {
      into: asked.message.id,
      mode: "steer",
    });
    expect(inserted.joined).toEqual([bobAgent.id]);
    expect(inserted.replies).toEqual([]);
    expect(inserted.message.data).toMatchObject({ into: asked.message.id });

    bobGate.open();
    const done = await w.settled(group.id, bobReply.id);
    expect(done.text).toBe("Bob checked Safari too.");
  });

  it("put into an active reply directly joins that reply and anchors data.into to it", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("adjusted reply");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const asked = await w.send(group.id, "start task");
    const reply = asked.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    const inserted = await w.send(group.id, "focus on edge cases", {
      into: reply.id,
      mode: "steer",
    });
    expect(inserted.joined).toEqual([agent.id]);
    expect(inserted.replies).toEqual([]);
    expect(inserted.message.data).toMatchObject({ into: reply.id });

    first.open();
    const done = await w.settled(group.id, reply.id);
    expect(done.text).toBe("adjusted reply");
  });

  it("rejects into for held rows and rows from another conversation", async () => {
    const first = gate();
    const { models } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("done");
    });
    const w = await world({ models });
    const { project, agent, group } = await ada(w);
    const other = await w.group(project.id, [agent.id]);
    await w.watch(other.id);

    const one = await w.send(group.id, "first");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    const held = await w.send(group.id, "queued");
    await until(() => w.held(group.id).length === 1);

    await expect(
      w.send(group.id, "into held", { into: held.message.id, mode: "steer" }),
    ).rejects.toThrow(/in this conversation/);
    await expect(
      w.send(other.id, "cross chat", { into: one.message.id, mode: "steer" }),
    ).rejects.toThrow(/in this conversation/);

    first.open();
    await w.settled(group.id, one.replies[0]!.id);
    await w.settled(group.id, held.replies[0]!.id);
  });

  it("plain steer into a reply whose trigger is non-visible anchors data.into on the reply row", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("steered ok");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const hiddenTrigger = await w.host.product.engine.send({
      conversationId: group.id,
      text: "The user confirmed the task draft.",
      author: "system",
      data: { event: "task_draft_decided" },
      mentions: [agent.id],
      mode: "queue",
    });
    const reply = hiddenTrigger.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);

    const steered = await w.send(group.id, "keep it brief", { mode: "steer" });
    expect(steered.joined).toEqual([agent.id]);
    expect(steered.replies).toEqual([]);
    expect(steered.message.data).toMatchObject({ into: reply.id });

    first.open();
    const done = await w.settled(group.id, reply.id);
    expect(done.text).toBe("steered ok");
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
  it("ends what a crashed process left in flight, with the reason", async () => {
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
    // The one being stopped was stopped, as the user asked; the others failed.
    expect(replies.map((row) => row.status)).toEqual([
      "failed",
      "stopped",
      "failed",
    ]);
    expect(replies[0]!.text).toMatch(/restarted/);
    expect(replies[1]!.data.stopNote).toMatch(/restarted/);
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
