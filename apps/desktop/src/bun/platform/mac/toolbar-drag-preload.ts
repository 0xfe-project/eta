export type ToolbarDragBounds = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

export function toolbarDragBounds(
  message: unknown,
  token: string,
  windowId: number,
): ToolbarDragBounds | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("token" in message) ||
    message.token !== token ||
    !("windowId" in message) ||
    message.windowId !== windowId ||
    !("etaToolbarDragBounds" in message) ||
    !Array.isArray(message.etaToolbarDragBounds) ||
    message.etaToolbarDragBounds.length !== 4
  )
    return undefined;
  const [x, y, width, height] = message.etaToolbarDragBounds;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width < 0 ||
    height < 0 ||
    x + width > 1 ||
    y + height > 1
  )
    return undefined;
  return [x, y, width, height];
}

// Transform animations change the hit region without notifying ResizeObserver.
export const TOOLBAR_DRAG_PRELOAD = String.raw`
  if (facts.platform === "darwin") {
    let host;
    let frame = 0;
    let previous = "";
    let stopped = false;
    const send = (rect) => {
      const signature = JSON.stringify(rect);
      if (signature === previous) return;
      window.__electrobunSendToHost({
        etaToolbarDragBounds: rect,
        token: facts.nativeToken,
        windowId: window.__electrobunWindowId,
      });
      previous = signature;
    };
    const sample = () => {
      frame = 0;
      if (stopped) return;
      if (!host?.isConnected) host = document.querySelector("[data-react-grab]");
      const toolbar = host?.shadowRoot?.querySelector("[data-react-grab-toolbar]");
      let rect = [0, 0, 0, 0];
      if (toolbar && window.innerWidth > 0 && window.innerHeight > 0) {
        const style = getComputedStyle(toolbar);
        if (style.display !== "none" && style.visibility !== "hidden" &&
            style.pointerEvents !== "none" && Number(style.opacity) > 0) {
          const bounds = toolbar.getBoundingClientRect();
          const x = Math.max(0, Math.min(window.innerWidth, bounds.left));
          const y = Math.max(0, Math.min(window.innerHeight, bounds.top));
          const right = Math.max(x, Math.min(window.innerWidth, bounds.right));
          const bottom = Math.max(y, Math.min(window.innerHeight, bounds.bottom));
          const left = x / window.innerWidth;
          const top = y / window.innerHeight;
          rect = [left, top, right / window.innerWidth - left,
            bottom / window.innerHeight - top];
        }
      }
      send(rect);
      if (host?.isConnected) frame = requestAnimationFrame(sample);
    };
    const schedule = () => {
      if (!stopped && !frame) frame = requestAnimationFrame(sample);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true });
    window.addEventListener("pagehide", () => {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
      send([0, 0, 0, 0]);
    });
    window.addEventListener("pageshow", () => {
      stopped = false;
      previous = "";
      observer.observe(document, { childList: true, subtree: true });
      schedule();
    });
    window.addEventListener("eta-toolbar-drag-refresh", () => {
      previous = "";
      schedule();
    });
    send([0, 0, 0, 0]);
    schedule();
  }
`;
