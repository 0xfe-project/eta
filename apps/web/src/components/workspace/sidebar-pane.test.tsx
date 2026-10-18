import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SidebarPane } from "./sidebar-pane";

rstest.mock("./app-shell", () => ({
  Sidebar: ({ width }: { width?: number }) => (
    <aside data-testid="sidebar" data-width={width} />
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SidebarPane />));
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
});

const widthOf = (container: ParentNode) =>
  Number(
    container
      .querySelector('[data-testid="sidebar"]')!
      .getAttribute("data-width"),
  );

/** What the browser does around a drag: capture, moves, release. */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    button: 0,
  }) as MouseEvent & {
    pointerId: number;
  };
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("左栏的拖拽", () => {
  it("starts at the remembered width, 288px on a first visit", async () => {
    const container = await render();
    expect(widthOf(container)).toBe(288);
  });

  it("resizes while dragging and remembers where it landed", async () => {
    const container = await render();
    const divider = container.querySelector('[role="separator"]')!;
    const setPointerCapture = rstest.fn();
    const releasePointerCapture = rstest.fn();
    Object.assign(divider, { setPointerCapture, releasePointerCapture });

    await act(async () => {
      divider.dispatchEvent(pointer("pointerdown", 300));
    });
    expect(divider.getAttribute("data-dragging")).toBe("true");
    await act(async () => {
      divider.dispatchEvent(pointer("pointermove", 366));
    });
    expect(widthOf(container)).toBe(354);
    await act(async () => {
      divider.dispatchEvent(pointer("pointerup", 366));
    });
    expect(divider.getAttribute("data-dragging")).toBe("false");
    expect(localStorage.getItem("eta.sidebar.width")).toBe("354");
  });

  it("stops at the bounds the layout can hold", async () => {
    localStorage.setItem("eta.sidebar.width", "288");
    const container = await render();
    const divider = container.querySelector('[role="separator"]')!;
    Object.assign(divider, {
      setPointerCapture: rstest.fn(),
      releasePointerCapture: rstest.fn(),
    });
    await act(async () => {
      divider.dispatchEvent(pointer("pointerdown", 300));
      divider.dispatchEvent(pointer("pointermove", 3000));
    });
    expect(widthOf(container)).toBe(420);
    await act(async () => {
      divider.dispatchEvent(pointer("pointermove", -3000));
    });
    expect(widthOf(container)).toBe(260);
  });
});
