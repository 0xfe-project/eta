/**
 * Generative UI on the host: `visualize_read_me` returns the core guidelines and the modules asked
 * for; `show_widget` keeps the code in `details` whole, and sends back what stops it drawing.
 */
import type { KernelTool } from "@eta/core";
import { describe, expect, it } from "vitest";
import { widgetSessionTools } from "../src/widget/tools";

const tools = new Map(
  (widgetSessionTools()({ meta: {} } as never) as KernelTool[]).map((tool) => [
    tool.name,
    tool,
  ]),
);

async function call(name: string, args: unknown) {
  return (await tools.get(name)!.execute(args, {
    turn: 1,
    toolCallId: "t1",
  })) as {
    content: { text: string }[];
    details?: unknown;
    isError?: boolean;
  };
}

describe("visualize_read_me", () => {
  it("returns the core and only the modules asked for", async () => {
    const { content } = await call("visualize_read_me", {
      modules: ["chart", "chart"],
    });
    const guide = content[0]!.text;
    expect(guide).toContain("# Widgets");
    expect(guide).toContain("--color-series-1");
    expect(guide.match(/## Charts \(Chart\.js\)/g)).toHaveLength(1);
    expect(guide).not.toContain("## Diagrams (SVG)");
  });
});

describe("show_widget", () => {
  it("keeps the code in details, whole", async () => {
    const code = `<style>.k{font-size:20px}</style><div class="k">${"9".repeat(5000)}</div>`;
    const result = await call("show_widget", {
      i_have_seen_read_me: true,
      title: "Build",
      widget_code: code,
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ title: "Build", widget_code: code });
  });

  it("asks for the guidelines first, and refuses a widget that is too big", async () => {
    const unread = await call("show_widget", {
      i_have_seen_read_me: false,
      title: "Build",
      widget_code: "<div></div>",
    });
    expect(unread.isError).toBe(true);
    expect(unread.content[0]!.text).toContain("visualize_read_me");

    const big = await call("show_widget", {
      i_have_seen_read_me: true,
      title: "Build",
      widget_code: "x".repeat(60_001),
    });
    expect(big.isError).toBe(true);
    expect(big.details).toBeUndefined();
  });
});
