import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";
import type { Host } from "../src/host";
/**
 * Two conversations at once (REFACTOR.md §9, P2.6).
 *
 * A session is one conversation — a private chat, or one member's side of a group — and it answers
 * one thing at a time. Everything else is independent, so a runner that chains *all* deliveries
 * into one queue makes an agent in three groups answer them one after another, which is not a
 * property of the conversations but of the queue.
 *
 * The check is concurrency itself: a model layer that holds every request until the test lets go,
 * and the highest number of requests it ever saw at once. One means serial, two means the two
 * conversations were both talking to the model at the same time.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
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

const CONFIG = {
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m1" }],
    },
  ],
  defaultModel: "local:m1",
};

/**
 * A model layer that answers the script, but only once the test opens the gate.
 *
 * `streamSimple` has to hand back pi-ai's stream synchronously, so the waiting happens inside it —
 * and while it waits, the request counts as in flight, which is exactly what is being measured.
 */
function gatedModels(answers: AssistantMessage[]): {
  models: KernelModels;
  release: () => void;
  started: () => number;
  maxConcurrent: () => number;
} {
  const scripted = fakeModels(answers);
  let inFlight = 0;
  let started = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    release: () => release(),
    started: () => started,
    maxConcurrent: () => peak,
    models: {
      getModel: (provider, id) => scripted.getModel(provider, id),
      streamSimple: (model, context, options) => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const out = createAssistantMessageEventStream();
        void (async () => {
          await gate;
          const inner = scripted.streamSimple(model, context, options);
          for await (const event of inner) out.push(event);
          inFlight -= 1;
          out.end(await inner.result());
        })();
        return out;
      },
      completeSimple: async (model, context, options) =>
        scripted.completeSimple(model, context, options),
    },
  };
}

async function start(models: KernelModels): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-concurrency-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models,
  });
  hosts.push(host);
  return host;
}

const call = async (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${host.port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

/** Poll until `done()`, or fail the test by running out of patience. */
async function until(done: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 5_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Is anything in this group still being answered? */
async function busy(host: Host, groupId: string): Promise<boolean> {
  const page = (await (
    await call(host, "GET", `/api/v1/groups/${groupId}/messages`)
  ).json()) as { items: { status: string }[] };
  return page.items.some((item) =>
    ["queued", "responding", "stopping"].includes(item.status),
  );
}

describe("two conversations at once", () => {
  it("runs one agent's two groups side by side, not one after the other", {
    timeout: 15_000,
  }, async () => {
    const gated = gatedModels([
      assistantMessage({ content: [{ type: "text", text: "第一个群" }] }),
      assistantMessage({ content: [{ type: "text", text: "第二个群" }] }),
    ]);
    const host = await start(gated.models);

    // One agent, two conversations — the case that showed up as "等待中" in the panel.
    const created = (await (
      await call(host, "POST", "/agents", { name: "talker" })
    ).json()) as { agent: { id: string } };
    const groups: string[] = [];
    for (const name of ["甲", "乙"]) {
      const made = (await (
        await call(host, "POST", "/groups", {
          name,
          agentIds: [created.agent.id],
        })
      ).json()) as { group: { id: string } };
      groups.push(made.group.id);
    }

    for (const [index, groupId] of groups.entries()) {
      await call(host, "POST", "/api/v1/chat/messages", {
        group_id: groupId,
        parts: [{ type: "text", text: `第 ${index + 1} 条` }],
        // Named, not implied: a multi-member group wakes only who it names, and this agent is
        // the group's only member, so naming it is also what the private-chat rule would do.
        mentions: [created.agent.id],
      });
    }

    // Both conversations have to reach the model without either one finishing first: the gate is
    // still shut at this point, so nothing can have completed.
    await until(() => gated.started() === 2, "both conversations to start");
    expect(gated.maxConcurrent()).toBe(2);

    gated.release();
    for (const groupId of groups) {
      await until(
        async () => !(await busy(host, groupId)),
        "the group to settle",
      );
    }
    // Both answers landed in their own conversation: nothing was answered twice, and nothing was
    // thrown away by sharing a queue.
    for (const [index, groupId] of groups.entries()) {
      const page = (await (
        await call(host, "GET", `/api/v1/groups/${groupId}/messages`)
      ).json()) as {
        items: {
          role: string;
          blocks: { type: string; text?: string }[];
        }[];
      };
      const said = page.items
        .filter((item) => item.role === "assistant")
        .flatMap((item) => item.blocks)
        .map((block) => block.text ?? "")
        .join("");
      expect(said).toContain(index === 0 ? "第一个群" : "第二个群");
    }
  });
});
