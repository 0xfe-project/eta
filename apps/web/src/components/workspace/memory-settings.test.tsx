import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemorySettings } from "./memory-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const URL_KEY = "MEMORY_EMBEDDING_URL";
const MODEL_KEY = "MEMORY_EMBEDDING_MODEL";
const API_KEY = "MEMORY_EMBEDDING_API_KEY";
let unmount = () => {};

async function render(values: Record<string, string>, secretSet = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(["bundles"], []);
  queryClient.setQueryData(["bundles", "memory", "config"], {
    values,
    set: [...Object.keys(values), ...(secretSet ? [API_KEY] : [])],
    ready: true,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => root.unmount();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemorySettings />
      </QueryClientProvider>,
    ),
  );
}

function input(label: string) {
  const element = [...document.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label),
  )!;
  return document.getElementById(element.htmlFor) as HTMLInputElement;
}

function type(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function capture(secretSet = false) {
  const sent: unknown[] = [];
  const values: Record<string, string> = secretSet
    ? { [URL_KEY]: "https://example.com/v1", [MODEL_KEY]: "embed" }
    : {};
  let secret = secretSet;
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (value) => {
    const request = value as Request;
    if (request.method === "GET") return Response.json([]);
    const body = (await request.json()) as {
      values: Record<string, string | null>;
    };
    sent.push(body);
    for (const [key, value] of Object.entries(body.values)) {
      if (key === API_KEY) secret = value !== null;
      else if (value === null) delete values[key];
      else values[key] = value;
    }
    return Response.json({
      values: { ...values },
      set: [...Object.keys(values), ...(secret ? [API_KEY] : [])],
      ready: true,
      updated_at: String(sent.length),
    });
  });
  return sent;
}

const submit = async () => {
  await act(async () => document.querySelector("form")!.requestSubmit());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
};

async function choose(label: string) {
  await act(async () =>
    document
      .querySelector('[role="combobox"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
  );
  await act(async () =>
    (
      [...document.querySelectorAll('[role="option"]')].find((item) =>
        item.textContent?.includes(label),
      ) as HTMLElement
    ).click(),
  );
}

describe("memory embedding settings", () => {
  afterEach(async () => {
    await act(async () => unmount());
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("defaults to local INT8 and configures an external API", async () => {
    const sent = capture();
    await render({});
    expect(document.body.textContent).toContain("本地模型（INT8）");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await choose("外部 API");
    await act(async () => {
      type(input("API 地址"), "http://localhost:8321/v1");
      type(input("模型"), "bilingual-model");
      type(input("API key"), "secret-key");
    });
    await submit();
    expect(sent).toEqual([
      {
        values: {
          [URL_KEY]: "http://localhost:8321/v1",
          [MODEL_KEY]: "bilingual-model",
          [API_KEY]: "secret-key",
        },
      },
    ]);
  });

  it("keeps a stored secret when blank and allows explicitly clearing it", async () => {
    const sent = capture(true);
    await render(
      { [URL_KEY]: "https://example.com/v1", [MODEL_KEY]: "embed" },
      true,
    );
    expect(input("API key").value).toBe("");
    expect(input("API key").placeholder).toBe("已设置，留空不替换");
    await submit();
    expect((sent[0] as { values: object }).values).not.toHaveProperty(API_KEY);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("清除密钥"))!
        .click(),
    );
    await submit();
    expect((sent[1] as { values: object }).values).toHaveProperty(
      API_KEY,
      null,
    );
  });

  it("switches back to local without sending a stored API key", async () => {
    const sent = capture(true);
    await render(
      { [URL_KEY]: "https://example.com/v1", [MODEL_KEY]: "embed" },
      true,
    );
    await choose("本地模型");
    await submit();
    expect(sent).toEqual([{ values: { [URL_KEY]: null } }]);
  });
});
