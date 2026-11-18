import { afterEach, expect, it } from "@rstest/core";
import { act } from "react";
import { cleanup, mount } from "@/test-render";
import { usePaneWidth } from "./pane";

afterEach(async () => {
  await cleanup();
  localStorage.clear();
});

function Divider() {
  const pane = usePaneWidth({
    storageKey: "test.pane.width",
    min: 320,
    max: 720,
    fallback: 400,
    edge: "right",
  });
  return <div aria-label="resize" {...pane.dividerProps} />;
}

it("grows a right-hand pane when ArrowLeft is pressed on its divider", async () => {
  const { container: host } = await mount(<Divider />);
  const divider = host.querySelector<HTMLElement>('[role="separator"]');
  expect(divider?.tabIndex).toBe(0);

  await act(async () => {
    divider?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  expect(divider?.getAttribute("aria-valuenow")).toBe("416");
  expect(localStorage.getItem("test.pane.width")).toBe("416");

  await act(async () => {
    divider?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
  });
  expect(divider?.getAttribute("aria-valuenow")).toBe("720");
});

function Fallback({ fallback }: { fallback: number }) {
  const pane = usePaneWidth({
    storageKey: "test.pane.width",
    min: 320,
    max: 720,
    fallback,
  });
  return (
    <div aria-label="resize" data-sized={pane.sized} {...pane.dividerProps} />
  );
}

it("follows a moving fallback until a width is chosen, and keeps the width after", async () => {
  const { container: host, show } = await mount(<Fallback fallback={400} />);
  const divider = () => host.querySelector<HTMLElement>('[role="separator"]');
  expect(divider()?.getAttribute("data-sized")).toBe("false");
  await show(<Fallback fallback={480} />);
  expect(divider()?.getAttribute("aria-valuenow")).toBe("480");

  await act(async () => {
    divider()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(divider()?.getAttribute("data-sized")).toBe("true");
  await show(<Fallback fallback={400} />);
  expect(divider()?.getAttribute("aria-valuenow")).toBe("496");
});

it("a press on the line that never moves keeps the saved width", async () => {
  localStorage.setItem("test.pane.width", "500");
  const { container: host } = await mount(<Divider />);
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  divider.setPointerCapture = () => undefined;
  divider.releasePointerCapture = () => undefined;
  const fire = (type: string) =>
    act(async () => {
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 1,
        }),
      );
    });
  await fire("pointerdown");
  await fire("pointerup");
  expect(localStorage.getItem("test.pane.width")).toBe("500");
  expect(divider.getAttribute("aria-valuenow")).toBe("500");
});

// The same for a pane on the left of the window, whose divider is on its right edge: the test
// above is the default, a right-hand pane. Without `land`'s check either one saves `undefined`,
// which a column takes as "forget the width" and removes from storage.
function LeftPane() {
  const pane = usePaneWidth({
    storageKey: "test.pane.left",
    min: 320,
    max: 720,
    fallback: 400,
    edge: "left",
  });
  return <div aria-label="resize" {...pane.dividerProps} />;
}

it("a press on a left-hand pane's line that never moves keeps its saved width", async () => {
  localStorage.setItem("test.pane.left", "500");
  const { container: host } = await mount(<LeftPane />);
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  divider.setPointerCapture = () => undefined;
  divider.releasePointerCapture = () => undefined;
  const fire = (type: string) =>
    act(async () => {
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 600,
          pointerId: 1,
        }),
      );
    });
  await fire("pointerdown");
  await fire("pointerup");
  expect(localStorage.getItem("test.pane.left")).toBe("500");
  expect(divider.getAttribute("aria-valuenow")).toBe("500");
});
