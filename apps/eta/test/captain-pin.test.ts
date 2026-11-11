/**
 * Captain keeps its own tools and has the task board's and email's withheld. The withheld half is
 * a pin in the session's journal, though, and a pin outlives the build that wrote it: one data
 * directory opened by a build that does not know Captain gets those tools installed and pinned,
 * and the runner then fails every Captain run with `configured_tools_unavailable`. These are the
 * two halves of that: whose tools are withheld, and the pin being narrowed back on the way in.
 */
import type { OpenSession } from "@eta/harness";
import { describe, expect, it } from "vitest";
import {
  CAPTAIN_WITHHELD_TOOL_NAMES,
  repairCaptainToolPin,
} from "../src/captain/pin";
import { world } from "./support/world";

/** A session's journal pin, and what a repair did to it. */
function pinOf(names: readonly string[]) {
  let pinned = [...names];
  let writes = 0;
  const session = {
    kernel: {
      config: {
        read: () => pinned,
        update: (config: { activeToolNames?: string[] }) => {
          if (config.activeToolNames === undefined) return;
          pinned = [...config.activeToolNames];
          writes += 1;
        },
      },
    },
  } as unknown as Pick<OpenSession, "kernel">;
  return { session, pin: () => pinned, writes: () => writes };
}

describe("captain's tool pin", () => {
  it("takes the withheld tools off a pin and leaves the rest where they were", () => {
    const { session, pin } = pinOf([
      "esmrun",
      "control_task",
      ...CAPTAIN_WITHHELD_TOOL_NAMES,
      "mention",
      "web_search",
    ]);
    const dropped = repairCaptainToolPin(session);
    expect(dropped).toEqual([...CAPTAIN_WITHHELD_TOOL_NAMES]);
    expect(pin()).toEqual(["esmrun", "control_task", "mention", "web_search"]);
  });

  it("writes nothing to a pin that is already clean", () => {
    const { session, writes } = pinOf(["esmrun", "control_task", "mention"]);
    expect(repairCaptainToolPin(session)).toEqual([]);
    expect(writes()).toBe(0);
  });

  it("is every one of them a name an ordinary agent session really gets", async () => {
    const w = await world({ captain: true, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "Group");
    const { identity } = (await w.client.call("captain", "ensure", {})) as {
      identity: { agentId: string };
    };
    const direct = (await w.client.call("captain", "direct", {})) as {
      conversationId: string;
    };
    const toolsOf = (meta: {
      id: string;
      agentId: string;
      conversationId: string;
    }) =>
      w.host.product.sessionHooks
        .sessionTools({
          meta: { createdAt: 0, cwd: project.path, ...meta },
          session: undefined as never,
        })
        .map((tool) => tool.name);

    // The two features withhold exactly these, so an agent gets every one of them …
    const agentTools = toolsOf({
      id: "session-agent",
      agentId: ada.id,
      conversationId: group.id,
    });
    expect(agentTools).toEqual(
      expect.arrayContaining([...CAPTAIN_WITHHELD_TOOL_NAMES]),
    );

    // … and Captain, whose own tools are the ones it does the same work with, gets none.
    const captainTools = toolsOf({
      id: "session-captain",
      agentId: identity.agentId,
      conversationId: direct.conversationId,
    });
    for (const name of CAPTAIN_WITHHELD_TOOL_NAMES)
      expect(captainTools).not.toContain(name);
    expect(captainTools).toContain("captain_list_tasks");
    expect(captainTools).toContain("relay_inbox_to_user");
  });

  it("narrows a Captain session's pin on the way in, and only Captain's", async () => {
    const w = await world({ captain: true, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "Group");
    const { identity } = (await w.client.call("captain", "ensure", {})) as {
      identity: { agentId: string };
    };
    const direct = (await w.client.call("captain", "direct", {})) as {
      conversationId: string;
    };
    const attach = w.host.product.sessionHooks.sessionAttach;
    const stale = [...CAPTAIN_WITHHELD_TOOL_NAMES, "esmrun", "control_task"];

    const captain = pinOf(stale);
    await attach({
      meta: {
        id: "session-captain",
        createdAt: 0,
        cwd: project.path,
        agentId: identity.agentId,
        conversationId: direct.conversationId,
      },
      session: captain.session as never,
    });
    expect(captain.pin()).toEqual(["esmrun", "control_task"]);

    // An agent's own pin is not the Captain's to repair, even with the same names in it.
    const agent = pinOf(stale);
    await attach({
      meta: {
        id: "session-agent",
        createdAt: 0,
        cwd: project.path,
        agentId: ada.id,
        conversationId: group.id,
      },
      session: agent.session as never,
    });
    expect(agent.pin()).toEqual(stale);
  });
});
