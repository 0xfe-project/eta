import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UsageLine } from "./usage-line";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const counts = (total: number, requests = 1) => ({
  requests,
  failed: 0,
  input_tokens: total,
  output_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: total,
});

async function render(principal: string) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <QueryClientProvider client={new QueryClient()}>
        <UsageLine principal={principal} />
      </QueryClientProvider>,
    ),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return container;
}

describe("an agent's model usage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("shows its tokens over 5 hours, a day and a week", async () => {
    rstest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        usage: [
          {
            principal: "routine-r1",
            windows: {
              "5h": counts(800),
              "24h": counts(25_000),
              "7d": counts(1_230_000, 42),
            },
            models: [],
            accounts: [],
          },
        ],
      }),
    );
    const line = await render("routine-r1");
    expect(line.textContent).toBe(
      "模型用量：5 小时 800 · 24 小时 2.5万 · 7 天 123.0万 tokens（7 天 42 次请求）",
    );
    const other = await render("agent-2");
    expect(other.textContent).toBe("模型用量：近 7 天没有");
  });
});
