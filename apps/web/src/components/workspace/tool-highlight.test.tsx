import type { ToolBlock } from "@/lib/run";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { cleanup, mount } from "@/test-render";
import { ToolDetailCard } from "./transcript/tool-detail";

afterEach(cleanup);

const card = (block: Partial<ToolBlock> & Pick<ToolBlock, "name">) => (
  <ToolDetailCard
    block={{
      type: "tool",
      id: "call-1",
      status: "completed",
      input: undefined,
      ...block,
    }}
    statusLabel="ok"
  />
);

const details = (root: ParentNode) => root.querySelector("details")!;
const code = (root: ParentNode, lang: "js" | "json") =>
  root.querySelector(`.code-view[data-lang="${lang}"]`);

describe("tool cards", () => {
  it("starts every card folded, a script and a running call too", async () => {
    const script = await mount(
      card({ name: "esmrun", input: { script: "1" } }),
    );
    expect(details(script.container).open).toBe(false);
    const keep = await mount(
      card({ name: "esmrunandkeep", input: { name: "f", script: "1" } }),
    );
    expect(details(keep.container).open).toBe(false);
    const running = await mount(
      card({ name: "esmrun", status: "running", input: { script: "1" } }),
    );
    expect(details(running.container).open).toBe(false);
    const other = await mount(card({ name: "read", input: { path: "a.ts" } }));
    expect(details(other.container).open).toBe(false);
  });

  it("stays as the reader left it while the call goes on and ends", async () => {
    const shown = (status: ToolBlock["status"]) =>
      card({ name: "esmrun", status, input: { script: "1" } });
    const { container, show } = await mount(shown("running"));
    details(container).open = true;
    await act(async () =>
      details(container).dispatchEvent(new Event("toggle")),
    );
    await show(shown("completed"));
    expect(details(container).open).toBe(true);
  });

  it("colours a streaming script in the same element, frame after frame", async () => {
    const running = (text: string) =>
      card({ name: "esmrun", status: "running", input: { script: text } });
    const { container, show } = await mount(running("const a"));
    const first = code(container, "js");
    expect(first).not.toBeNull();
    await show(running("const a = await $`ls`;\nconsole.log(a)"));
    const second = code(container, "js");
    expect(second).toBe(first);
    expect(second?.textContent).toBe("const a = await $`ls`;\nconsole.log(a)");
    expect(second?.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(second?.querySelector(".tok-string")).not.toBeNull();
  });

  it("does not fold a script while it streams", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line(${i});`).join("\n");
    const { container, show } = await mount(
      card({ name: "esmrun", status: "running", input: { script: long } }),
    );
    expect(container.querySelector(".folded")?.getAttribute("data-open")).toBe(
      "true",
    );
    expect(container.querySelector(".folded-toggle")).toBeNull();
    await show(
      card({ name: "esmrun", status: "completed", input: { script: long } }),
    );
    expect(container.querySelector(".folded")?.hasAttribute("data-open")).toBe(
      false,
    );
    expect(container.querySelector(".folded-toggle")).not.toBeNull();
  });

  it("stays folded once the reader folds it", async () => {
    const running = (text: string) =>
      card({ name: "esmrun", status: "running", input: { script: text } });
    const { container, show } = await mount(running("let x"));
    const el = details(container);
    await act(async () => {
      el.open = false;
      el.dispatchEvent(new Event("toggle"));
    });
    await show(running("let x = 1;"));
    await show(running("let x = 1;\nlet y = 2;"));
    expect(details(container).open).toBe(false);
  });

  it("puts esmrunandkeep's other arguments on one line above the script", async () => {
    const { container } = await mount(
      card({
        name: "esmrunandkeep",
        input: { name: "tool", desc: "does it", script: "export default 1" },
      }),
    );
    expect(container.querySelector(".tool-card-args-line")?.textContent).toBe(
      "name: tool · desc: does it",
    );
    expect(code(container, "js")?.textContent).toBe("export default 1");
  });

  it("colours arguments as JSON", async () => {
    const { container } = await mount(
      card({ name: "read", input: { path: "a.ts", limit: 3, all: true } }),
    );
    const json = code(container, "json");
    expect(json?.textContent).toBe(
      JSON.stringify({ path: "a.ts", limit: 3, all: true }, null, 2),
    );
    expect(json?.querySelector(".tok-property")?.textContent).toBe('"path"');
    expect(json?.querySelector(".tok-string")?.textContent).toBe('"a.ts"');
    expect(json?.querySelector(".tok-keyword")?.textContent).toBe("true");
  });

  it("colours a JSON result and leaves other text as printed", async () => {
    const json = await mount(card({ name: "read", output: '{"ok": true}' }));
    expect(
      code(json.container, "json")?.querySelector(".tok-property")?.textContent,
    ).toBe('"ok"');
    const plain = await mount(card({ name: "read", output: "hello world" }));
    expect(plain.container.querySelector(".code-view")).toBeNull();
    expect(plain.container.querySelector(".folded-body")?.textContent).toBe(
      "hello world",
    );
  });

  it("colours a script result's value and draws its sections quietly", async () => {
    const output =
      '{\n  "n": 2\n}\n\neffects:\nview a.ts (line 1)\n\nscript: /tmp/runs/0001.js';
    const { container } = await mount(card({ name: "esmrun", output }));
    const value = code(container, "json");
    expect(value?.textContent).toBe('{\n  "n": 2\n}');
    expect(value?.querySelector(".tok-class")?.textContent).toBe("2");
    const tail = container.querySelector(".tool-card-tail");
    expect(tail?.textContent).toBe(
      "\n\neffects:\nview a.ts (line 1)\n\nscript: /tmp/runs/0001.js",
    );
    expect(tail?.querySelector("span")).toBeNull();
    expect(container.querySelector(".folded-body")?.textContent).toBe(output);
  });

  it("keeps a script result that is not JSON as text, sections quiet", async () => {
    const output = "Error: boom\n\nscript: /tmp/runs/0002.js";
    const { container } = await mount(card({ name: "esmrun", output }));
    expect(container.querySelector(".code-view")).toBeNull();
    expect(container.querySelector(".tool-card-tail")?.textContent).toBe(
      "\n\nscript: /tmp/runs/0002.js",
    );
  });
});
