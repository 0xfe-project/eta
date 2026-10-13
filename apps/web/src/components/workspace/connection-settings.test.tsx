import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionSettings } from "./connection-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const weather = {
  name: "weather",
  description: "天气预报",
  builtin: true,
  script: "",
  plugins: ["weather"],
  config: {
    type: "object",
    additionalProperties: false,
    required: ["WEATHER_KEY"],
    properties: {
      WEATHER_CITY: { type: "string", title: "城市", maxLength: 40 },
      WEATHER_KEY: {
        type: "string",
        title: "API key",
        writeOnly: true,
        maxLength: 64,
        description: "在 [控制台](https://example.com/keys) 生成",
      },
    },
  },
};

async function render(state: object) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(["forge", "github"], {
    state: "not_connected",
    app: null,
    installations: [],
  });
  queryClient.setQueryData(["llm", "connectors"], []);
  queryClient.setQueryData(["llm", "connections"], []);
  queryClient.setQueryData(["llm", "usage"], []);
  queryClient.setQueryData(
    ["bundles"],
    [weather, { ...weather, name: "plain", config: undefined }],
  );
  queryClient.setQueryData(["bundles", "weather", "config"], state);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <ConnectionSettings />
      </QueryClientProvider>,
    ),
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const button = (text: RegExp) =>
  [...document.querySelectorAll("button")].find((b) =>
    text.test(b.textContent ?? ""),
  )!;
const input = (label: string) => {
  const l = [...document.querySelectorAll("label")].find((x) =>
    x.textContent?.startsWith(label),
  )!;
  return document.getElementById(l.htmlFor) as HTMLInputElement;
};
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function capture() {
  const sent: unknown[] = [];
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input as Request;
    sent.push({ method: request.method, body: await request.json() });
    return Response.json({ values: {}, set: [], ready: true });
  });
  return sent;
}

const submit = () =>
  act(async () =>
    button(/^保存$/)
      .closest("form")!
      .requestSubmit(),
  );

describe("a bundle's config", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("is a form built from the schema, only for bundles that have one", async () => {
    const sent = capture();
    await render({ values: {}, set: [], ready: false });
    expect(document.body.textContent).toContain("weather未配置");
    expect(document.body.textContent).not.toContain("plain");
    await act(async () => button(/weather/).click());
    const key = input("API key");
    expect(key.type).toBe("password");
    expect(key.required).toBe(true);
    expect(input("城市").required).toBe(false);
    expect(
      document.querySelector('a[href="https://example.com/keys"]'),
    ).not.toBeNull();
    type(key, " wk-1 ");
    type(input("城市"), "Paris");
    await submit();
    await settle();
    expect(sent).toEqual([
      {
        method: "PATCH",
        body: { values: { WEATHER_CITY: "Paris", WEATHER_KEY: "wk-1" } },
      },
    ]);
  });

  it("never shows a secret, keeps it when left blank, and clears with null", async () => {
    const sent = capture();
    await render({
      values: { WEATHER_CITY: "Paris" },
      set: ["WEATHER_CITY", "WEATHER_KEY"],
      ready: true,
      updated_at: "2026-10-13T00:00:00Z",
    });
    expect(document.body.textContent).not.toContain("未配置");
    await act(async () => button(/weather/).click());
    const key = input("API key");
    expect(key.value).toBe("");
    expect(key.required).toBe(false);
    expect(key.placeholder).toBe("已设置，留空不替换");
    expect(input("城市").value).toBe("Paris");
    type(input("城市"), "");
    await submit();
    await settle();
    expect(sent).toEqual([
      { method: "PATCH", body: { values: { WEATHER_CITY: null } } },
    ]);
  });
});
