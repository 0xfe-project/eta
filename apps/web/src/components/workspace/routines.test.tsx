import type { RunView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost, routineInfo, routineSections } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { RoutineBoard } from "./routine-board";

const navigation = rstest.hoisted(() => ({
  routine: null as string | null,
  edit: null as string | null,
  run: null as string | null,
  set: rstest.fn(),
}));
rstest.mock("./routine-nav", () => ({
  useRoutineNav: () => [navigation, navigation.set],
}));

const run = (fields: Partial<RunView> & { id: string }): RunView => ({
  routineId: "r1",
  startedBy: "schedule",
  status: "sent",
  startedAt: Date.now() - 3_600_000,
  finishedAt: Date.now() - 3_590_000,
  title: "今日要闻",
  sessionId: "s1",
  report: "# 今日\n\n三条新闻",
  handoff: null,
  error: null,
  seenAt: null,
  feedback: [],
  ...fields,
});

const info = routineInfo({
  id: "r1",
  name: "日报",
  model: "p:m",
  nextRunAt: Date.now() + 3_600_000,
});

function open(
  sections = routineSections(info, { runs: [run({ id: "run1" })] }),
) {
  const host = productHost({ routines: [sections] });
  for (const action of [
    "update",
    "run",
    "seen",
    "feedback",
    "restoreBrief",
    "create",
    "delete",
  ])
    host.handle(`routines.${action}`, () => ({
      routine: { ...sections.info, runs: [] },
      run: run({ id: "run2" }),
      feedback: {},
      brief: {},
    }));
  host.hello();
  return host;
}

const button = (c: ParentNode, text: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const callsOf = (host: ReturnType<typeof open>, action: string) =>
  host.calls.filter((c) => c.action === action).map((c) => c.args);

async function write(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.routine = null;
  navigation.edit = null;
  navigation.run = null;
  navigation.set.mockClear();
});

describe("creating and editing a routine", () => {
  it("creates one with no model of its own, and opens it", async () => {
    navigation.edit = "new";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    // The model is optional: the settings' own choice is the default.
    expect(container.querySelector("#routine-model")?.textContent).toContain(
      "默认模型",
    );
    await write(container.querySelector("#routine-name")!, "周报");
    await write(container.querySelector("#routine-brief")!, "整理本周");
    await submit(container.querySelector("form")!);
    await flush();
    expect(callsOf(host, "create")).toEqual([
      {
        name: "周报",
        brief: "整理本周",
        model: null,
        schedule: { kind: "daily", time: "08:00" },
        timezone: expect.any(String),
      },
    ]);
    expect(navigation.set).toHaveBeenCalledWith({ edit: null, routine: "r1" });
  });

  it("edits one: a new brief is sent with the rest, in the routine's own words", async () => {
    navigation.edit = "r1";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(
      container.querySelector<HTMLInputElement>("#routine-name")!.value,
    ).toBe("日报");
    expect(
      container.querySelector<HTMLTextAreaElement>("#routine-brief")!.value,
    ).toBe("说点什么");
    await write(container.querySelector("#routine-brief")!, "说点别的");
    await submit(container.querySelector("form")!);
    await flush();
    expect(callsOf(host, "update")).toEqual([
      {
        routineId: "r1",
        name: "日报",
        brief: "说点别的",
        model: "p:m",
        schedule: { kind: "daily", time: "08:00" },
        timezone: "Asia/Shanghai",
      },
    ]);
    expect(navigation.set).toHaveBeenCalledWith({ edit: null });
  });
});

describe("a routine's page", () => {
  it("runs now and pauses", async () => {
    navigation.routine = "r1";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    await click(container.querySelector('button[aria-label="立即运行"]'));
    await click(container.querySelector('button[role="switch"]'));
    await flush();
    expect(callsOf(host, "run")).toEqual([{ routineId: "r1" }]);
    expect(callsOf(host, "update")).toEqual([
      { routineId: "r1", enabled: false },
    ]);
  });

  it("does not offer another run while one is going", async () => {
    navigation.routine = "r1";
    open(
      routineSections(info, {
        runs: [run({ id: "run1", status: "running", finishedAt: null })],
      }),
    );
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="立即运行"]',
      )!.disabled,
    ).toBe(true);
  });

  it("marks what it has not shown as seen, once, and not what it has", async () => {
    navigation.routine = "r1";
    const host = open(
      routineSections(
        { ...info, unseenReports: 1 },
        { runs: [run({ id: "run1" })] },
      ),
    );
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(callsOf(host, "seen")).toEqual([{ routineId: "r1" }]);
    // The host pushes the cleared counts; the page does not ask again.
    await act(async () =>
      host.set("routines.r1", {
        ...routineSections(info, { runs: [run({ id: "run1" })] }),
      }),
    );
    await flush();
    expect(callsOf(host, "seen")).toHaveLength(1);
    expect(container.textContent).toContain("日报");
  });

  it("says a run that found nothing new in the routine's words", async () => {
    navigation.routine = "r1";
    open(
      routineSections(info, {
        runs: [
          run({ id: "run1", status: "no_news", title: null, report: null }),
        ],
      }),
    );
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).toContain("没有新内容");
  });

  it("restores an old version of the brief as the newest", async () => {
    navigation.routine = "r1";
    const host = open(
      routineSections(info, {
        briefs: [
          { version: 2, text: "新的", createdAt: 3000, feedback: "短一点" },
          { version: 1, text: "旧的", createdAt: 1000, feedback: null },
        ],
      }),
    );
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).toContain("新的");
    await click(button(container, "恢复"));
    await flush();
    expect(callsOf(host, "restoreBrief")).toEqual([
      { routineId: "r1", version: 1 },
    ]);
  });
});

describe("a routine's report", () => {
  it("sends feedback on it, and follows the brief being revised", async () => {
    navigation.routine = "r1";
    navigation.run = "run1";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).toContain("三条新闻");
    await write(container.querySelector("textarea")!, "少一点");
    await submit(container.querySelector("form")!);
    await flush();
    expect(callsOf(host, "feedback")).toEqual([
      { routineId: "r1", runId: "run1", text: "少一点" },
    ]);

    const feedback = (briefVersion: number | null, revisionFailed = false) =>
      routineSections(info, {
        runs: [
          run({
            id: "run1",
            feedback: [
              {
                id: "f1",
                runId: "run1",
                text: "少一点",
                createdAt: Date.now(),
                briefVersion,
                revisionFailed,
              },
            ],
          }),
        ],
      });
    // No version and no failure yet: it is being revised.
    await act(async () => host.set("routines.r1", { ...feedback(null) }));
    expect(container.textContent).toContain("修订要求中…");
    await act(async () => host.set("routines.r1", { ...feedback(2) }));
    expect(container.textContent).toContain("要求已更新为 v2");
    await act(async () => host.set("routines.r1", { ...feedback(null, true) }));
    expect(container.textContent).toContain("没能据此修订要求");
  });
});
