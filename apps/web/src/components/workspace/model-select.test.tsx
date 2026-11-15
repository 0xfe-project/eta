import type { Model } from "@/queries/providers";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { cleanup, click, flush, mount } from "@/test-render";
import { ModelSelect } from "./model-select";

afterEach(cleanup);

const model = (
  provider: string,
  providerName: string,
  id: string,
  name: string,
  available = true,
): Model => ({
  id: `${provider}:${id}`,
  provider,
  providerName,
  name,
  available,
});

const models = [
  model("zen", "OpenCode Zen", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  model("zen", "OpenCode Zen", "gpt-5", "GPT-5"),
  model("zen", "OpenCode Zen", "qwen3-coder", "Qwen3 Coder", false),
  model("local", "Ollama", "llama3", "Llama 3"),
  model("local", "Ollama", "qwen2.5", "Qwen 2.5"),
];

const trigger = () => document.querySelector<HTMLButtonElement>("#model")!;
const input = () =>
  document.querySelector<HTMLInputElement>("[cmdk-input]") ?? undefined;
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
const optionTexts = () => options().map((option) => option.textContent);
const headings = () =>
  [...document.querySelectorAll("[cmdk-group-heading]")].map(
    (heading) => heading.textContent,
  );
const selected = () =>
  document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
    ?.textContent;

async function render(
  props: Partial<React.ComponentProps<typeof ModelSelect>> = {},
) {
  const change = rstest.fn();
  await mount(
    <ModelSelect
      id="model"
      aria-label="模型"
      value=""
      models={models}
      onValueChange={change}
      {...props}
    />,
  );
  return change;
}

async function open() {
  await click(trigger());
  await flush();
}

async function type(text: string) {
  const field = input()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function key(name: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    input()!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
  await flush();
}

describe("searching", () => {
  it("opens ready to type, with every model grouped by its service", async () => {
    await render();
    await open();
    expect(document.activeElement).toBe(input());
    expect(headings()).toEqual(["OpenCode Zen", "Ollama"]);
    expect(options()).toHaveLength(5);
  });

  it("matches name, id and service, ignoring case, and hides groups left empty", async () => {
    await render();
    await open();

    await type("QWEN");
    expect(optionTexts()).toEqual(["Qwen3 Coder（不可用）", "Qwen 2.5"]);
    expect(headings()).toEqual(["OpenCode Zen", "Ollama"]);

    // By id: "gpt-5" is the id, the name says "GPT-5" too; "sonnet-4-5" only the id has.
    await type("sonnet-4-5");
    expect(optionTexts()).toEqual(["Claude Sonnet 4.5"]);
    expect(headings()).toEqual(["OpenCode Zen"]);

    // By service: the whole group, the other one gone.
    await type("ollama");
    expect(optionTexts()).toEqual(["Llama 3", "Qwen 2.5"]);
    expect(headings()).toEqual(["Ollama"]);

    await type("nothing like it");
    expect(options()).toHaveLength(0);
    expect(headings()).toEqual([]);
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "没有匹配的模型",
    );
  });

  it("starts over from an empty search the next time it opens", async () => {
    await render();
    await open();
    await type("llama");
    await key("Escape");
    expect(input()).toBeUndefined();
    await open();
    expect(input()!.value).toBe("");
    expect(options()).toHaveLength(5);
  });
});

describe("the keyboard", () => {
  it("moves with the arrows, picks with Enter and closes", async () => {
    const change = await render();
    await open();
    await type("o");
    expect(selected()).toBe("Claude Sonnet 4.5");
    await key("ArrowDown");
    expect(selected()).toBe("GPT-5");
    // The unavailable one is skipped.
    await key("ArrowDown");
    expect(selected()).toBe("Llama 3");
    await key("ArrowUp");
    expect(selected()).toBe("GPT-5");
    await key("Enter");
    expect(change).toHaveBeenCalledWith("zen:gpt-5");
    expect(input()).toBeUndefined();
  });

  it("does not pick on the Enter that ends an IME composition", async () => {
    const change = await render();
    await open();
    await type("qwen");
    await key("Enter", { isComposing: true });
    await key("Enter", { keyCode: 229 } as KeyboardEventInit);
    expect(change).not.toHaveBeenCalled();
    expect(input()).toBeDefined();
    await key("Enter");
    expect(change).toHaveBeenCalledWith("local:qwen2.5");
  });

  it("closes on Escape without picking", async () => {
    const change = await render({ value: "local:llama3" });
    await open();
    await key("Escape");
    expect(input()).toBeUndefined();
    expect(change).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Llama 3");
  });
});

describe("what it keeps from the plain select", () => {
  it("opens on the current choice, marked", async () => {
    await render({ value: "local:qwen2.5" });
    expect(trigger().textContent).toBe("Qwen 2.5");
    await open();
    expect(selected()).toBe("Qwen 2.5");
    expect(
      document.querySelector('[role="option"][data-checked="true"]')
        ?.textContent,
    ).toBe("Qwen 2.5");
  });

  it("offers an external runtime's own default, searchable by its name", async () => {
    const change = await render({
      value: "zen:gpt-5",
      defaultLabel: "运行时默认模型",
    });
    await open();
    expect(optionTexts()[0]).toBe("运行时默认模型");
    await type("运行时");
    expect(optionTexts()).toEqual(["运行时默认模型"]);
    await key("Enter");
    expect(change).toHaveBeenCalledWith("");
  });

  it("asks to pick when there is no default, and is disabled while loading", async () => {
    await render({ models: undefined, value: "zen:gpt-5" });
    expect(trigger().disabled).toBe(true);
    expect(trigger().textContent).toBe("正在加载模型…");
    await cleanup();
    await render();
    expect(trigger().textContent).toBe("选择模型");
    expect(trigger().hasAttribute("data-placeholder")).toBe(true);
  });

  it("shows a chosen model the list no longer has, but never offers it", async () => {
    const change = await render({ value: "zen:gone" });
    expect(trigger().textContent).toBe("zen:gone（已不可用）");
    await open();
    const gone = options()[0]!;
    expect(gone.textContent).toBe("zen:gone（已不可用）");
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    // Found by its id too, still not choosable.
    await type("gone");
    expect(optionTexts()).toEqual(["zen:gone（已不可用）"]);
    await key("Enter");
    expect(change).not.toHaveBeenCalled();
  });

  it("shows the chosen id as it is when the machine cannot list its models", async () => {
    await render({ value: "claude:opus", models: null });
    expect(trigger().disabled).toBe(false);
    expect(trigger().textContent).toBe("claude:opus");
  });

  it("keeps an unavailable model that is the current choice choosable", async () => {
    await render({ value: "zen:qwen3-coder" });
    await open();
    const current = options().find((option) =>
      option.textContent?.startsWith("Qwen3"),
    )!;
    expect(current.getAttribute("aria-disabled")).toBe("false");
  });
});
