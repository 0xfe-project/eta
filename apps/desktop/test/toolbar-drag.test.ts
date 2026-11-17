import { describe, expect, it, vi } from "vitest";
import { toolbarDragBounds } from "../src/bun/platform/mac/toolbar-drag-preload";
import { pagePreload } from "../src/bun/preload";

const message = (bounds: unknown) => ({
  etaToolbarDragBounds: bounds,
  token: "window-token",
  windowId: 7,
});

describe("toolbar drag bounds ingress", () => {
  it("accepts normalized bounds and the clear signal", () => {
    expect(
      toolbarDragBounds(message([0.4, 0, 0.2, 0.04]), "window-token", 7),
    ).toEqual([0.4, 0, 0.2, 0.04]);
    expect(toolbarDragBounds(message([0, 0, 0, 0]), "window-token", 7)).toEqual(
      [0, 0, 0, 0],
    );
  });

  it("rejects another window or an unauthenticated sender", () => {
    const value = message([0.4, 0, 0.2, 0.04]);
    expect(toolbarDragBounds(value, "other-token", 7)).toBeUndefined();
    expect(toolbarDragBounds(value, "window-token", 8)).toBeUndefined();
  });

  it.each(
    [
      null,
      undefined,
      "rect",
      [],
      [0, 0, 0],
      [0, 0, 1, 1, 1],
      [NaN, 0, 0.1, 0.1],
      [0, Infinity, 0.1, 0.1],
      [0, 0, "1", 0.1],
      [-0.1, 0, 0.1, 0.1],
      [0, 0, -0.1, 0.1],
      [0.9, 0, 0.2, 0.1],
      [0, 0.9, 0.1, 0.2],
    ].map((bounds) => ({ bounds })),
  )("rejects malformed or out-of-viewport bounds $bounds", ({ bounds }) => {
    expect(
      toolbarDragBounds(message(bounds), "window-token", 7),
    ).toBeUndefined();
  });
});

function page({ platform = "darwin", top = true } = {}) {
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const send = vi.fn();
  const bounds = { left: 400, top: 0, right: 600, bottom: 40 };
  const style = {
    display: "block",
    visibility: "visible",
    pointerEvents: "auto",
    opacity: "1",
  };
  const host = {
    isConnected: true,
    shadowRoot: {
      querySelector: () => ({ getBoundingClientRect: () => bounds }),
    },
  };
  const window = Object.assign(new EventTarget(), {
    innerWidth: 1000,
    innerHeight: 1000,
    __electrobunWindowId: 7,
    __electrobunSendToHost: send,
  });
  Object.defineProperty(window, "top", { value: top ? window : {} });
  const source = pagePreload({
    facts: {
      platform,
      nativeApiBase: "http://127.0.0.1:9000",
      nativeToken: "window-token",
    },
    origin: "http://127.0.0.1:3000",
  });
  // eslint-disable-next-line no-new-func -- exercise the shipped preload and its browser lifecycle.
  new Function(
    "window",
    "location",
    "document",
    "MutationObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
    source,
  )(
    window,
    { origin: "http://127.0.0.1:3000", protocol: "http:" },
    { querySelector: () => (host.isConnected ? host : null) },
    class {
      observe() {}
      disconnect() {}
    },
    (callback: () => void) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    (id: number) => frames.delete(id),
    () => style,
  );
  return {
    window,
    send,
    frames,
    host,
    bounds,
    style,
    tick() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("toolbar drag geometry reporting", () => {
  it("leaves non-macOS pages and child frames alone", () => {
    expect(page({ platform: "win32" }).send).not.toHaveBeenCalled();
    expect(page({ top: false }).send).not.toHaveBeenCalled();
  });

  it("reports the actual rectangle without changing its docking position", () => {
    const observed = page();
    observed.window.dispatchEvent(new Event("pageshow"));
    observed.tick();
    expect(observed.send).toHaveBeenLastCalledWith(
      message([0.4, 0, 0.6 - 0.4, 0.04]),
    );
    observed.tick();
    expect(observed.frames.size).toBe(1);
    expect(observed.send).toHaveBeenCalledTimes(2);
    expect(observed.bounds.top).toBe(0);
  });

  it("tracks transformed geometry and clears hidden or removed toolbars", () => {
    const observed = page();
    observed.tick();
    observed.bounds.left = 500;
    observed.bounds.right = 700;
    observed.tick();
    expect(observed.send).toHaveBeenLastCalledWith(
      message([0.5, 0, 0.7 - 0.5, 0.04]),
    );
    observed.style.display = "none";
    observed.tick();
    expect(observed.send).toHaveBeenLastCalledWith(message([0, 0, 0, 0]));
    observed.host.isConnected = false;
    observed.tick();
    expect(observed.frames.size).toBe(0);
  });

  it("releases old page bounds and resumes one loop on history restoration", () => {
    const observed = page();
    observed.window.dispatchEvent(new Event("pageshow"));
    observed.tick();
    observed.window.dispatchEvent(new Event("pagehide"));
    expect(observed.frames.size).toBe(0);
    expect(observed.send).toHaveBeenLastCalledWith(message([0, 0, 0, 0]));
    observed.window.dispatchEvent(new Event("pageshow"));
    observed.tick();
    expect(observed.frames.size).toBe(1);
    expect(observed.send).toHaveBeenLastCalledWith(
      message([0.4, 0, 0.6 - 0.4, 0.04]),
    );
  });

  it("resends unchanged geometry after a committed document invalidates it", () => {
    const observed = page();
    observed.tick();
    observed.send.mockClear();
    observed.window.dispatchEvent(new Event("eta-toolbar-drag-refresh"));
    observed.tick();
    expect(observed.send).toHaveBeenCalledExactlyOnceWith(
      message([0.4, 0, 0.6 - 0.4, 0.04]),
    );
    expect(observed.frames.size).toBe(1);
  });
});
