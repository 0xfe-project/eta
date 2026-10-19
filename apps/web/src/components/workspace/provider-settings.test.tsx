import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProviderSettings } from "./provider-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (extra: object = {}) => ({
  id: "a",
  connector: "codex",
  label: "dev@example.com",
  state: "active",
  created_at: "2026-10-01T00:00:00Z",
  ...extra,
});

const model = (id: string, status: string, extra: object = {}) => ({
  id,
  connector: "codex",
  display_name: id,
  status,
  available: status !== "unavailable",
  ...extra,
});

// gpt-1 just got a 502; gpt-2 is fine.
const before = [
  model("gpt-1", "degraded", {
    reason: {
      code: "UPSTREAM_UNSTABLE",
      message: "上游暂时故障（HTTP 502），稍后会自动重试。",
    },
  }),
  model("gpt-2", "available"),
];
const after = {
  connections: [connection({ checked_at: "2026-10-12T08:00:00Z" })],
  models: [model("gpt-1", "available"), model("gpt-2", "available")],
  usage: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let queryClient: QueryClient;

const codex = { id: "codex", display_name: "Codex", flow: "oauth_device" };

async function render(connectors: object[] = [codex]) {
  // Seeded data stays fresh, so only what a test triggers is fetched.
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(["chat"], {
    agents: [],
    active_replies: [],
    messages: [],
    interactions: [],
    event_cursor: "0",
  });
  queryClient.setQueryData(["llm", "connectors"], connectors);
  queryClient.setQueryData(["llm", "connections"], [connection()]);
  queryClient.setQueryData(["llm", "models"], before);
  queryClient.setQueryData(["llm", "usage"], []);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <ProviderSettings />
      </QueryClientProvider>,
    ),
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
// Settles until done, however slow the machine (CI): at most two seconds.
async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await settle();
}
const refreshButton = () =>
  [...document.querySelectorAll("button")].find((b) =>
    /刷新状态|检查中/.test(b.textContent ?? ""),
  )!;
const status = () => document.querySelector('[role="status"]')?.textContent;
const models = () => queryClient.getQueryData<typeof before>(["llm", "models"]);

describe("refreshing model status", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("checks again once however often it is pressed, then shows the result", async () => {
    const response = deferred<Response>();
    const requests: string[] = [];
    rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        // The provider list is read alongside the page; only the refresh is the deferred one, or
        // every query on the page would wait on it.
        if (url.includes("/api/llm/v1/providers")) {
          return Response.json({ providers: [] });
        }
        requests.push(`${init?.method ?? "GET"} ${url}`);
        return response.promise;
      });
    await render();

    await act(async () => refreshButton().click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(refreshButton().disabled).toBe(true);
    expect(refreshButton().textContent).toContain("检查中");
    expect(status()).toBe("正在检查…");
    await act(async () => refreshButton().click());

    response.resolve(Response.json(after));
    await settleUntil(() => !refreshButton().disabled);
    expect(requests).toEqual(["POST /api/llm/v1/refresh"]);
    expect(refreshButton().disabled).toBe(false);
    expect(status()).toMatch(/^已于 .+ 重新检查，账号均可连接$/);
    expect(models()?.every((m) => m.status === "available")).toBe(true);
  });

  it("keeps the status it had when the check fails", async () => {
    rstest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: "模型服务暂时不可用，请稍后再试。",
          },
        },
        { status: 424 },
      ),
    );
    await render();
    await act(async () => refreshButton().click());
    await settle();

    expect(status()).toBe(
      "刷新失败：模型服务暂时不可用，请稍后再试。仍显示之前的状态。",
    );
    expect(models()).toEqual(before);
    expect(models()?.some((m) => m.status === "unavailable")).toBe(false);
  });

  it("does not let a poll that started earlier land on top of the result", async () => {
    const poll = deferred<Response>();
    rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/refresh")
          ? Response.json(after)
          : poll.promise,
      );
    await render();
    // The 30-second poll is on its way when the user presses refresh.
    void queryClient.refetchQueries({ queryKey: ["llm", "models"] });
    await act(async () => refreshButton().click());
    await settle();
    expect(models()).toEqual(after.models);

    // Its answer, from before the check, arrives last.
    poll.resolve(Response.json(before));
    await settle();
    expect(models()).toEqual(after.models);
  });
});

const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  )!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("adding an API key", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("shows why a key is rejected, and closes once one is kept", async () => {
    const requests: string[] = [];
    rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        const login = {
          id: "gemini-1",
          connector: "gemini",
          flow: "api_key",
          status: "pending",
          expires_at: "2026-10-16T12:00:00Z",
        };
        if (url.endsWith("/logins")) return Response.json(login);
        if (url.endsWith("/input"))
          return String(init?.body).includes("bad")
            ? Response.json(
                {
                  error: {
                    code: "INVALID_API_KEY",
                    message: "API key 无效，请检查后重新填写。",
                  },
                },
                { status: 424 },
              )
            : Response.json({ ...login, status: "succeeded" });
        return Response.json([]);
      });
    await render([
      codex,
      { id: "gemini", display_name: "Google AI Studio", flow: "api_key" },
    ]);

    await act(async () => button("添加 API key").click());
    const input = document.querySelector<HTMLInputElement>("#api-key-gemini")!;
    expect(input.type).toBe("password");
    await act(async () => type(input, " bad "));
    await act(async () => button("校验并保存").click());
    await settleUntil(() => Boolean(document.querySelector('[role="alert"]')));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "API key 无效，请检查后重新填写。",
    );

    await act(async () => type(input, "AIza-good"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("校验并保存").click());
    await settleUntil(() => !document.querySelector("#api-key-gemini"));
    expect(document.querySelector("#api-key-gemini")).toBeNull();
    const posts = requests.filter((r) => r.startsWith("POST"));
    expect(posts).toEqual([
      'POST /api/llm/v1/logins {"connector":"gemini"}',
      'POST /api/llm/v1/logins/gemini-1/input {"api_key":"bad"}',
      'POST /api/llm/v1/logins {"connector":"gemini"}',
      'POST /api/llm/v1/logins/gemini-1/input {"api_key":"AIza-good"}',
    ]);
  });
});
