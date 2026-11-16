import type {
  AcpAgentView,
  AcpMachineList,
  MachineView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost, machineView } from "@/test-product";
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

const PRIMARY = machineView({ id: "m-primary", name: "studio" });
const BOX = machineView({ id: "m-box", kind: "daemon", name: "box" });
const ATTIC = machineView({
  id: "m-attic",
  kind: "daemon",
  name: "attic",
  status: "offline",
});

/**
 * A host with these machines (the primary alone by default) and these lists by machine id; the
 * primary's is `list`. `acp.refresh` answers with what the section holds.
 */
function host(
  list: AcpAgentView[],
  {
    machines = [PRIMARY],
    lists = {},
  }: {
    machines?: MachineView[];
    lists?: Record<string, AcpMachineList>;
  } = {},
) {
  const fake = buildProductHost({ machines }, ["acp"]).target("acp", {
    machines: { [PRIMARY.id]: { agents: list }, ...lists },
  });
  fake.handle("acp.refresh", (args) => {
    const { machineId } = args as { machineId: string };
    return { machineId };
  });
  fake.install();
  fake.hello();
  return fake;
}

/** Replace the lists the host publishes. */
const publish = (
  fake: ReturnType<typeof host>,
  lists: Record<string, AcpMachineList>,
) => fake.set("acp", { machines: lists });

/** Choose a machine in the selector at the top. */
async function chooseMachine(name: string) {
  await click(document.querySelector<HTMLButtonElement>('[role="combobox"]')!);
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.startsWith(name))!;
  await click(option as unknown as HTMLButtonElement);
  await flush();
}

