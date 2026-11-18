import type { TaskStatus } from "@/queries/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "@/test-render";
import { StatusIcon, StatusPill } from "./task-status-icon";

// The seven marks: three rings for work not finished yet, four discs with a shape cut out of them
// for what wants the reader or is settled. Blocked is a disc with a bar, not a slashed ring.

async function mark(status: TaskStatus) {
  const { container } = await mount(<StatusIcon status={status} />);
  return container.querySelector<SVGSVGElement>(
    `svg[data-status="${status}"]`,
  )!;
}

describe("the status marks", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("draws backlog, to-do and in progress as rings: dashed, plain, half filled", async () => {
    const backlog = await mark("backlog");
    expect(backlog.querySelector("mask")).toBeNull();
    expect(
      backlog.querySelector("circle")!.getAttribute("stroke-dasharray"),
    ).not.toBeNull();
    const todo = await mark("todo");
    expect(
      todo.querySelector("circle")!.getAttribute("stroke-dasharray"),
    ).toBeNull();
    expect(todo.querySelector("path")).toBeNull();
    const progress = await mark("in_progress");
    expect(progress.querySelector("path")!.getAttribute("fill")).toBe(
      "currentColor",
    );
  });

  it("draws the other four as solid discs with their shape cut out", async () => {
    const cut = async (status: TaskStatus) => {
      const svg = await mark(status);
      // The disc, painted, with a mask that holds the cut-out.
      const disc = svg.querySelector("circle[mask]")!;
      expect(disc.getAttribute("fill")).toBe("currentColor");
      return svg.querySelector("mask g")!;
    };
    // An eye: its outline and its pupil.
    expect((await cut("in_review")).querySelector("path")).not.toBeNull();
    expect((await cut("in_review")).querySelector("circle")).not.toBeNull();
    // A tick: one stroked path.
    expect(
      (await cut("done")).querySelector("path")!.getAttribute("stroke"),
    ).toBe("black");
    // A bar across: a rectangle wider than it is tall.
    const bar = (await cut("blocked")).querySelector("rect")!;
    expect(Number(bar.getAttribute("width"))).toBeGreaterThan(
      Number(bar.getAttribute("height")),
    );
    // A cross: two strokes in one path.
    expect(
      (await cut("cancelled")).querySelector("path")!.getAttribute("d"),
    ).toMatch(/M.*M/);
  });

  it("colours the mark with the state colour and a label's words with its deeper ink", async () => {
    const { container } = await mount(<StatusPill status="in_review" />);
    const pill = container.querySelector<HTMLElement>(
      'span[data-status="in_review"]',
    )!;
    expect(pill.className).toContain("text-state-warning-ink");
    expect(pill.querySelector("svg")!.getAttribute("class")).toContain(
      "text-state-warning",
    );
    expect(pill.querySelector("svg")!.getAttribute("class")).not.toContain(
      "-ink",
    );
  });
});
