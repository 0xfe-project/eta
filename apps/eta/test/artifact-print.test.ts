/**
 * The listener the host appends to a previewed page (`src/artifacts/print.ts`): it prints on the
 * one message from the frame's parent and does nothing for anything else.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PRINT_LISTENER } from "../src/artifacts/print";

/** The listener run against a stand-in window: what it registered, and what it called. */
function framedPage(framed = true) {
  const listeners: ((event: { data: unknown; source: unknown }) => void)[] = [];
  const print = vi.fn();
  const postMessage = vi.fn();
  const self = { postMessage };
  const parent = framed ? { postMessage: vi.fn() } : self;
  const code = /^<script>(.*)<\/script>$/s.exec(PRINT_LISTENER)![1]!;
  runInNewContext(code, {
    addEventListener: (type: string, listener: (typeof listeners)[number]) => {
      expect(type).toBe("message");
      listeners.push(listener);
    },
    parent,
    window: self,
    print,
  });
  const send = (data: unknown, source: unknown = parent) => {
    for (const listener of listeners) listener({ data, source });
  };
  return { print, send, parent, self, postMessage, listeners };
}

describe("the print listener", () => {
  it("is one inline script", () => {
    expect(PRINT_LISTENER).toMatch(/^<script>[^<]*<\/script>$/);
  });

  it("prints when the parent asks, as many times as it asks", () => {
    const page = framedPage();
    expect(page.listeners).toHaveLength(1);
    page.send({ type: "eta:print" });
    expect(page.print).toHaveBeenCalledTimes(1);
    page.send({ type: "eta:print", extra: true });
    expect(page.print).toHaveBeenCalledTimes(2);
  });

  it("ignores any other message, and the same message from anyone but the parent", () => {
    const page = framedPage();
    for (const data of [
      null,
      undefined,
      "eta:print",
      { type: "eta:Print" },
      { type: "print" },
      ["eta:print"],
      { kind: "eta:print" },
      42,
    ])
      page.send(data);
    page.send({ type: "eta:print" }, page.self);
    page.send({ type: "eta:print" }, { postMessage: vi.fn() });
    page.send({ type: "eta:print" }, null);
    expect(page.print).not.toHaveBeenCalled();
    // It answers no one.
    expect(page.postMessage).not.toHaveBeenCalled();
    expect(
      (page.parent as { postMessage: ReturnType<typeof vi.fn> }).postMessage,
    ).not.toHaveBeenCalled();
  });

  it("does nothing in a page opened on its own", () => {
    const page = framedPage(false);
    page.send({ type: "eta:print" }, page.self);
    expect(page.print).not.toHaveBeenCalled();
  });
});
