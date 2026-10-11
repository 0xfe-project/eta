import { afterEach, expect, it, rstest } from "@rstest/core";
import { act } from "react";
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
