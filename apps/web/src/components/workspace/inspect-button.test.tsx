import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { button, cleanup, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { InspectButton } from "./inspect-button";

const prompt = {
  stableChars: 4600,
  adaptiveChars: 12,
  sections: [
    { name: "base", stable: true, text: "你是 eta。" },
    { name: "tasks", stable: false, text: "当前没有任务" },
  ],
};

const tools = [
  { name: "read", description: "读一个文件\n第二行是更长的说明" },
  { name: "bash", description: "跑一条命令" },
];

/** The host, with `sessions.s1` holding `sections`. */
function sessionHost(sections: Record<string, unknown>): FakeHost {
  const host = new FakeHost().target("sessions.s1", sections).install();
  host.handle("sessions.resync", () => ({}));
  host.hello();
  return host;
}

const openDialog = async (container: ParentNode) => {
  await act(async () => button(container, "Inspect")!.click());
  await flush();
  return document.body;
};

const withPrompt = {
  core: { session: "s1", running: false },
  prompt,
  tools,
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  document.body.innerHTML = "";
});

describe("成员的 Inspect", () => {
  it("列出的每一块默认折着, 但写着自己多大", async () => {
    sessionHost(withPrompt);
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    const folds = [...body.querySelectorAll("details")];
    // Two prompt blocks and both tools.
    expect(folds).toHaveLength(4);
    expect(folds.every((fold) => !fold.open)).toBe(true);
    expect(body.textContent).toContain("stable · 7");
    expect(body.textContent).toContain("adaptive · 6");
    // The count in the summary line says what is being counted.
    expect(body.textContent).toContain("2 块");
    // The header of the panel is who the session belongs to, not a bare id.
    expect(body.textContent).toContain("阿卡拉");
  });

  it("点开一块, 看到的就是发出去的那段原文", async () => {
    sessionHost(withPrompt);
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    const fold = [...body.querySelectorAll("details")][0]!;
    await act(async () => fold.querySelector("summary")!.click());
    expect(fold.open).toBe(true);
    expect(fold.querySelector("pre")!.textContent).toBe("你是 eta。");
  });

  it("原文能一键复制", async () => {
    sessionHost(withPrompt);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => copied.push(text) },
    });
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    const fold = [...body.querySelectorAll("details")][1]!;
    await act(async () => fold.querySelector("summary")!.click());
    await act(async () => fold.querySelector("button")!.click());
    expect(copied).toEqual(["当前没有任务"]);
  });

  it("视图还在路上时说读取中, 不画成有错误", async () => {
    // The session is not a target yet and `resync` has not answered: this is a read in flight,
    // and an Inspect that calls it an error teaches the reader that the panel never works.
    const host = new FakeHost().install();
    host.handle("sessions.resync", () => new Promise(() => {}));
    host.hello();
    const { container } = await mount(
      <InspectButton sessionId="s-late" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    expect(body.textContent).toContain("读取中");
    expect(body.textContent).not.toContain("错误");
    expect(host.calls.map((call) => `${call.target}.${call.action}`)).toEqual([
      "sessions.resync",
    ]);
  });

  it("宿主说没有这个会话, 才说读不到", async () => {
    const host = new FakeHost().install();
    host.handle("sessions.resync", () => {
      throw new Error("no such session");
    });
    host.hello();
    const { container } = await mount(
      <InspectButton sessionId="s-gone" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    expect(body.textContent).toContain("读不到这个会话的状态");
  });

  it("会话在、提示词还没有, 说的是没有而不是错", async () => {
    sessionHost({ core: { session: "s1", running: false } });
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    expect(body.textContent).toContain("还没有生成过提示词");
    expect(body.textContent).toContain("0 个工具");
    expect(body.querySelectorAll("details")).toHaveLength(0);
  });

  it("工具是做什么的, 不点开也看得到, 点开看到整句", async () => {
    sessionHost(withPrompt);
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    expect(body.textContent).toContain("读一个文件");
    expect(body.textContent).toContain("跑一条命令");
    // Both fold. A description written on one line is clipped in the header, and the fold is the
    // only place the whole of it can be read or copied.
    const folds = [...body.querySelectorAll("details")];
    expect(folds).toHaveLength(4);
    const bash = folds[3]!;
    await act(async () => bash.querySelector("summary")!.click());
    expect(bash.querySelector("pre")!.textContent).toBe("跑一条命令");
  });

  it("宿主比这一页老、块里没有 text 时, 画空的一块而不是白屏", async () => {
    sessionHost({
      core: { session: "s1", running: false },
      prompt: {
        stableChars: 0,
        adaptiveChars: 0,
        sections: [{ name: "base", stable: true }],
      },
      tools: [{ name: "bash" }],
    });
    const { container } = await mount(
      <InspectButton sessionId="s1" name="阿卡拉" />,
    );
    const body = await openDialog(container);
    expect(body.textContent).toContain("base");
    expect(body.textContent).toContain("stable · 0");
    expect(body.textContent).toContain("bash");
  });
});
