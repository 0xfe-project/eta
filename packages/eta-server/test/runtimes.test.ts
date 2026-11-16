/**
 * Several sets of runtimes as one (`composeRuntimes`): each answers for its own ids, and the
 * catalog is every set's, one after another.
 */
import type { AgentRuntimeInfo } from "@eta/client-contracts";
import type { SessionRuntime, SessionRuntimeInput } from "../src/index";
import { describe, expect, it } from "vitest";
import { composeRuntimes } from "../src/index";

const info = (id: string): AgentRuntimeInfo =>
  ({ id, label: id, status: "available", models: [] }) as AgentRuntimeInfo;

function part(ids: string[], list?: () => Promise<AgentRuntimeInfo[]>) {
  const opened: string[] = [];
  return {
    opened,
    open: (input: SessionRuntimeInput) => {
      if (!ids.includes(input.runtime)) return undefined;
      opened.push(input.runtime);
      return { dispose: async () => undefined } as unknown as SessionRuntime;
    },
    ...(list === undefined ? {} : { catalog: { list } }),
  };
}

const input = (runtime: string) => ({ runtime }) as SessionRuntimeInput;

describe("composeRuntimes", () => {
  it("asks each set in turn, and the first that answers takes the session", () => {
    const first = part(["claude", "both"]);
    const second = part(["acp.fake", "both"]);
    const runtimes = composeRuntimes([first, second]);
    expect(runtimes.open(input("claude"))).toBeDefined();
    expect(runtimes.open(input("acp.fake"))).toBeDefined();
    expect(runtimes.open(input("both"))).toBeDefined();
    expect(runtimes.open(input("nobody"))).toBeUndefined();
    expect(first.opened).toEqual(["claude", "both"]);
    expect(second.opened).toEqual(["acp.fake"]);
  });

  it("lists every set's runtimes in order, without the set whose listing failed", async () => {
    const asked: boolean[] = [];
    const runtimes = composeRuntimes([
      part([], async () => [info("claude"), info("codex")]),
      part([]),
      part([], async () => {
        throw new Error("down");
      }),
      {
        open: () => undefined,
        catalog: {
          list: async (fresh) => {
            asked.push(fresh === true);
            return [info("acp.fake")];
          },
        },
      },
    ]);
    expect((await runtimes.catalog.list()).map((entry) => entry.id)).toEqual([
      "claude",
      "codex",
      "acp.fake",
    ]);
    await runtimes.catalog.list(true);
    expect(asked).toEqual([false, true]);
  });
});
