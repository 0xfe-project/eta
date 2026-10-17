import { describe, expect, it } from "@rstest/core";
import {
  applyItem,
  buildMenu,
  fuzzyScore,
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

const menu = (text: string, dismissed = false) =>
  buildMenu({ text, members, files, commands, dismissed });

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
