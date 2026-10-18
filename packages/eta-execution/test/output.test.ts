import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellOutputUpdate, ShellOutputView } from "@eta/execution";
import {
  AdaptivePublisher,
  applyShellOutputUpdate,
  LiveOutput,
  OutputBuffer,
  utf8ByteLength,
} from "@eta/execution/output";

afterEach(() => vi.useRealTimers());

describe("portable output", () => {
  it("counts UTF-8 including unpaired surrogates without runtime globals", () => {
    for (const text of ["ascii", "你好🙂", "\ud800x\udfff", "\ud800\udfff"]) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("decodes split UTF-8 chunks and preserves spill content exactly once", () => {
    const buffer = new OutputBuffer({ maxBytes: 8, maxLines: 2 });
    const bytes = new TextEncoder().encode("old\n你好\n🙂");
    for (const byte of bytes) buffer.push(new Uint8Array([byte]));
    buffer.finish();
    expect(buffer.snapshot().text).toBe("🙂");
    expect(buffer.snapshot().truncation).toMatchObject({
      truncated: true,
      totalBytes: bytes.length,
      totalLines: 3,
    });
    expect(buffer.takeRaw()).toBe("old\n你好\n🙂");
    buffer.push("!");
    expect(buffer.takeRaw()).toBe("");
    buffer.dispose();
  });

  it("reconstructs head and tail live windows including spill metadata", () => {
    for (const retain of ["head", "tail"] as const) {
      const updates: ShellOutputUpdate[] = [];
      const buffer = new OutputBuffer({ maxBytes: 16, maxLines: 2, retain });
      const live = new LiveOutput({
        buffer,
        onUpdate: (u) => updates.push(u),
        onError: (e) => {
          throw e;
        },
      });
      for (const chunk of ["a\n", "b\n", "c\n", "你好\n", "end\u0000\n"]) {
        live.push(chunk);
        live.flush();
      }
      live.setSpillPath("/spill/output.log");
      live.finish();
      let view: ShellOutputView | undefined;
      for (const update of updates) view = applyShellOutputUpdate(view, update);
      expect(view).toEqual(live.view());
      expect(view?.spillPath).toBe("/spill/output.log");
      expect(view?.text).not.toContain("\u0000");
      expect(view?.truncation.truncated).toBe(true);
      live.dispose();
      buffer.dispose();
    }
  });

  it("coalesces publications and cancels a pending trailing update on disposal", () => {
    vi.useFakeTimers();
    let value = 0;
    const publish = vi.fn();
    const publisher = new AdaptivePublisher({
      snapshot: () => value,
      update: (_old, next) => next,
      measure: () => 1,
      publish,
      onError: (e) => {
        throw e;
      },
      minIntervalMs: 100,
    });
    publisher.markDirty();
    value = 1;
    publisher.markDirty();
    value = 2;
    publisher.markDirty();
    expect(publish.mock.calls).toEqual([[0]]);
    vi.advanceTimersByTime(100);
    expect(publish.mock.calls).toEqual([[0], [2]]);
    value = 3;
    publisher.markDirty();
    publisher.dispose();
    vi.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
