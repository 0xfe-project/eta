/**
 * The seam between the harness's view and the wire's (S16).
 *
 * They are the same three fields — core, sections, revisions — and this file is where
 * that claim is checked rather than assumed. It is a compile-time assertion with a
 * runtime sanity check on top: if either side quietly grows a required field, this stops
 * building, which is cheaper than a client that receives frames it cannot read.
 */

import type { GoalState, StoredTask } from "@eta/client-contracts";
import type { StatePatch, StateSnapshot } from "@eta/client-wire-proto";
import type {
  GoalState as RuntimeGoal,
  StoredTask as RuntimeTask,
} from "@eta/core";
import { stateSection } from "@eta/client-contracts";
import { stateDiff } from "@eta/client-wire-proto";
import { MemoryStorage } from "@eta/core/storage";
import { fakeModels } from "@eta/core/testing";
import { openSession } from "@eta/harness";
import { describe, expect, it } from "vitest";

describe("the harness snapshot is what the wire says a view is", () => {
  it("assigns, reads by section name, and diffs", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
      sessionId: "eta-seam",
      cwd: "/work",
    });
    // No cast: the shapes have to line up on their own.
    const snapshot: StateSnapshot = session.view.snapshot();
    expect(stateSection(snapshot, "core")?.session).toBe("eta-seam");
    expect(stateSection(snapshot, "core")?.cwd).toBe("/work");
    expect(Object.keys(snapshot.revisions).length).toBeGreaterThan(0);

    // A client that holds nothing gets the whole state; one that is current gets nothing.
    expect(stateDiff(undefined, snapshot)).toBe("full");
    expect(
      stateDiff(snapshot.revisions, session.view.snapshot()),
    ).toBeUndefined();

    // Reading a section by name is typed and admits absence.
    expect(stateSection(snapshot, "transcript")?.messages).toEqual([]);
    expect(stateSection(snapshot, "goal")).toBeUndefined();

    // And a patch is what the pipe would send for a change.
    session.kernel.tasks.create("a task worth showing");
    const changed = session.view.snapshot();
    const patch = stateDiff(snapshot.revisions, changed);
    expect(patch).not.toBe("full");
    const typed = patch as StatePatch;
    expect(Object.keys(typed.sections)).toEqual(["tasks"]);
    const received: StateSnapshot = JSON.parse(JSON.stringify(changed));
    expect(stateSection(received, "tasks")?.[0]?.content).toBe(
      "a task worth showing",
    );
    expect(stateSection(received, "core")).toEqual(
      stateSection(changed, "core"),
    );

    await session.kernel.dispose();
    session.stop();
  });
});

// These DTOs must remain structurally compatible with their runtime producers,
// while the client builds with neither producer nor its dependencies installed.
const goalDto = (value: RuntimeGoal): GoalState => value;
const taskDto = (value: RuntimeTask): StoredTask => value;
void [goalDto, taskDto];