describe("Settings → External agents", () => {
  it("lists each agent with its runtime id, status, version and detail", async () => {
    host([
      view({
        id: "demo",
        label: "Demo",
        args: ["--acp"],
        version: "1.2.0",
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
    // No auto-allow badge: every permission request is answered yes.
    expect(text()).not.toContain("自动允许");
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
    const fake = buildProductHost({ machines: [PRIMARY] }, []);
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
    host([], {
      lists: {
        [PRIMARY.id]: {
          error:
            "/home/me/.eta/acp.json is not valid JSON: Unexpected comma. Fix the file by hand; nothing is changed until it reads.",
        },
      },
    });
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
      publish(fake, { [PRIMARY.id]: { agents: [saved] } });
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
    // Neither a working directory nor auto-allow is asked for.
    expect(
      [...document.querySelectorAll("[role=dialog] label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["名称", "ID", "命令", "参数", "环境变量"]);
    expect(dialog()!.querySelector("[role=switch]")).toBeNull();
    await submit();
    expect(fake.calls.at(-1)).toEqual({
      target: "acp",
      action: "save",
      args: {
        machineId: PRIMARY.id,
        agent: {
          id: "my-demo-agent",
          label: "My Demo Agent",
          command: "npx",
          args: ["-y", "@example/agent", "--acp"],
          env: { API_KEY: "a=b", DEBUG: "1" },
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
    expect(alerts()).toEqual(["这台机器上已有外部 Agent 使用这个 ID。"]);

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
    // Its own id is not taken; another's is.
    await fill("ID", "other");
    await submit();
    expect(alerts()).toEqual(["这台机器上已有外部 Agent 使用这个 ID。"]);
    // Renaming the label of an existing agent leaves its id alone.
    await fill("ID", "demo");
    await fill("名称", "Demo Two");
    expect(value("ID")).toBe("demo");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: {
        machineId: PRIMARY.id,
        agent: { id: "demo", label: "Demo Two" },
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
      publish(fake, { [PRIMARY.id]: { agents: [] } });
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
      args: { machineId: PRIMARY.id, id: "demo" },
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
        machineId: PRIMARY.id,
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

describe("Settings → External agents, one machine at a time", () => {
  it("starts on the primary, lists every daemon, and marks the offline one", async () => {
    host([view({ id: "demo", label: "Demo" })], {
      machines: [BOX, PRIMARY, ATTIC],
    });
    await mount(<AcpSettings />);
    await flush();
    const trigger = document.querySelector('[role="combobox"]')!;
    expect(trigger.textContent).toContain("studio（主机器）");
    expect(text()).toContain("acp.demo");
    await click(trigger as HTMLButtonElement);
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual(["studio（主机器）", "box", "attic · 离线"]);
  });

  it("lists, adds, tests and deletes on the chosen daemon, naming it in every call", async () => {
    const fake = host([view({ id: "demo", label: "Demo" })], {
      machines: [PRIMARY, BOX],
    });
    fake.handle("acp.refresh", (args) => {
      const { machineId } = args as { machineId: string };
      if (machineId === BOX.id)
        publish(fake, {
          [PRIMARY.id]: { agents: [view({ id: "demo", label: "Demo" })] },
          [BOX.id]: { agents: [view({ id: "far", label: "Far" })] },
        });
      return {};
    });
    fake.handle("acp.save", (args) =>
      view((args as { agent: AcpAgentView }).agent),
    );
    fake.handle("acp.test", () => ({ ok: true, status: "available" }));
    fake.handle("acp.delete", () => ({}));
    await mount(<AcpSettings />);
    await flush();
    await chooseMachine("box");
    expect(fake.calls).toContainEqual({
      target: "acp",
      action: "refresh",
      args: { machineId: BOX.id },
    });
    expect(text()).toContain("acp.far");
    expect(text()).not.toContain("acp.demo");

    await click(labelled("测试 Far"));
    expect(fake.calls.at(-1)).toMatchObject({
      action: "test",
      args: { machineId: BOX.id, agent: { id: "far" } },
    });

    // The primary has `demo`; on this machine the id is free.
    await click(byText("添加 Agent"));
    expect(dialog()!.textContent).toContain("在 box 上");
    await fill("名称", "Demo");
    await fill("命令", "demo");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: { machineId: BOX.id, agent: { id: "demo" } },
    });

    // Its own ids are taken.
    await click(byText("添加 Agent"));
    await fill("名称", "Far");
    await fill("命令", "far");
    await submit();
    expect(alerts()).toEqual(["这台机器上已有外部 Agent 使用这个 ID。"]);
    await click(byText("取消", dialog()!));

    await click(labelled("删除 Far"));
    await click(
      byText(
        "删除",
        [...document.querySelectorAll("[role=alertdialog]")].at(-1)!,
      ),
    );
    expect(fake.calls.at(-1)).toMatchObject({
      action: "delete",
      args: { machineId: BOX.id, id: "far" },
    });
  });

  it("keeps an offline daemon chosen and says so, showing nothing of the primary's", async () => {
    const fake = host([view({ id: "demo", label: "Demo" })], {
      machines: [PRIMARY, ATTIC],
    });
    await mount(<AcpSettings />);
    await flush();
    await chooseMachine("attic");
    expect(document.querySelector('[role="combobox"]')!.textContent).toContain(
      "attic",
    );
    expect(document.querySelector("[role=status]")?.textContent).toBe(
      "attic 目前离线。它重新上线之前，无法列出或修改它的外部 Agent。",
    );
    expect(text()).not.toContain("acp.demo");
    expect(byText("添加 Agent")?.disabled).toBe(true);
    // An offline machine is not asked.
    expect(
      fake.calls.filter((call) => call.action === "refresh"),
    ).not.toContainEqual(
      expect.objectContaining({ args: { machineId: ATTIC.id } }),
    );
  });

  it("stays on a daemon that goes offline", async () => {
    const fake = host([view({ id: "demo", label: "Demo" })], {
      machines: [PRIMARY, BOX],
      lists: { [BOX.id]: { agents: [view({ id: "far", label: "Far" })] } },
    });
    await mount(<AcpSettings />);
    await flush();
    await chooseMachine("box");
    expect(text()).toContain("acp.far");
    await act(async () =>
      fake.set("machines", { list: [PRIMARY, { ...BOX, status: "offline" }] }),
    );
    await flush();
    expect(document.querySelector("[role=status]")?.textContent).toContain(
      "box 目前离线",
    );
    expect(text()).not.toContain("acp.far");
    expect(text()).not.toContain("acp.demo");
  });
});
