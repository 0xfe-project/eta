import type { KernelTool, ToolMiddleware } from "@eta/core";
import type { AskObserver } from "@eta/harness";
import type { SessionMeta } from "@eta/server";
import { describe, expect, it } from "vitest";
import { combineSessionHooks } from "../src/session-hooks";

const meta = { id: "s1", createdAt: 0, cwd: "/tmp" } as SessionMeta;
const input = { meta, session: {} } as Parameters<
  ReturnType<typeof combineSessionHooks>["sessionTools"]
>[0];
const tool = (name: string) => ({ name }) as unknown as KernelTool;
const middleware = (name: string) => ({ name }) as ToolMiddleware;

describe("combineSessionHooks", () => {
  it("concatenates tools and middleware in list order", () => {
    const hooks = combineSessionHooks([
      {
        sessionTools: () => [tool("a")],
        toolMiddleware: () => [middleware("m1")],
      },
      {},
      { sessionTools: () => [tool("b"), tool("c")] },
      { toolMiddleware: () => [middleware("m2")] },
    ]);
    expect(hooks.sessionTools(input).map((t) => t.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(hooks.toolMiddleware(input).map((m) => m.name)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("tells every observer of a session, and nobody when none observes it", () => {
    const heard: string[] = [];
    const ear =
      (who: string): AskObserver =>
      (action) =>
        heard.push(`${who}:${action}`);
    const hooks = combineSessionHooks([
      { askObserve: () => ear("engine") },
      { askObserve: () => undefined },
      { askObserve: () => ear("inbox") },
    ]);
    hooks.askObserve(meta)?.("asked", {} as Parameters<AskObserver>[1]);
    expect(heard).toEqual(["engine:asked", "inbox:asked"]);
    expect(combineSessionHooks([{}]).askObserve(meta)).toBeUndefined();
  });
});
