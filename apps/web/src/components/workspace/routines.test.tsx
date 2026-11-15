import type { RunView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost, routineInfo, routineSections } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { RoutineBoard } from "./routine-board";
import { viewerTimeZone } from "./routine-format";

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
  error: null,
  seenAt: null,
  feedback: [],
  ...fields,
});

const info = routineInfo({
  id: "r1",
  name: "日报",
  nextRunAt: Date.now() + 3_600_000,
});

const PROVIDERS = {
  revision: "r1",
  providers: [
    {
      id: "p",
      name: "P",
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      hasApiKey: true,
      models: [
        { id: "m", name: "M" },
        { id: "n", name: "N" },
      ],
    },
  ],
};

function open(
  sections = routineSections(info, { runs: [run({ id: "run1" })] }),
  providers: { revision: string; providers: unknown[] } = PROVIDERS,
) {
  const host = buildProductHost({ routines: [sections] }, ["providers"]).target(
    "providers",
    { config: providers },
    { eager: true },
  );
  host.install();
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
  it("creates one from a name, a brief and a time, with no agent or model to pick, and opens it", async () => {
    navigation.edit = "new";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    // A routine is Captain's: there is nothing to choose about who runs it.
    expect(container.querySelector("#routine-model")).toBeNull();
    expect(container.textContent).toContain("由 Captain 执行");
    await write(container.querySelector("#routine-name")!, "周报");
    await write(container.querySelector("#routine-brief")!, "整理本周");
    await submit(container.querySelector("form")!);
    await flush();
    expect(callsOf(host, "create")).toEqual([
      {
        name: "周报",
        brief: "整理本周",
        schedule: { kind: "daily", time: "08:00" },
        timezone: expect.any(String),
      },
    ]);
    expect(navigation.set).toHaveBeenCalledWith({ edit: null, routine: "r1" });
  });

  it("cannot be created without a brief", async () => {
    navigation.edit = "new";
    const host = open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    await write(container.querySelector("#routine-name")!, "周报");
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(true);
    await submit(container.querySelector("form")!);
    await flush();
    expect(callsOf(host, "create")).toEqual([]);
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

  it("says why a skipped run did not happen", async () => {
    navigation.routine = "r1";
    open(
      routineSections(info, {
        runs: [
          run({
            id: "run1",
            status: "skipped",
            title: null,
            report: null,
            sessionId: null,
            error:
              "Captain is off (its supervisor is switched off), so this run did not happen.",
          }),
        ],
      }),
    );
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).toContain("已跳过：Captain 已关闭");
    expect(container.querySelector('[title^="Captain is off"]')).not.toBeNull();
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

describe("while Captain is off", () => {
  it("says so at the top of the page, and turns Captain back on from there", async () => {
    const host = buildProductHost(
      {
        routines: [routineSections(info)],
        routinesStatus: { captainOn: false, reason: "supervisor_off" },
      },
      ["captain"],
    );
    host.install();
    host.handle("captain.setSetting", () => ({ setting: {} }));
    host.hello();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("Captain 已关闭，定时任务不会运行");
    expect(notice.textContent).toContain("不会补跑");
    await click(button(container, "打开 Captain"));
    await flush();
    expect(
      host.calls.filter((c) => c.action === "setSetting").map((c) => c.args),
    ).toEqual([{ key: "supervisorEnabled", value: true }]);
  });

  it("says nothing while Captain is on", async () => {
    open();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).not.toContain("Captain 已关闭");
  });

  it("names a missing model, with no switch to press", async () => {
    const host = buildProductHost({
      routines: [routineSections(info)],
      routinesStatus: { captainOn: false, reason: "no_model" },
    });
    host.install();
    host.hello();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(container.textContent).toContain("Captain 还没有配置模型");
    expect(button(container, "打开 Captain")).toBeUndefined();
  });
});

describe("a row of the list", () => {
  const zone = viewerTimeZone();
  const rows = () => [
    routineSections(
      routineInfo({
        id: "a",
        name: "下次",
        timezone: zone,
        nextRunAt: Date.now() + 20.5 * 3_600_000,
      }),
    ),
    routineSections(
      routineInfo({
        id: "b",
        name: "运行",
        timezone: zone,
        schedule: { kind: "hourly", every: 2 },
        nextRunAt: Date.now() + 3_600_000,
      }),
      {
        runs: [
          run({
            id: "x",
            routineId: "b",
            status: "running",
            startedAt: Date.now() - 125_000,
            finishedAt: null,
          }),
        ],
      },
    ),
    routineSections(
      routineInfo({
        id: "c",
        name: "暂停",
        timezone: zone,
        enabled: false,
        nextRunAt: null,
      }),
    ),
    routineSections(
      routineInfo({ id: "d", name: "结束", timezone: zone, nextRunAt: null }),
    ),
  ];
  const row = (c: ParentNode, name: string) =>
    [...c.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith(name),
    )!;

  it("puts the name and runs on top, the schedule and the next run below", async () => {
    const host = buildProductHost({ routines: rows() });
    host.install();
    host.hello();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(row(container, "下次").textContent).toBe(
      "下次每天 08:00下次 · 20 小时后",
    );
    expect(row(container, "下次").querySelector('[role="img"]')).not.toBeNull();
    expect(row(container, "运行").textContent).toBe(
      "运行每 2 小时运行中 · 2 分钟",
    );
    expect(row(container, "暂停").textContent).toBe("暂停每天 08:00已暂停");
    expect(row(container, "结束").textContent).toBe("结束每天 08:00不会再运行");
  });

  it("promises no time while Captain is off", async () => {
    const host = buildProductHost({
      routines: rows(),
      routinesStatus: { captainOn: false, reason: "supervisor_off" },
    });
    host.install();
    host.hello();
    const { container } = await mount(<RoutineBoard />);
    await flush();
    expect(row(container, "下次").textContent).toBe(
      "下次每天 08:00Captain 已关闭",
    );
    // A paused one is still paused, and a running one still running.
    expect(row(container, "暂停").textContent).toContain("已暂停");
    expect(row(container, "运行").textContent).toContain("运行中");
    // One that will never run again says so, whether Captain is on or not.
    expect(row(container, "结束").textContent).toContain("不会再运行");
  });
});
