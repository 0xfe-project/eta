import type { ProductSeed } from "@/test-product";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost, routineInfo, routineSections } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { RoutineBoard } from "./routine-board";

const navigation = rstest.hoisted(() => ({
  routine: null as string | null,
  edit: "missing" as string | null,
  run: null,
  set: rstest.fn(),
}));
rstest.mock("./routine-nav", () => ({
  useRoutineNav: () => [navigation, navigation.set],
}));

const sections = routineSections(routineInfo({ id: "r1", name: "日报" }));

/**
 * One surface since 定时 left the side panel: the page. The board is also what a
 * phone shows, one column at a time, so the escape hatch (the detail's Back)
 * is asserted here too.
 */
async function render(seed: ProductSeed = {}) {
  const host = productHost(seed);
  const view = await mount(<RoutineBoard />);
  await flush();
  return { ...view, host };
}

describe("routine editing navigation", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    navigation.routine = null;
    navigation.edit = "missing";
    navigation.set.mockClear();
  });

  it("shows loading for a routine whose page has not come, then the editor", async () => {
    navigation.edit = "r1";
    const { container, host } = await render({ routines: [sections] });
    // The list has it; its own target has said nothing yet.
    host.target("routines.r1", {});
    await act(async () => {
      host.hello();
    });
    await flush();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "正在加载",
    );
    await act(async () => host.set("routines.r1", { ...sections }));
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("says why a host without routines shows none", async () => {
    const { container } = await render({ absent: ["routines"] });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "宿主没有加载 routines",
    );
  });

  it("says a routine the host does not have is gone", async () => {
    const { container } = await render({ routines: [sections] });
    expect(container.textContent).toContain("这个定时任务已不存在");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("uses the same missing state for a selected routine", async () => {
    navigation.edit = "";
    navigation.routine = "missing";
    const { container } = await render();
    expect(container.textContent).toContain("这个定时任务已不存在");
  });

  it("goes back to the list from an open routine", async () => {
    navigation.edit = "";
    navigation.routine = "r1";
    const { container } = await render({ routines: [sections] });
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "定时任务",
    )!;
    await act(async () => back.click());
    expect(navigation.set).toHaveBeenCalledWith({ routine: null });
  });
});
