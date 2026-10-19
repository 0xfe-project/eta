import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { productHost, taskDetail } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { TaskProperties } from "./tasks";

rstest.mock("./use-groups", () => ({
  useGroups: () => ({
    groups: [{ id: "g1", name: "任务讨论", archived: false }],
  }),
  useOpenGroup: () => () => {},
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("任务详情的来源", () => {
  it.each([["g1"], [null]])(
    "shows neither the source group nor a way to it (%s)",
    async (conversationId) => {
      productHost();
      const task = {
        ...taskDetail({ id: "t1", number: 111, title: "验收群聊" }),
        conversationId,
        activity: [],
      };
      const { container } = await mount(<TaskProperties task={task} />);
      await flush();
      const labels = [...container.querySelectorAll("dt")].map(
        (dt) => dt.textContent,
      );
      // A note the user made cannot run: no executor, no workspace.
      expect(labels).toEqual(["状态"]);
      expect(container.querySelector('[aria-label="关联群"]')).toBeNull();
      expect(container.textContent).not.toContain("任务讨论");
    },
  );

  it("names the executor, the workspace and the run of an agent's task", async () => {
    productHost();
    const task = {
      ...taskDetail({
        id: "t2",
        createdBy: { kind: "agent", agentId: "a1" },
      }),
      activity: [],
    };
    const { container } = await mount(<TaskProperties task={task} />);
    await flush();
    const labels = [...container.querySelectorAll("dt")].map(
      (dt) => dt.textContent,
    );
    expect(labels).toEqual(["状态", "执行者", "工作区", "运行"]);
  });
});
