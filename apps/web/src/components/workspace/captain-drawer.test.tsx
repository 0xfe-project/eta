import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { cleanup, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { CaptainDrawer } from "./captain-drawer";

const providers = {
  revision: "r1",
  providers: [
    {
      id: "custom",
      name: "Custom",
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      hasApiKey: true,
      models: [{ id: "model-a", name: "Model A" }],
    },
  ],
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("CaptainDrawer", () => {
  it("shows Captain's model in the drawer", async () => {
    const host = new FakeHost()
      .target("providers", { config: providers }, { eager: true })
      .target("captain", {
        identity: {
          agentId: "captain",
          name: "Captain",
          home: "C:\\captain",
          model: "custom:model-a",
          conversationId: "conversation-1",
          createdAt: 1,
        },
        assignments: [],
        operations: [],
        notifications: [],
        memoryPauses: [],
        settings: {
          supervisorEnabled: true,
          patrolMinutes: 30,
          inboxMinutes: 5,
          stuckMinutes: 30,
          retryLimit: 5,
          loopRounds: 5,
        },
      })
      .plugins([
        { name: "providers", source: "bundled" },
        { name: "captain", source: "bundled" },
      ])
      .install();
    host.hello();

    await mount(<CaptainDrawer open onOpenChange={() => undefined} />);
    await flush(20);

    expect(document.body.textContent).toContain("Captain 模型");
    expect(document.getElementById("captain-model")).not.toBeNull();
    const save = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "保存模型",
    );
    expect(save?.disabled).toBe(true);
  });
});
