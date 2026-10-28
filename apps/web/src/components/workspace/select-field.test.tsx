import { afterEach, expect, it, rstest } from "@rstest/core";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Select, SelectGroup, SelectOption } from "./select-field";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
});

it("preserves explicit empty choices and disabled grouped options", async () => {
  const change = rstest.fn();
  await act(async () =>
    root.render(
      <Select
        aria-label="工作位置"
        value="workspace"
        open
        onValueChange={change}
      >
        <SelectOption value="">选择工作位置</SelectOption>
        <SelectGroup label="已有工作区">
          <SelectOption value="workspace">工作区</SelectOption>
          <SelectOption value="unavailable" disabled>
            不可用
          </SelectOption>
        </SelectGroup>
      </Select>,
    ),
  );
  const options = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  expect(
    options
      .find((option) => option.textContent === "不可用")
      ?.getAttribute("aria-disabled"),
  ).toBe("true");
  const empty = options.find(
    (option) => option.textContent === "选择工作位置",
  )!;
  await act(async () =>
    empty.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(change).toHaveBeenCalledWith("");
  expect(
    container.querySelector('[role="combobox"]')?.getAttribute("aria-label"),
  ).toBe("工作位置");
});

it("shows a disabled placeholder and keeps the trigger disabled", async () => {
  await act(async () =>
    root.render(
      <Select aria-label="模型" value="" disabled>
        <SelectOption value="" disabled>
          正在加载模型…
        </SelectOption>
      </Select>,
    ),
  );
  const trigger =
    container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  expect(trigger.disabled).toBe(true);
  expect(trigger.textContent).toBe("正在加载模型…");
});

it("does not report a value it has no option for as cleared", async () => {
  // Inside a form Radix mirrors the value into a hidden native select, which
  // falls back to "" for a value with no option yet (models before their
  // services load) and reports that as a change: the agent editor then set
  // its default model again, until React gave up (#185).
  const change = rstest.fn();
  const render = (value: string) =>
    root.render(
      <form>
        <Select aria-label="模型" value={value} onValueChange={change}>
          <SelectOption value="" disabled>
            选择模型
          </SelectOption>
        </Select>
      </form>,
    );
  await act(async () => render(""));
  await act(async () => render("gpt-5.5"));
  expect(change).not.toHaveBeenCalled();
});

it("shows the newly chosen option's label right after the value changes", async () => {
  // The trigger's text is the selected item's own text, resolved by Radix through a portal into
  // the value node. A pick that only reaches the parent asynchronously (a mutation, a refetch)
  // must not leave the trigger reading the old label: whoever owns the value has to hand it back.
  const render = (value: string) =>
    root.render(
      <Select aria-label="模型" value={value}>
        <SelectOption value="choice:model-a">模型 A</SelectOption>
        <SelectOption value="model-b">模型 B</SelectOption>
      </Select>,
    );
  await act(async () => render("choice:model-a"));
  const trigger = container.querySelector<HTMLElement>(
    "[data-slot='select-trigger']",
  );
  expect(trigger?.textContent).toContain("模型 A");
  await act(async () => render("model-b"));
  expect(trigger?.textContent).toContain("模型 B");
});

it("keeps a long selected label on one truncated line", async () => {
  await act(async () =>
    root.render(
      <Select aria-label="Project" value="project">
        <SelectOption value="project">
          Alice Agent · /very/long/project/path/alice/agents/8a9ac683-20ae-4c01
        </SelectOption>
      </Select>,
    ),
  );
  const trigger = container.querySelector<HTMLElement>(
    "[data-slot='select-trigger']",
  )!;
  expect(trigger.classList.contains("overflow-hidden")).toBe(true);
  expect(trigger.className).toContain(
    "[&_[data-slot=select-value]>span]:truncate",
  );
  expect(trigger.className).toContain(
    "[&_[data-slot=select-value]>span]:whitespace-nowrap",
  );
});

it("changes the label on the pick itself, before anything else re-renders", async () => {
  // The path a person takes: click the trigger, click the other option. The wrapper reports the
  // business value; the parent hands it back; the trigger reads that option's label. A controlled
  // wrapper that only reports and never re-reads shows the old label until something else
  // re-renders the tree — which is what "it did not change right away" looks like.
  let current = "choice:model-a";
  const Harness = () => {
    const [value, setValue] = useState(current);
    current = value;
    return (
      <Select aria-label="模型" value={value} onValueChange={setValue}>
        <SelectOption value="choice:model-a">模型 A</SelectOption>
        <SelectOption value="model-b">模型 B</SelectOption>
      </Select>
    );
  };
  await act(async () => root.render(<Harness />));
  const trigger = container.querySelector<HTMLElement>(
    "[data-slot='select-trigger']",
  )!;
  await act(async () => trigger.click());
  const options = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  const second = options.find((o) => o.textContent?.includes("模型 B"))!;
  await act(async () => second.click());
  expect(current).toBe("model-b");
  expect(trigger.textContent).toContain("模型 B");
});
