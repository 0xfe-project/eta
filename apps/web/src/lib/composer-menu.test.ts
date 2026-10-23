import { describe, expect, it } from "@rstest/core";
import {
  applyItem,
  buildMenu,
  fuzzyScore,
  hashAt,
  mentionAt,
  slashAt,
  splitCommand,
} from "./composer-menu";

const members = [
  { id: "a1", name: "乐子人", busy: false },
  { id: "a2", name: "装配检查", busy: true },
];
const files = [
  "src/app/main.ts",
  "src/index.ts",
  "README.md",
  "src/app/menu.ts",
];
const commands = [
  { name: "/compact", description: "压缩" },
  { name: "/goal", description: "设定目标" },
  { name: "/stop", description: "停止" },
];
const tasks = [
  {
    number: 10,
    title: "整理发布说明",
    status: "in_progress",
    conversationId: "g1",
    updatedAt: 100,
  },
  {
    number: 11,
    title: "修复登录超时",
    status: "todo",
    conversationId: "g1",
    updatedAt: 300,
  },
  {
    number: 12,
    title: "重建站点",
    status: "done",
    conversationId: "g2",
    updatedAt: 900,
  },
  {
    number: 21,
    title: "归档旧群",
    status: "backlog",
    conversationId: null,
    updatedAt: 50,
  },
];

const menu = (text: string, dismissed = false, groupId = "g1") =>
  buildMenu({ text, members, files, commands, tasks, groupId, dismissed });
const noGroup = (text: string) =>
  buildMenu({ text, members, files, commands, tasks, dismissed: false });
/** The task numbers in the menu, in the order the rows will show them. */
const numbers = (state: ReturnType<typeof menu>) =>
  state!.items.flatMap((item) => (item.kind === "task" ? [item.number] : []));

describe("@ 的补全", () => {
  it("是群里的人先出现，然后才是文件", () => {
    const state = menu("@")!;
    expect(state.kind).toBe("at");
    expect(state.items.map((item) => item.kind).slice(0, 2)).toEqual([
      "member",
      "member",
    ]);
    expect(state.items.some((item) => item.kind === "file")).toBe(true);
  });

  it("说了名字就只剩那个人", () => {
    const state = menu("@乐")!;
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.label).toBe("乐子人");
  });

  it("能按路径找文件，路径的边界比中间的字更值钱", () => {
    const state = menu("@main")!;
    const labels = state.items.map((item) => item.label);
    expect(labels).toContain("src/app/main.ts");
    expect(fuzzyScore("main", "src/app/main.ts")).toBeGreaterThan(
      fuzzyScore("main", "src/domain/index.ts"),
    );
  });

  it("中文句子后面紧跟一个 @ 也算（中文没有空格）", () => {
    expect(mentionAt("看一下，@乐")).toEqual({ query: "乐", start: 4 });
    expect(mentionAt("nothing here")).toBeNull();
  });

  it("选中之后只在原位替换那段，别处一个字不动", () => {
    const state = mentionAt("看看 @src/app/m");
    expect(state).not.toBeNull();
    const replaced = applyItem(
      "看看 @src/app/m",
      { kind: "at", query: "src/app/m", start: 3, items: [] },
      { kind: "file", value: "@src/app/main.ts ", label: "src/app/main.ts" },
    );
    expect(replaced.text).toBe("看看 @src/app/main.ts ");
  });
});

describe("# 的任务", () => {
  it("句首一个 # 就开菜单，里面只有任务", () => {
    const state = menu("#")!;
    expect(state.kind).toBe("hash");
    expect(state.start).toBe(0);
    expect(state.items.every((item) => item.kind === "task")).toBe(true);
    expect(state.items).toHaveLength(4);
  });

  it("中文句子后面紧跟一个 # 也算（和 @ 一样的边界）", () => {
    expect(hashAt("看一下，#1")).toEqual({ query: "1", start: 4 });
    const state = menu("看一下，#1")!;
    expect(state.start).toBe(4);
    expect(state.items.map((item) => item.value)).toEqual([
      "#11 ",
      "#10 ",
      "#12 ",
    ]);
  });

  it("C#、F#、句中的 # 不开菜单，# 后面跟上空格也不开", () => {
    expect(hashAt("C#")).toBeNull();
    expect(hashAt("写 F# 那个服务")).toBeNull();
    expect(hashAt("用#1")).toBeNull();
    expect(hashAt("# ")).toBeNull();
    expect(hashAt("用 # 一下")).toBeNull();
    expect(hashAt("##")).toBeNull();
    expect(menu("C# 好用")).toBeNull();
  });

  it("能按号也能按标题过滤", () => {
    expect(menu("#2")!.items.map((item) => item.label)).toEqual(["归档旧群"]);
    expect(menu("#登录")!.items.map((item) => item.label)).toEqual([
      "修复登录超时",
    ]);
    expect(menu("#发布")!.items.map((item) => item.label)).toEqual([
      "整理发布说明",
    ]);
  });

  it("本群的任务先列，然后才轮到别的，新动的在前", () => {
    // #12 是最新动的一个，但它在另一个群，所以排在本群之后。
    expect(numbers(menu("#"))).toEqual([11, 10, 12, 21]);
  });

  it("不在群里写（没有当前群）时只按时间排", () => {
    expect(numbers(noGroup("#"))).toEqual([12, 11, 10, 21]);
  });

  it("最多八行，而且每行带着号、标题和状态", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      number: index + 1,
      title: `任务 ${index + 1}`,
      status: "todo",
      conversationId: "g1",
      updatedAt: index,
    }));
    const state = buildMenu({
      text: "#",
      members,
      files,
      commands,
      tasks: many,
      groupId: "g1",
      dismissed: false,
    })!;
    expect(state.items).toHaveLength(8);
    const first = state.items[0]!;
    expect(first).toMatchObject({
      kind: "task",
      value: "#12 ",
      label: "任务 12",
      number: 12,
      status: "todo",
    });
  });

  it("选中之后只替掉 # 那一段，结尾带一个空格", () => {
    const text = "先聊 #1";
    const state = hashAt(text);
    expect(state).not.toBeNull();
    const replaced = applyItem(
      text,
      { kind: "hash", query: "1", start: state!.start, items: [] },
      {
        kind: "task",
        value: "#10 ",
        label: "整理发布说明",
        number: 10,
        status: "in_progress",
      },
    );
    expect(replaced.text).toBe("先聊 #10 ");
  });
});

describe("/ 的命令", () => {
  it("只有整段草稿是一个 /名称 时才当命令", () => {
    expect(slashAt("/go")).toEqual({ query: "go", start: 0 });
    // A slash in a sentence is a slash.
    expect(slashAt("/goal ship it")).toBeNull();
    expect(slashAt("看这个 /goal")).toBeNull();
    expect(slashAt("//not-a-command")).toBeNull();
  });

  it("按前缀过滤，不是按包含", () => {
    const state = menu("/go")!;
    expect(state.items.map((item) => item.label)).toEqual(["/goal"]);
  });

  it("命令可以带参数", () => {
    expect(splitCommand("/goal ship the release")).toEqual({
      name: "/goal",
      args: "ship the release",
    });
    expect(splitCommand("/stop")).toEqual({ name: "/stop", args: "" });
    expect(splitCommand("hello")).toBeNull();
  });

  it("Escape 关掉之后，菜单在再次输入之前不回来", () => {
    expect(menu("@", true)).toBeNull();
    expect(menu("@")).not.toBeNull();
  });
});
