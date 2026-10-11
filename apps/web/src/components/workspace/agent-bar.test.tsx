import { afterEach, beforeEach, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentBar } from "./agent-bar";

const agents = rstest.hoisted(() => ({
  list: [
    { id: "a1", name: "甲", status: "idle" },
    { id: "a2", name: "乙", status: "idle" },
  ],
  select: rstest.fn(),
  openEditor: rstest.fn(),
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: agents.list,
    current: agents.list[0],
    loaded: true,
    error: null,
    select: agents.select,
    openEditor: agents.openEditor,
  }),
}));
rstest.mock("./agent-identity", () => ({
  AgentAvatar: () => <span />,
  AgentStatusDot: () => <span />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
beforeEach(async () => {
  agents.select.mockClear();
  await act(async () => root.render(<AgentBar />));
});
afterEach(async () => {
  await act(async () => root.render(null));
});

const trigger = () => container.querySelector("button")!;
const menu = () => document.querySelector('[role="menu"]');
const item = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.includes(name),
  )!;
const pointer = async (
  target: Element,
  type: string,
  pointerType = "mouse",
  related: Element | null = null,
) =>
  act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType,
        relatedTarget: related,
      }),
    );
  });
const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

it("opens on mouse hover without switching, and closes after leaving", async () => {
  await pointer(trigger(), "pointerover");
  expect(menu()).toBeNull();
  await wait(150);
  expect(menu()).not.toBeNull();
  // A hovered-open menu leaves focus alone and locks nothing.
  expect(document.activeElement).toBe(document.body);
  expect(document.body.style.pointerEvents).toBe("");
  expect(agents.select).not.toHaveBeenCalled();

  // Crossing the gap into the menu keeps it open.
  await pointer(trigger(), "pointerout", "mouse", document.body);
  await wait(50);
  await pointer(menu()!, "pointerover", "mouse", document.body);
  await wait(400);
  expect(menu()).not.toBeNull();

  await pointer(menu()!, "pointerout", "mouse", document.body);
  await wait(100);
  expect(menu()).not.toBeNull();
  await wait(300);
  expect(menu()).toBeNull();
});

it("does not open when the mouse only passes over", async () => {
  await pointer(trigger(), "pointerover");
  await wait(30);
  await pointer(trigger(), "pointerout", "mouse", document.body);
  await wait(200);
  expect(menu()).toBeNull();
});

it("ignores touch hover", async () => {
  await pointer(trigger(), "pointerover", "touch");
  await wait(150);
  expect(menu()).toBeNull();
});

it("closes on choosing and stays closed while the pointer rests on the trigger", async () => {
  await pointer(trigger(), "pointerover");
  await wait(150);
  // Clicking the hovered-open trigger keeps it open.
  await pointer(trigger(), "pointerdown");
  expect(menu()).not.toBeNull();
  expect(menu()!.contains(document.activeElement)).toBe(true);
  await act(async () => item("乙").click());
  expect(agents.select).toHaveBeenCalledWith("a2");
  await wait(150);
  expect(menu()).toBeNull();
  await pointer(trigger(), "pointerover");
  await wait(150);
  expect(menu()).toBeNull();

  await pointer(trigger(), "pointerout", "mouse", document.body);
  await pointer(trigger(), "pointerover");
  await wait(150);
  expect(menu()).not.toBeNull();
});

it("pins a hovered-open menu on click and closes it on a second click", async () => {
  await pointer(trigger(), "pointerover");
  await wait(150);
  await pointer(trigger(), "pointerdown");
  await pointer(trigger(), "pointerout", "mouse", document.body);
  await wait(400);
  expect(menu()).not.toBeNull();
  await pointer(trigger(), "pointerover");
  await pointer(trigger(), "pointerdown");
  await wait(150);
  expect(menu()).toBeNull();
});

it("still opens from the keyboard and closes on Escape", async () => {
  await act(async () => {
    trigger().focus();
    trigger().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(menu()).not.toBeNull();
  await act(async () =>
    menu()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await wait(10);
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("opens the new-agent editor from the menu", async () => {
  await pointer(trigger(), "pointerover");
  await wait(150);
  await act(async () => item("新建智能体").click());
  expect(agents.openEditor).toHaveBeenCalled();
});
