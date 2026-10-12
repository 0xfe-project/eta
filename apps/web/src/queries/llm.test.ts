import type { Model } from "./llm";
import { describe, expect, it } from "@rstest/core";
import { modelAvailability } from "./llm";

const model = (status: Model["status"], message?: string): Model => ({
  id: "gpt",
  connector: "codex",
  display_name: "GPT",
  status,
  available: status !== "unavailable",
  reason: message ? { code: "X", message } : undefined,
});
const agent = { model: "gpt" };

describe("whether an agent can chat with its model", () => {
  it("lets a transient upstream failure through, with a warning", () => {
    const got = modelAvailability(agent, [
      model("degraded", "上游暂时故障（HTTP 502），稍后会自动重试。"),
    ]);
    expect(got.state).toBe("degraded");
    expect(got.state === "degraded" && got.message).toBe(
      "GPT 上游暂时故障（HTTP 502），稍后会自动重试。仍可发送。",
    );
  });

  it("blocks a model that needs the user, saying why", () => {
    const got = modelAvailability(agent, [
      model("unavailable", "Codex 账号登录已失效，请重新登录。"),
    ]);
    expect(got).toMatchObject({
      state: "unavailable",
      message: "GPT 暂不可用：Codex 账号登录已失效，请重新登录。",
    });
  });

  it("does not block on a catalog it could not refresh", () => {
    expect(modelAvailability(agent, [model("unavailable")], true).state).toBe(
      "ok",
    );
    expect(modelAvailability(agent, undefined).state).toBe("ok");
    expect(modelAvailability(agent, []).state).toBe("unavailable");
  });
});
