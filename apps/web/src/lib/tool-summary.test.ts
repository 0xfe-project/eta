import { describe, expect, it } from "@rstest/core";
import { summarizeArgs } from "./tool-summary";

describe("工具调用的一句话摘要", () => {
  it("优先引用命令、路径这类人真正在看的参数", () => {
    expect(summarizeArgs({ command: "bun test", timeout: 30000 })).toBe(
      "bun test",
    );
    expect(summarizeArgs({ path: "src/app.ts", offset: 10 })).toBe(
      "src/app.ts",
    );
  });

  it("没有偏好字段时取第一个字符串值", () => {
    expect(summarizeArgs({ note: "记一笔", count: 3 })).toBe("记一笔");
  });

  it("不是对象也能用", () => {
    expect(summarizeArgs("纯字符串")).toBe("纯字符串");
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs({ count: 3 })).toBe("");
  });

  it("六十个字之后截断，换行压成空格", () => {
    expect(summarizeArgs({ command: "a\nb" })).toBe("a b");
    const long = summarizeArgs({ command: "x".repeat(200) });
    expect(long).toHaveLength(61);
    expect(long.endsWith("…")).toBe(true);
  });
});
