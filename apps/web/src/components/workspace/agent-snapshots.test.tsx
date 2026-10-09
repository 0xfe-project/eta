import type { Agent } from "@/queries/chat";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentSnapshots } from "./agent-snapshots";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: "a1", name: "研究员" } as Agent;
const snapshot = (id: string, message: string, current = false) => ({
  id,
  kind: "turn",
  saved_at: "2026-10-09T09:00:00Z",
  size: 10,
  message,
  restored_from: null,
  current,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name);

describe("an agent's snapshots", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("go back to an earlier one after confirming", async () => {
    const calls: string[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({
        snapshots: [
          snapshot("s2", "第二处改动", true),
          snapshot("s1", "第一处改动"),
        ],
      });
    });
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () =>
      createRoot(container).render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentSnapshots agent={agent} />
        </QueryClientProvider>,
      ),
    );
    await act(settle);
    expect(container.textContent).toContain("「第二处改动」之后");
    expect(container.textContent).toContain("当前");
    await act(async () => {
      button("回到这里")!.click();
      await settle();
    });
    expect(document.body.textContent).toContain("回到这个快照？");
    const confirm = [
      ...document.querySelectorAll('[role="alertdialog"] button'),
    ].find((b) => b.textContent === "回到这里") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await settle();
    });
    expect(calls).toContain("POST /api/v1/agents/a1/snapshots/s1/restore");
  });
});
