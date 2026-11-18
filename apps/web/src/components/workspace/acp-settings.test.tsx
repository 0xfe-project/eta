import type {
  AcpAgentView,
  AcpMachineList,
  MachineView,
} from "@eta/client-contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { buildProductHost, machineView } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { AcpSettings } from "./acp-settings";

const toasts = vi.hoisted(() => ({
  message: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({
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

/** Choose a machine in the open dialog's machine field. */
async function chooseMachine(name: string) {
  await click(dialog()!.querySelector<HTMLButtonElement>('[role="combobox"]')!);
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.startsWith(name))!;
  await click(option as unknown as HTMLButtonElement);
  await flush();
}

/** The agent's row in its machine's group. */
const row = (machine: string, label: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `ul[aria-label="${machine} 上的外部 Agent"] > li`,
    ),
  ].find((item) => item.querySelector("p")?.textContent === label);

/** Open the agent's ⋯ menu (in `machine`'s group, or the only one) and choose an item. */
async function fromMenu(label: string, item: string, machine?: string) {
  const root = machine === undefined ? document : row(machine, label)!;
  const trigger = root.querySelector<HTMLElement>(
    `[aria-label="${label} 的操作"]`,
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const entry = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((candidate) => candidate.textContent === item);
  expect(entry, item).toBeDefined();
  await act(async () => entry!.click());
  await flush();
}

/** The groups as their headings read: the machine, then what it holds. */
const groups = () =>
  [...document.querySelectorAll("section h3")].map((heading) =>
    [...heading.children].map((part) => part.textContent).join(" | "),
  );

describe("Settings → External agents", () => {
  it("lists each agent with its runtime id and version, its status, and a reason only when it cannot be used", async () => {
    host([
      view({
        id: "demo",
        label: "Demo",
        args: ["--acp"],
        version: "1.2.0",
        detail: "Checking…",
      }),
      view({
        id: "gem",
        label: "Gem",
        command: "gem",
        status: "unauthenticated",
        detail:
          "is not signed in. Sign in from a terminal on this machine first.",
      }),
      view({
        id: "gone",
        label: "Gone",
        command: "gone-acp",
        status: "missing",
      }),
      view({
        id: "bad",
        label: "Bad",
        status: "error",
        detail: "could not open a session: boom.",
      }),
    ]);
    await mount(<AcpSettings />);
    await flush();
    const lines = (label: string) =>
      [...row("studio", label)!.querySelectorAll("p")].map(
        (line) => line.textContent,
      );
    // By name; the command is not in the list.
    expect(
      [...document.querySelectorAll("ul > li > div > div > p:first-child")].map(
        (name) => name.textContent,
      ),
    ).toEqual(["Bad", "Demo", "Gem", "Gone"]);
    expect(text()).not.toContain("demo-agent --acp");
    expect(lines("Demo")).toEqual(["Demo", "acp.demo · v1.2.0"]);
    expect(row("studio", "Demo")!.textContent).toContain("可用");
    expect(lines("Gem")).toEqual([
      "Gem",
      "acp.gem",
      "在 studio 上登录 Gem 后点「测试」。",
    ]);
    expect(row("studio", "Gem")!.textContent).toContain("未登录");
    expect(lines("Gone")).toEqual([
      "Gone",
      "acp.gone",
      "studio 上找不到 gone-acp。装好后点「测试」。",
    ]);
    expect(lines("Bad")).toEqual([
      "Bad",
      "acp.bad",
      "could not open a session: boom. 修好后点「测试」。",
    ]);
    expect(row("studio", "Bad")!.textContent).toContain("出错");
    // No auto-allow badge: every permission request is answered yes.
    expect(text()).not.toContain("自动允许");
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
    // Nowhere to add to.
    expect(byText("添加 Agent")?.disabled).toBe(true);
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
    // The machine first; neither a working directory nor auto-allow is asked for.
    expect(
      [...document.querySelectorAll("[role=dialog] label")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["机器", "名称", "ID", "命令", "参数", "环境变量"]);
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

  it("edits an agent in place or renames it, always naming the one it edits", async () => {
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
    await fromMenu("Demo", "编辑");
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
        // In place: the host would take an edit without it for a new agent, and refuse the id.
        previousId: "demo",
      },
    });

    await fromMenu("Demo", "编辑");
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
    await fromMenu("Demo", "删除");
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
    await fromMenu("Demo", "删除");
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
    await fromMenu("Demo", "测试");
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

describe("Settings → External agents, every machine at once", () => {
  /** The primary with `demo` and `claude`; box answers its refresh with `far` and `claude`. */
  function fleet(machines: MachineView[] = [BOX, PRIMARY, ATTIC]) {
    const primaryAgents = [
      view({ id: "demo", label: "Demo", args: ["--acp", "a b"] }),
      view({ id: "claude", label: "Claude Code", version: "1.2.0" }),
    ];
    const boxAgents = [
      view({ id: "far", label: "Far", version: "v0.0.1" }),
      view({ id: "claude", label: "Claude Code", status: "unauthenticated" }),
    ];
    const fake = host(primaryAgents, { machines });
    const lists: Record<string, AcpMachineList> = {
      [PRIMARY.id]: { agents: primaryAgents },
    };
    fake.handle("acp.refresh", (args) => {
      const { machineId } = args as { machineId: string };
      if (machineId === BOX.id) {
        lists[BOX.id] = { agents: boxAgents };
        publish(fake, lists);
      }
      return {};
    });
    return { fake, lists };
  }

  it("groups the agents by machine, the primary first and an offline one on its own, asking only the reachable", async () => {
    const { fake } = fleet();
    await mount(<AcpSettings />);
    await flush();
    // No machine to choose at the top.
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    expect(groups()).toEqual([
      "studio | 主机器 · 2 个",
      "box | 2 个",
      "attic | 离线",
    ]);
    // The same acp.claude on two machines is two agents, one in each group.
    expect(row("studio", "Claude Code")!.textContent).toContain(
      "acp.claude · v1.2.0",
    );
    expect(row("box", "Claude Code")!.textContent).toContain("未登录");
    expect(row("box", "Far")!.textContent).toContain("acp.far · v0.0.1");
    // A row does not repeat its machine.
    expect(row("box", "Far")!.textContent).not.toContain("box");
    const offline = [...document.querySelectorAll("section")].at(-1)!;
    expect(offline.querySelector("[role=status]")?.textContent).toBe(
      "attic 重新上线后，这里会列出它上面的外部 Agent。",
    );
    expect(offline.querySelector("ul")).toBeNull();
    const refreshed = fake.calls
      .filter((call) => call.action === "refresh")
      .map((call) => (call.args as { machineId: string }).machineId);
    expect(new Set(refreshed)).toEqual(new Set([PRIMARY.id, BOX.id]));
  });

  it("tests, edits, copies and deletes from the ⋯ menu, on the agent's own machine", async () => {
    const { fake } = fleet();
    fake.handle("acp.test", () => ({ ok: true, status: "available" }));
    fake.handle("acp.save", (args) =>
      view((args as { agent: AcpAgentView }).agent),
    );
    fake.handle("acp.delete", () => ({}));
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied.push(value);
          return Promise.resolve();
        },
      },
    });
    await mount(<AcpSettings />);
    await flush();

    await fromMenu("Claude Code", "测试", "box");
    expect(fake.calls.at(-1)).toMatchObject({
      action: "test",
      args: { machineId: BOX.id, agent: { id: "claude" } },
    });

    // The menu's items, delete last.
    const trigger = row("studio", "Demo")!.querySelector<HTMLElement>(
      '[aria-label="Demo 的操作"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const menu = document.querySelector('[role="menu"]')!;
    expect(
      [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map(
        (item) => item.textContent || "—",
      ),
    ).toEqual(["测试", "编辑", "复制命令", "—", "删除"]);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await flush();

    await fromMenu("Demo", "复制命令", "studio");
    expect(copied).toEqual(["demo-agent --acp 'a b'"]);
    expect(toasts.message).toHaveBeenCalledWith("已复制");

    await fromMenu("Far", "编辑", "box");
    // The machine is shown, not chosen.
    expect(dialog()!.querySelector('[role="combobox"]')).toBeNull();
    const machineField = document.getElementById(
      fieldId("机器"),
    ) as HTMLInputElement;
    expect(machineField.readOnly).toBe(true);
    expect(machineField.value).toBe("box");
    await fill("名称", "Far Two");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: {
        machineId: BOX.id,
        agent: { id: "far", label: "Far Two" },
        previousId: "far",
      },
    });

    await fromMenu("Claude Code", "删除", "box");
    await click(
      byText(
        "删除",
        [...document.querySelectorAll("[role=alertdialog]")].at(-1)!,
      ),
    );
    expect(fake.calls.at(-1)).toMatchObject({
      action: "delete",
      args: { machineId: BOX.id, id: "claude" },
    });
  });

  it("adds on the machine chosen first: the primary by default, never an offline one, ids checked on that machine", async () => {
    const { fake, lists } = fleet();
    fake.handle("acp.save", (args) => {
      const { machineId, agent } = args as {
        machineId: string;
        agent: AcpAgentView;
      };
      const saved = view(agent);
      lists[machineId] = {
        agents: [...(lists[machineId]?.agents ?? []), saved],
      };
      publish(fake, lists);
      return saved;
    });
    await mount(<AcpSettings />);
    await flush();
    await click(byText("添加 Agent"));
    const trigger = dialog()!.querySelector('[role="combobox"]')!;
    expect(trigger.textContent).toBe("studio（主机器）");
    await click(trigger as HTMLButtonElement);
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "studio（主机器）",
      "box",
      "attic · 离线",
    ]);
    expect(
      options.map((option) => option.getAttribute("aria-disabled") === "true"),
    ).toEqual([false, false, true]);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    // `far` is box's: free on the primary, taken once box is chosen.
    await fill("名称", "Far");
    await fill("命令", "far");
    await chooseMachine("box");
    await submit();
    expect(alerts()).toEqual(["这台机器上已有外部 Agent 使用这个 ID。"]);
    await fill("ID", "far2");
    await submit();
    expect(fake.calls.at(-1)).toMatchObject({
      action: "save",
      args: { machineId: BOX.id, agent: { id: "far2" } },
    });
    expect(dialog()).toBeNull();
    // It shows up in box's group.
    expect(row("box", "Far")).toBeDefined();
    expect(groups()[1]).toBe("box | 3 个");
  });

  it("turns a daemon that goes offline into its offline group", async () => {
    const { fake } = fleet([PRIMARY, BOX]);
    await mount(<AcpSettings />);
    await flush();
    expect(row("box", "Far")).toBeDefined();
    await act(async () =>
      fake.set("machines", { list: [PRIMARY, { ...BOX, status: "offline" }] }),
    );
    await flush();
    expect(groups()).toEqual(["studio | 主机器 · 2 个", "box | 离线"]);
    expect(text()).not.toContain("acp.far");
    expect(text()).toContain("box 重新上线后");
  });
});
