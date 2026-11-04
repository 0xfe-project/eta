import { afterEach, expect, it } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { usePaneWidth } from "./pane";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup.push(() => {
    root.unmount();
    host.remove();
  });
  await act(async () => root.render(<Divider />));
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup.push(() => {
    root.unmount();
    host.remove();
  });
  const divider = () => host.querySelector<HTMLElement>('[role="separator"]');
  await act(async () => root.render(<Fallback fallback={400} />));
  expect(divider()?.getAttribute("data-sized")).toBe("false");
  await act(async () => root.render(<Fallback fallback={480} />));
  expect(divider()?.getAttribute("aria-valuenow")).toBe("480");

  await act(async () => {
    divider()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(divider()?.getAttribute("data-sized")).toBe("true");
  await act(async () => root.render(<Fallback fallback={400} />));
  expect(divider()?.getAttribute("aria-valuenow")).toBe("496");
});
