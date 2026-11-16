import type { AcpAgentView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { AcpSettings } from "./acp-settings";

const toasts = rstest.hoisted(() => ({
  message: rstest.fn(),
  success: rstest.fn(),
  error: rstest.fn(),
}));
rstest.mock("sonner", () => ({
  toast: Object.assign(toasts.message, {
    success: toasts.success,
    error: toasts.error,
  }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  toasts.message.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const text = () => document.body.textContent ?? "";

async function type(id: string, value: string) {
  const input = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A field of the open dialog by its label. */
const fieldId = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("[role=dialog] label")].find(
    (element) => element.textContent === label,
  )!.htmlFor;
const fill = (label: string, value: string) => type(fieldId(label), value);
const value = (label: string) =>
  (document.getElementById(fieldId(label)) as HTMLInputElement).value;

const byText = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
const labelled = (name: string) =>
  document.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
const dialog = () => document.querySelector("[role=dialog]");
const alerts = () =>
  [...document.querySelectorAll("[role=dialog] [role=alert]")].map(
    (alert) => alert.textContent,
  );
const submit = async () => {
  await act(async () => {
    dialog()!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
};

const view = (
  fields: Partial<AcpAgentView> & { id: string },
): AcpAgentView => ({
  label: fields.id,
  command: "demo-agent",
  args: [],
  env: {},
  runtime: `acp.${fields.id}`,
  status: "available",
  ...fields,
});

function host(list: AcpAgentView[]) {
  const fake = buildProductHost({}, ["acp"]).target("acp", { list });
  fake.install();
  fake.hello();
  return fake;
}

describe("Settings → External agents", () => {
  it("lists each agent with its runtime id, status, version and detail", async () => {
    host([
      view({
        id: "demo",
        label: "Demo",
        args: ["--acp"],
        version: "1.2.0",
        autoAllow: true,
      }),
      view({
        id: "gem",
        label: "Gem",
        status: "unauthenticated",
        detail: "run `gem login`",
      }),
      view({ id: "gone", label: "Gone", status: "missing" }),
    ]);
    await mount(<AcpSettings />);
    await flush();
    expect(text()).toContain("acp.demo");
    expect(text()).toContain("demo-agent --acp");
    expect(text()).toContain("可用");
    expect(text()).toContain("1.2.0");
    expect(text()).toContain("自动允许");
    expect(text()).toContain("未登录");
    expect(text()).toContain("run `gem login`");
    expect(text()).toContain("未安装");
  });

  it("says when there are none", async () => {
    host([]);
    await mount(<AcpSettings />);
    await flush();
    expect(text()).toContain("还没有外部 Agent");
  });

  it("shows loading until the list comes, and an error when the host has no such target", async () => {
    const fake = buildProductHost({}, []);
    fake.install();
    await mount(<AcpSettings />);
    expect(byText("添加 Agent")?.disabled).toBe(true);
    await act(async () => fake.hello());
    await flush();
    // Not mounted on this host: said, and nothing to add to.
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "外部 Agent",
    );
    expect(byText("添加 Agent")).toBeUndefined();
  });

  it("shows a file the host cannot read as an error with its path, not an empty list, and offers no edits", async () => {
    const fake = buildProductHost({}, ["acp"]).target("acp", {
      error: {
        message:
          "/home/me/.eta/acp.json is not valid JSON: Unexpected comma. Fix the file by hand; nothing is changed until it reads.",
      },
    });
    fake.install();
    fake.hello();
    await mount(<AcpSettings />);
    await flush();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "/home/me/.eta/acp.json is not valid JSON",
    );
    expect(text()).not.toContain("还没有外部 Agent");
    expect(byText("添加 Agent")).toBeUndefined();
  });

  it("adds an agent: the id follows the name, args and env one per line, and the list refreshes", async () => {
    const fake = host([]);
    fake.handle("acp.save", (args) => {
      const { agent } = args as { agent: AcpAgentView };
      const saved = view({ ...agent, version: "0.1.0" });
      fake.set("acp", { list: [saved] });
      return saved;
    });
    await mount(<AcpSettings />);
    await flush();
    await click(byText("添加 Agent"));
    await fill("名称", "My Demo Agent");
    expect(value("ID")).toBe("my-demo-agent");
    expect(text()).toContain("acp.my-demo-agent");
    await fill("命令", " npx ");
    await fill("参数", "-y\n\n@example/agent \n--acp");
    await fill("环境变量", "API_KEY=a=b\n# a comment\nDEBUG=1");
    await fill("工作目录", "  ");
    await submit();
    expect(fake.calls.at(-1)).toEqual({
      target: "acp",
      action: "save",
      args: {
        agent: {
          id: "my-demo-agent",
          label: "My Demo Agent",
          command: "npx",
          args: ["-y", "@example/agent", "--acp"],
          env: { API_KEY: "a=b", DEBUG: "1" },
          autoAllow: false,
        },
      },
    });
    expect(dialog()).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("已保存 My Demo Agent");
    expect(text()).toContain("acp.my-demo-agent");
    expect(text()).toContain("0.1.0");
  });

  it("checks the draft in place: required fields, the id's form, a taken id, and env lines", async () => {
    const fake = host([view({ id: "demo" })]);
    await mount(<AcpSettings />);
    await flush();
    await click(byText("添加 Agent"));
    await submit();
    expect(alerts()).toEqual([
      "请填写名称。",
      "请填写 ID。",
      "请填写启动它的命令。",
    ]);

    await fill("名称", "Demo");
    await fill("命令", "demo");
    await submit();
    // The id the name gave is another agent's.
    expect(alerts()).toEqual(["已有外部 Agent 使用这个 ID。"]);

    for (const id of ["Demo", "-demo", "de_mo"]) {
      await fill("ID", id);
      await submit();
      expect(alerts()).toEqual([
        "只能用小写字母、数字和连字符，并以字母或数字开头。",
      ]);
    }
    // Typed by hand, the id no longer follows the name.
    await fill("名称", "Something else");
    expect(value("ID")).toBe("de_mo");

    await fill("ID", "demo2");
    await fill("环境变量", "OK=1\nNOT A PAIR");
    await submit();
    expect(alerts()).toEqual(["第 2 行：请写成 KEY=VALUE。"]);
    await fill("环境变量", "=x");
    await submit();
    expect(alerts()).toEqual(["第 1 行：= 前面的变量名是空的。"]);
    await fill("环境变量", "A=1\nA=2");
    await submit();
    expect(alerts()).toEqual(["第 2 行：这个变量上面已经设置过。"]);
    expect(fake.calls.filter((call) => call.action === "save")).toEqual([]);
  });

  it("shows the host's refusal and keeps the form", async () => {
    const fake = host([]);
    fake.handle("acp.save", () => {
      throw new Error("command not found: nope");
    });
    await mount(<AcpSettings />);
    await flush();
    await click(byText("添加 Agent"));
    await fill("名称", "Nope");
    await fill("命令", "nope");
    await submit();
    expect(alerts()).toEqual(["没有保存：command not found: nope"]);
    expect(value("命令")).toBe("nope");
  });

  it("edits an agent, sending the old id when the id changes", async () => {
    const fake = host([
      view({
        id: "demo",
        label: "Demo",
        args: ["--acp"],
        env: { A: "1" },
        cwd: "/srv",
        autoAllow: true,
        version: "1.0",
      }),
      view({ id: "other" }),
    ]);
    fake.handle("acp.save", (args) =>
      view((args as { agent: AcpAgentView }).agent),
    );
    await mount(<AcpSettings />);
    await flush();
    await click(labelled("编辑 Demo"));
    expect(value("名称")).toBe("Demo");
    expect(value("ID")).toBe("demo");
    expect(value("参数")).toBe("--acp");
    expect(value("环境变量")).toBe("A=1");
    expect(value("工作目录")).toBe("/srv");
    // Its own id is not taken; another's is.
    await fill("ID", "other");
    await submit();
    expect(alerts()).toEqual(["已有外部 Agent 使用这个 ID。"]);
    // Renaming the label of an existing agent leaves its id alone.
    await fill("ID", "demo");
    await fill("名称", "Demo Two");
    expect(value("ID")).toBe("demo");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: {
        agent: { id: "demo", label: "Demo Two", cwd: "/srv", autoAllow: true },
      },
    });
    expect(
      (fake.calls.at(-1)!.args as Record<string, unknown>).previousId,
    ).toBeUndefined();

    await click(labelled("编辑 Demo"));
    await fill("ID", "demo-renamed");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: { agent: { id: "demo-renamed" }, previousId: "demo" },
    });
  });

  it("deletes only after it is confirmed, and reports a refusal", async () => {
    const fake = host([view({ id: "demo", label: "Demo" })]);
    let refuse = true;
    fake.handle("acp.delete", () => {
      if (refuse) throw new Error("still used by: Ada, Bob");
      fake.set("acp", { list: [] });
      return {};
    });
    await mount(<AcpSettings />);
    await flush();
    await click(labelled("删除 Demo"));
    expect(text()).toContain("删除 Demo？");
    expect(fake.calls.filter((call) => call.action === "delete")).toEqual([]);
    await click(
      byText(
        "删除",
        [...document.querySelectorAll("[role=alertdialog]")].at(-1)!,
      ),
    );
    expect(fake.calls.at(-1)).toMatchObject({
      action: "delete",
      args: { id: "demo" },
    });
    expect(toasts.error).toHaveBeenCalledWith("still used by: Ada, Bob");

    refuse = false;
    await flush();
    await click(labelled("删除 Demo"));
    await click(
      byText(
        "删除",
        [...document.querySelectorAll("[role=alertdialog]")].at(-1)!,
      ),
    );
    expect(toasts.message).toHaveBeenCalledWith("已删除 Demo");
    expect(text()).toContain("还没有外部 Agent");
  });

  it("tests a saved agent and an unsaved draft", async () => {
    const fake = host([
      view({ id: "demo", label: "Demo", version: "1.0", detail: "old" }),
    ]);
    fake.handle("acp.test", (args) => {
      const { agent } = args as { agent: AcpAgentView };
      return agent.id === "demo"
        ? {
            ok: true,
            status: "available",
            agentName: "demo-agent",
            version: "1.1",
          }
        : { ok: false, status: "missing", detail: "spawn nope ENOENT" };
    });
    await mount(<AcpSettings />);
    await flush();
    await click(labelled("测试 Demo"));
    // The stored config is sent, not the listed view.
    expect(fake.calls.at(-1)).toEqual({
      target: "acp",
      action: "test",
      args: {
        agent: {
          id: "demo",
          label: "Demo",
          command: "demo-agent",
          args: [],
          env: {},
        },
      },
    });
    expect(toasts.success).toHaveBeenCalledWith(
      "Demo 有响应：demo-agent 1.1",
      undefined,
    );

    await click(byText("添加 Agent"));
    await fill("名称", "Draft");
    await fill("命令", "nope");
    await click(byText("测试", dialog()!));
    expect(fake.calls.at(-1)).toMatchObject({
      action: "test",
      args: { agent: { id: "draft", command: "nope" } },
    });
    expect(toasts.error).toHaveBeenCalledWith("Draft：未安装", {
      description: "spawn nope ENOENT",
    });
    // Testing saves nothing.
    expect(fake.calls.filter((call) => call.action === "save")).toEqual([]);
    expect(dialog()).not.toBeNull();
  });
});
