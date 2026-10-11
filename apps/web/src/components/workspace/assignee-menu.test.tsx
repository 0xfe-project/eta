import { afterEach, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { draftInput, emptyDraft, placeKey } from "./assignee-draft";
import { AssigneeMenu } from "./assignee-menu";
import { assigneeTree } from "./assignee-tree";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const options = [
  {
    computer_id: "a",
    computer_name: "电脑 A",
    runtime: "paseo",
    provider: "codex",
    online: true,
  },
  {
    computer_id: "a",
    computer_name: "电脑 A",
    runtime: "paseo",
    provider: "claude",
    online: true,
  },
  {
    computer_id: "a",
    computer_name: "电脑 A",
    runtime: "herdr",
    provider: "devin",
    online: false,
  },
  {
    computer_id: "b",
    computer_name: "电脑 B",
    runtime: "herdr",
    provider: "claude",
    online: true,
  },
];
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
});
it("groups only actual tuples and preserves offline information", () => {
  const tree = assigneeTree(options);
  expect(tree[2].children?.map((r) => r.label)).toEqual(["Paseo", "Herdr"]);
  expect(tree[2].children?.[1].offline).toBe(true);
  expect(tree[3].children?.[0].children?.map((p) => p.key)).toEqual([
    "remote:b:herdr:claude",
  ]);
});
it("requires a place and serializes the exact target and session", () => {
  const draft = { ...emptyDraft, key: "remote:b:herdr:claude" };
  expect(draftInput(draft, undefined)).toBe(null);
  expect(
    draftInput(
      { ...draft, place: placeKey("workspace", "ws", "session") },
      undefined,
    ),
  ).toEqual({
    kind: "remote",
    computer_id: "b",
    runtime: "herdr",
    provider: "claude",
    place: { kind: "workspace", workspace_id: "ws", session: "session" },
  });
});
it("supports keyboard drill-down and back on touch without selecting parents", async () => {
  rstest.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        matches: true,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
  const change = rstest.fn();
  await act(async () =>
    root.render(
      <AssigneeMenu
        id="assignee"
        value="remote:a:paseo:codex"
        options={options}
        pending={false}
        retry={() => {}}
        onChange={change}
      />,
    ),
  );
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toContain("电脑 A · Paseo · Codex");
  const enter = async (element: Element) => {
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
  };
  await enter(trigger);
  const item = (text: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
      e.textContent?.includes(text),
    )!;
  await enter(item("电脑 B"));
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
    "Codex",
  );
  await enter(item("返回"));
  await enter(item("电脑 A"));
  await enter(item("Paseo"));
  expect(item("Codex").querySelector('[aria-label="已选"]')).not.toBe(null);
  expect(change).not.toHaveBeenCalled();
  await enter(item("Claude"));
  expect(change).toHaveBeenCalledWith("remote:a:paseo:claude");
  rstest.restoreAllMocks();
});

it("keeps an unavailable selected path visible and offers error retry", async () => {
  const retry = rstest.fn();
  const change = rstest.fn();
  await act(async () =>
    root.render(
      <AssigneeMenu
        id="assignee"
        value="remote:removed:herdr:devin"
        options={[]}
        pending={false}
        error="读取失败"
        retry={retry}
        onChange={change}
      />,
    ),
  );
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toContain("removed · Herdr · Devin（不可用）");
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain(
    "读取失败",
  );
  const button = [...document.querySelectorAll('[role="menuitem"]')].find(
    (e) => e.textContent === "重试",
  )!;
  await act(async () =>
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(retry).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
});
