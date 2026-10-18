import type { MemoryView as Memory } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { surfaceHost } from "@/test-inbox";
import { agentView, conversationView } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { MemoryView } from "./memory-view";

const memories: Memory[] = Array.from({ length: 45 }, (_, i) => ({
  id: String(i),
  text: `记忆 ${i}`,
  score: null,
  createdAt: Date.now() - i * 1000,
  source: i < 22 ? "user" : "agent",
  conversationId: null,
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

interface ListArgs {
  agentId: string;
  query?: string;
  source?: string;
  conversationId?: string;
}

/** A host with a memory sidecar that filters the way the real one does. */
function memoryHost(rows: Memory[] = memories) {
  const host = surfaceHost({
    memory: true,
    agents: [agentView({ id: "a", name: "助手" })],
    conversations: [conversationView({ id: "g", name: "群聊" })],
  });
  host.handle("memory.list", (raw) => {
    const args = raw as ListArgs;
    return {
      memories: rows.filter(
        (row) =>
          (args.source === undefined || row.source === args.source) &&
          (args.conversationId === undefined ||
            row.conversationId === args.conversationId) &&
          (args.query === undefined || row.text.includes(args.query)),
      ),
    };
  });
  host.handle("memory.remember", (raw) => ({
    memory: { ...memories[0], id: "new", text: (raw as { text: string }).text },
  }));
  host.handle("memory.forget", (raw) => ({ id: (raw as { id: string }).id }));
  return host;
}

const lists = (host: ReturnType<typeof memoryHost>) =>
  host.calls.filter((call) => call.action === "list").map((call) => call.args);

async function choose(container: HTMLElement, label: string, option: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((el) => el.textContent === option)!;
  await act(async () => {
    found.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await flush(30);
}

describe("an agent's memories on the wire", () => {
  it("lists the agent's memories a page at a time", async () => {
    const host = memoryHost();
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    expect(lists(host)).toEqual([{ agentId: "a" }]);
    expect(container.querySelectorAll("li")).toHaveLength(20);
    expect(container.textContent).toContain("1 / 3");
    await click(container.querySelector('[aria-label="下一页"]'));
    expect(container.textContent).toContain("2 / 3");
  });

  it("filters by source on the host and starts again from the first page", async () => {
    const host = memoryHost();
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    await click(container.querySelector('[aria-label="下一页"]'));
    await choose(container, "记忆种类", "手动添加");
    expect(lists(host).at(-1)).toEqual({ agentId: "a", source: "user" });
    expect(container.textContent).toContain("1 / 2");
    expect(container.textContent).not.toContain("智能体记下");
  });

  it("filters by the conversation it was remembered in", async () => {
    const host = memoryHost([
      { ...memories[0]!, id: "x", text: "来自群里", conversationId: "g" },
      memories[1]!,
    ]);
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    expect(container.querySelector('a[href="/?group=g"]')?.textContent).toBe(
      "群聊",
    );
    await choose(container, "来源群", "群聊");
    expect(lists(host).at(-1)).toEqual({ agentId: "a", conversationId: "g" });
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("searches after the user stops typing", async () => {
    const host = memoryHost();
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="搜索记忆"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "记忆 4");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush(350);
    await flush(20);
    expect(lists(host).at(-1)).toEqual({ agentId: "a", query: "记忆 4" });
    expect(container.textContent).toContain("记忆 4");
    expect(container.textContent).not.toContain("记忆 3");
  });

  it("says when nothing matches", async () => {
    memoryHost([]);
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    expect(container.textContent).toContain("还没有记忆");
  });

  it("remembers what the user writes, and forgets", async () => {
    const host = memoryHost();
    const { container } = await mount(<MemoryView agentId="a" />);
    await flush(10);
    const text = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(text, "我习惯用 bun");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[type="submit"]'));
    await flush(10);
    await click(container.querySelector('[aria-label="忘记这条记忆"]'));
    await flush(10);
    expect(
      host.calls
        .filter((call) => call.action !== "list")
        .map((call) => [call.action, call.args]),
    ).toEqual([
      ["remember", { agentId: "a", text: "我习惯用 bun" }],
      ["forget", { agentId: "a", id: "0" }],
    ]);
    // Both changes refetch the list.
    expect(lists(host).length).toBeGreaterThanOrEqual(3);
  });
});
