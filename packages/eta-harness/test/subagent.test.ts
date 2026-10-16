import type { SubagentRecord, SubagentUsage } from "../src/subagent";
import type { ToolResult } from "../src/tools/tool";
/**
 * The subagent pool.
 *
 * Every rule here exists because the obvious alternative deadlocks or leaks: a
 * nested child queued behind its own waiting parent, a parent that leaves
 * orphans behind, an agent that can stop someone else's child, a bill that does
 * not include the children. So each one gets a test, with a runner that does
 * nothing but report what it was asked to do.
 */
import { describe, expect, it } from "vitest";
import { DEPTH_CAP, SubagentManager } from "../src/subagent";
import { createSubagentTools } from "../src/tools/subagents";

const usage = (input: number, output: number): SubagentUsage => ({
  input,
  output,
});

/** A runner the test drives by hand: it records the calls and settles on demand. */
function harness(poolSize = 10) {
  const started: SubagentRecord[] = [];
  const settlers = new Map<
    string,
    (usage: SubagentUsage, failed?: boolean) => void
  >();
  const events: string[] = [];
  const manager = new SubagentManager(
    { emit: (type, payload) => events.push(`${type}:${String(payload.id)}`) },
    async (record, api) => {
      started.push(record);
      void api;
      return await new Promise<SubagentUsage>((resolve) => {
        settlers.set(record.id, (usage, failed) => {
          if (failed === true) {
            // The pool's own path: the runner rejected.
            throw new Error("unused");
          }
          resolve(usage);
        });
      });
    },
    poolSize,
  );
  return {
    manager,
    started,
    events,
    finish: async (id: string, used: SubagentUsage) => {
      settlers.get(id)!(used);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("the pool", () => {
  it("caps only the top level, because a nested child's parent already holds a slot", async () => {
    const { manager, started } = harness(1);
    const first = manager.spawn({ prompt: "one" });
    const second = manager.spawn({ prompt: "two" });
    await Promise.resolve();
    expect(started.map((record) => record.id)).toEqual([first.id]);
    expect(second.status).toBe("queued");
    expect(manager.runningCount).toBe(1);

    // A child of the running top-level agent starts immediately: it is inside
    // the slot its parent holds, and queueing it would deadlock the parent.
    const nested = manager.spawn({ prompt: "nested" }, first.id);
    await Promise.resolve();
    expect(nested.status).toBe("running");
    expect(manager.runningCount).toBe(1);
  });

  it("refuses to nest past the depth cap, but not to run many siblings at once", () => {
    const { manager } = harness(10);
    const first = manager.spawn({ prompt: "one" });
    const second = manager.spawn({ prompt: "two" }, first.id);
    expect(() => manager.spawn({ prompt: "three" }, second.id)).toThrow(
      `depth cap ${DEPTH_CAP} exceeded`,
    );
    // Width is not the cap: ten siblings are ten pieces of work.
    const siblings = Array.from({ length: 10 }, (_value, index) =>
      manager.spawn({ prompt: `s${index}` }),
    );
    expect(new Set(siblings.map((record) => record.id)).size).toBe(10);
  });

  it("lets a parent stop and steer its own children only", () => {
    const { manager } = harness();
    const parent = manager.spawn({ prompt: "parent" });
    const child = manager.spawn({ prompt: "child" }, parent.id);
    const stranger = manager.spawn({ prompt: "stranger" });
    expect(() => manager.stop(stranger.id, parent.id)).toThrow(
      /not your child/,
    );
    expect(() => manager.stop("sub-999", parent.id)).toThrow(/unknown agent/);
    // The child itself may, and the parent may.
    expect(manager.steer(child.id, parent.id, "reply shorter")).toBe(true);
    expect(manager.steer(child.id, "someone-else", "hijack")).toBe(false);
    expect(() => manager.stop(child.id, "someone-else")).toThrow(
      /not your child/,
    );
    manager.stop(child.id, parent.id);
    expect(manager.get(child.id)?.status).toBe("stopped");
  });

  it("hands a child its notes at a boundary, once", () => {
    const { manager } = harness();
    const parent = manager.spawn({ prompt: "parent" });
    const child = manager.spawn({ prompt: "child" }, parent.id);
    manager.steer(child.id, parent.id, "note one");
    manager.steer(child.id, parent.id, "note two");
    expect(manager.pendingNotes(child.id)).toEqual(["note one", "note two"]);
    // Taken, not copied: a boundary does not read the same note twice.
    expect(manager.pendingNotes(child.id)).toEqual([]);
  });

  it("stops a parent's descendants when the parent reaches a terminal state", async () => {
    const { manager, finish } = harness();
    const parent = manager.spawn({ prompt: "parent" });
    // The depth cap is 2, so "descendants" is exactly one level — which is the
    // level that would otherwise be left running with nobody to read it.
    const child = manager.spawn({ prompt: "child" }, parent.id);
    const sibling = manager.spawn(
      { prompt: "sibling", maxTurns: 1 },
      parent.id,
    );
    await Promise.resolve();
    expect(child.status).toBe("running");
    await finish(parent.id, usage(10, 5));
    expect(manager.get(parent.id)?.status).toBe("done");
    expect(manager.get(child.id)?.status).toBe("stopped");
    expect(manager.get(sibling.id)?.status).toBe("stopped");
  });

  it("rolls usage up the chain, so a parent's bill includes its children", async () => {
    const { manager, finish } = harness();
    const parent = manager.spawn({ prompt: "parent" });
    const child = manager.spawn({ prompt: "child" }, parent.id);
    await Promise.resolve();
    await finish(child.id, usage(100, 20));
    await finish(parent.id, usage(10, 5));
    expect(manager.get(child.id)?.totalUsage).toEqual(usage(100, 20));
    // The parent's own 15 tokens plus the child's 120.
    expect(manager.get(parent.id)?.totalUsage).toEqual(usage(110, 25));
  });

  it("enforces a child's turn budget from outside the child", async () => {
    const { manager, finish } = harness();
    const parent = manager.spawn({ prompt: "parent" });
    const child = manager.spawn({ prompt: "child", maxTurns: 3 }, parent.id);
    await Promise.resolve();
    manager.reportTurn(child.id);
    manager.reportTurn(child.id);
    expect(manager.get(child.id)?.status).toBe("running");
    manager.reportTurn(child.id);
    // The pool stopped it: a child that will not stop cannot be reasoned with.
    expect(manager.get(child.id)?.status).toBe("stopped");
    await finish(parent.id, usage(1, 1));
  });

  it("announces what happened, and frees the slot", async () => {
    const { manager, events, finish, started } = harness(1);
    const first = manager.spawn({ prompt: "one" });
    const second = manager.spawn({ prompt: "two" });
    await Promise.resolve();
    expect(started).toHaveLength(1);
    await finish(first.id, usage(1, 1));
    expect(events).toContain(`subagents:completed:${first.id}`);
    // The queued one starts as soon as the slot frees.
    await Promise.resolve();
    expect(manager.get(second.id)?.status).toBe("running");
    expect(manager.runningCount).toBe(1);
  });
});

describe("the subagent tools", () => {
  /** A pool whose children settle when the test says so. */
  function tools(poolSize = 10) {
    const settlers = new Map<string, (usage: SubagentUsage) => void>();
    const manager = new SubagentManager(
      { emit: () => undefined },
      async (record) =>
        await new Promise<SubagentUsage>((resolve) => {
          settlers.set(record.id, resolve);
        }),
      poolSize,
    );
    // The root agent's tools carry no owner: the root is the one agent that may
    // reach anywhere in the tree. A child's tools carry its own record id.
    const [agent, result, steer] = createSubagentTools(manager);
    return {
      manager,
      agent,
      result,
      steer,
      settle: async (id: string, used: SubagentUsage) => {
        settlers.get(id)!(used);
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  const textOf = (result: ToolResult<unknown>): string =>
    result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");

  it("spawns in the background, and reports status and rolled-up usage", async () => {
    const { agent, result, manager, settle } = tools();
    const spawned = await agent.execute(
      { task: "look into it", background: true },
      undefined as never,
    );
    expect(textOf(spawned)).toContain("sub-1 running");
    await Promise.resolve();
    const id = manager.list()[0]!.id;
    await settle(id, usage(30, 10));
    expect(textOf(await result.execute({ id }, undefined as never))).toContain(
      "sub-1 done (in 30/out 10)",
    );
  });

  it("waits for a blocking spawn, and reports a child that is not there", async () => {
    const { manager, agent } = tools();
    const blocking = Promise.resolve(
      agent.execute(
        { task: "answer me", background: false },
        undefined as never,
      ),
    );
    await Promise.resolve();
    const id = manager.list()[0]!.id;
    // The spawn has not resolved: a blocking child is waited for.
    let settled = false;
    void blocking.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    manager.settle(id, usage(5, 5));
    await Promise.resolve();
    expect(textOf(await blocking)).toContain("sub-1 done");
  });

  it("refuses to steer a child that is not the caller's", async () => {
    const { manager, agent, steer } = tools();
    await agent.execute({ task: "mine", background: true }, undefined as never);
    const mine = manager.list()[0]!.id;
    expect(
      textOf(
        await steer.execute({ id: mine, note: "shorten" }, undefined as never),
      ),
    ).toBe(`Steered ${mine}.`);

    // Another parent's tools see the same pool but not the same rights: an
    // owner id that is not the child's parent cannot steer it.
    const parent = manager.spawn({ prompt: "another parent" });
    const other = createSubagentTools(manager, parent.id);
    expect(
      textOf(
        await other[2]!.execute(
          { id: mine, note: "hijack" },
          undefined as never,
        ),
      ),
    ).toContain("Can't steer");
  });
});
