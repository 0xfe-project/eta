/**
 * `show_widget`: a spec that draws lands in `details` whole; one that does not is sent back to the
 * model with what to fix.
 */
import type { KernelTool } from "@eta/core";
import { describe, expect, it } from "vitest";
import { widgetSessionTools } from "../src/widget/tools";

const [tool] = widgetSessionTools()({ meta: {} } as never) as KernelTool[];

async function show(spec: string) {
  return (await tool!.execute(
    { title: "Build", spec },
    { turn: 1, toolCallId: "t1" },
  )) as {
    content: { text: string }[];
    details?: unknown;
    isError?: boolean;
  };
}

const lines = (...ops: object[]) =>
  ops.map((op) => JSON.stringify(op)).join("\n");

describe("show_widget", () => {
  it("keeps the compiled spec in details", async () => {
    const result = await show(
      lines(
        { op: "add", path: "/root", value: "main" },
        {
          op: "add",
          path: "/elements/main",
          value: { type: "Card", props: { title: "CI" }, children: ["rate"] },
        },
        {
          op: "add",
          path: "/elements/rate",
          value: {
            type: "Metric",
            props: { label: "Pass rate", value: "98%" },
            children: [],
          },
        },
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      title: "Build",
      spec: {
        root: "main",
        elements: {
          main: { type: "Card", props: { title: "CI" }, children: ["rate"] },
          rate: {
            type: "Metric",
            props: { label: "Pass rate", value: "98%" },
            children: [],
          },
        },
      },
    });
  });

  it("names what to fix: an unknown component, a wrong prop, a missing child", async () => {
    const result = await show(
      lines(
        { op: "add", path: "/root", value: "main" },
        {
          op: "add",
          path: "/elements/main",
          value: { type: "Card", props: {}, children: ["rate", "gone"] },
        },
        {
          op: "add",
          path: "/elements/rate",
          value: { type: "Metric", props: { label: 1 }, children: [] },
        },
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('child "gone" is not an element');
    expect(result.content[0]!.text).toContain("elements/rate/props/label");

    const unknown = await show(
      lines(
        { op: "add", path: "/root", value: "main" },
        {
          op: "add",
          path: "/elements/main",
          value: { type: "Iframe", props: {}, children: [] },
        },
      ),
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("elements/main/type");
  });

  it("describes the components it can draw", () => {
    expect(tool!.description).toContain("- BarChart:");
    expect(tool!.description).not.toContain("$bindState");
  });
});
