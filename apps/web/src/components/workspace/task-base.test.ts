import { describe, expect, it } from "@rstest/core";
import { baseArg, baseCandidates, derivedBase, shownBase } from "./task-base";
import { release } from "./task-tree-fixture";

// "Starts from" in the new-task form: what the host would derive, what the user may pick instead,
// and what `tasks.create` is sent.

const all = release();
const byNumber = (n: number) => all.find((t) => t.number === n)!;
const sameProject = () => "p1";

describe("where a new task starts", () => {
  it("offers the prerequisites with a branch of their own in the project", () => {
    const prerequisites = [4, 7, 8, 10].map(byNumber);
    // #4 has subtasks and #10 is cancelled: neither has a branch to go on from.
    expect(
      baseCandidates(prerequisites, all, "p1", sameProject).map(
        (t) => t.number,
      ),
    ).toEqual([7, 8]);
    // A task in the project's directory has no branch.
    expect(
      baseCandidates(
        [{ ...byNumber(8), workspaceMode: "local" }],
        all,
        "p1",
        sameProject,
      ),
    ).toEqual([]);
    // Another project's task is not offered.
    expect(
      baseCandidates([byNumber(8)], all, "p1", (t) =>
        t.number === 8 ? "p2" : "p1",
      ),
    ).toEqual([]);
  });

  it("derives the one unfinished prerequisite's branch, else HEAD", () => {
    const one = [byNumber(8)];
    expect(derivedBase(one, one)).toEqual({ kind: "task", task: byNumber(8) });
    // A done one is merged by then: HEAD.
    const done = [byNumber(5)];
    expect(derivedBase(done, done)).toEqual({ kind: "head" });
    // Two to wait for: HEAD, unless the user picks the one to go on from.
    const two = [byNumber(7), byNumber(8)];
    expect(derivedBase(two, two)).toEqual({ kind: "head" });
    expect(derivedBase([], [])).toEqual({ kind: "head" });
  });

  it("sends nothing when left alone, #N for a prerequisite, empty for HEAD, the field as typed", () => {
    const candidates = [byNumber(7), byNumber(8)];
    expect(baseArg({ kind: "auto" }, candidates)).toBeUndefined();
    expect(baseArg({ kind: "task", taskId: "t7" }, candidates)).toBe("#7");
    expect(baseArg({ kind: "head" }, candidates)).toBe("");
    expect(
      baseArg({ kind: "custom", value: " release/1.2 " }, candidates),
    ).toBe("release/1.2");
    expect(
      baseArg({ kind: "custom", value: "  " }, candidates),
    ).toBeUndefined();
    // A prerequisite dropped after it was picked: back to what the host derives.
    expect(shownBase({ kind: "task", taskId: "t8" }, [byNumber(7)])).toEqual({
      kind: "auto",
    });
    expect(
      baseArg({ kind: "task", taskId: "t8" }, [byNumber(7)]),
    ).toBeUndefined();
  });
});
