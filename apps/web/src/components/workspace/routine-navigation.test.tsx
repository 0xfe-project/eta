import type { ProductSeed } from "@/test-product";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost, routineInfo, routineSections } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { RoutineBoard } from "./routine-board";
import { Routines } from "./routines";

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

async function render(board: boolean, seed: ProductSeed = {}) {
  const host = productHost(seed);
  const view = await mount(board ? <RoutineBoard /> : <Routines />);
  await flush();
  return { ...view, host };
}

describe.each([false, true])(
  "routine editing navigation (full page: %s)",
  (board) => {
    afterEach(async () => {
      await cleanup();
      setWire(undefined);
      navigation.routine = null;
      navigation.edit = "missing";
      navigation.set.mockClear();
    });

    it("shows loading for a routine whose page has not come, then the editor", async () => {
      navigation.edit = "r1";
      const { container, host } = await render(board, { routines: [sections] });
      // The list has it; its own target has said nothing yet.
      host.target("routines.r1", {});
      await act(async () => {
        host.hello();
      });
      await flush();
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "正在加载",
      );
      if (!board) expect(container.textContent).not.toContain("还没有定时任务");
      await act(async () => host.set("routines.r1", { ...sections }));
      expect(container.querySelector("form")).not.toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("says why a host without routines shows none", async () => {
      const { container } = await render(board, { absent: ["routines"] });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "宿主没有加载 routines",
      );
    });

    it("says a routine the host does not have is gone", async () => {
      const { container } = await render(board, { routines: [sections] });
      expect(container.textContent).toContain("这个定时任务已不存在");
      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("uses the same missing state for a selected routine", async () => {
      navigation.edit = "";
      navigation.routine = "missing";
      const { container } = await render(board);
      expect(container.textContent).toContain("这个定时任务已不存在");
    });
  },
);

describe("routine panel back navigation", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    navigation.routine = null;
    navigation.edit = "missing";
    navigation.set.mockClear();
  });

  it("clears the stale edit target when returning to the list", async () => {
    const { container } = await render(false);
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "定时任务",
    )!;
    await act(async () => back.click());
    expect(navigation.set).toHaveBeenCalledWith({
      edit: null,
      routine: null,
      run: null,
    });
  });
});
