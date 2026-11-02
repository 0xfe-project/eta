import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { machineView, productHost } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { MachineSettings } from "./machine-settings";

const toasts = rstest.hoisted(() => ({
  message: rstest.fn(),
  error: rstest.fn(),
}));
rstest.mock("sonner", () => ({
  toast: Object.assign(toasts.message, { error: toasts.error }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  toasts.message.mockClear();
  toasts.error.mockClear();
});

const text = () => document.body.textContent ?? "";

/** Type into a controlled input the way a person does: through the event React listens to. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

const back = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="返回"]')!;

const submit = async (form: Element) => {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
};

/** Radix opens a menu on pointer down. */
async function openMenu(name: string) {
  const trigger = document.querySelector<HTMLElement>(
    `[aria-label="${name} 的操作"]`,
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function choose(label: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((candidate) => candidate.textContent === label);
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
}

const primary = machineView({ id: "m1", name: "主机", kind: "primary" });
const laptop = machineView({
  id: "m2",
  name: "笔记本",
  kind: "daemon",
  os: "darwin",
  home: "/Users/me",
});

describe("机器设置", () => {
  it("shows each machine with its status", async () => {
    productHost({
      machines: [
        primary,
        { ...laptop, version: "d5f93964f3e9", build: "outdated" },
        machineView({
          id: "m3",
          name: "旧电脑",
          kind: "daemon",
          status: "offline",
          lastSeenAt: Date.now(),
        }),
        machineView({
          id: "m4",
          name: "新电脑",
          kind: "daemon",
          status: "pending",
        }),
        machineView({
          id: "m5",
          name: "弃用",
          kind: "daemon",
          status: "revoked",
        }),
      ],
    });
    await mount(<MachineSettings />);
    await flush();
    const card = (name: string) =>
      [...document.querySelectorAll("li")].find((item) =>
        item.textContent?.includes(name),
      );
    const status = (name: string) =>
      card(name)?.querySelector('[role="img"]')?.getAttribute("aria-label");
    const details = (name: string) =>
      card(name)?.querySelector("p")?.textContent;
    expect(status("主机")).toBe("在线");
    expect(status("旧电脑")).toBe("离线");
    expect(status("新电脑")).toBe("待批准");
    // A revoked machine can do nothing more, so it is not listed at all.
    expect(card("弃用")).toBeUndefined();
    // Only the primary is marked, and an offline machine leads with when it was last seen, so
    // that is not what the line cuts off.
    expect(details("主机")).toBe(
      "主机器 · Linux · /home/me · 同时运行 2 个任务",
    );
    expect(details("笔记本")).toBe("macOS · /Users/me · 同时运行 2 个任务");
    expect(details("旧电脑")).toMatch(/^上次在线 今天 \d\d:\d\d · Linux/);
    expect(text()).not.toContain("Daemon");
    // The build is said in words when it is behind; the build itself is only on hover.
    expect(text()).not.toContain("d5f93964f3e9");
    expect(
      card("笔记本")?.querySelector('[title="版本 d5f93964f3e9"]')?.textContent,
    ).toBe("在线 · 需要更新");
    // Only the pending machine asks for a fingerprint.
    expect(
      document.querySelectorAll('input[aria-label$="的指纹"]'),
    ).toHaveLength(1);
  });

  it("says there are no other machines when the only other one was revoked", async () => {
    productHost({
      machines: [
        primary,
        machineView({
          id: "m5",
          name: "弃用",
          kind: "daemon",
          status: "revoked",
        }),
      ],
    });
    await mount(<MachineSettings />);
    await flush();
    expect(document.querySelectorAll("li")).toHaveLength(1);
    expect(text()).not.toContain("弃用");
    expect(text()).toContain("还没有接入其他机器");
  });

  it("adding turns the panel into the way in: a command to run, with this page's origin", async () => {
    const fake = productHost({ machines: [primary] });
    fake.handle("machines.addresses", () => ({ tailnet: null }));
    fake.handle("machines.enroll", () => ({
      code: "c0de",
      expiresAt: Date.now() + 3_600_000,
      url: location.origin,
      command:
        "curl -fsSL 'https://eta.test/machines/install.sh?code=c0de' | sh",
    }));
    await mount(<MachineSettings />);
    await flush();
    await click(button(document.body, "添加机器"));
    // Not a dialog over the panel: the panel itself, with a way back.
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(back()).toBeTruthy();
    await type(byId("machine-name"), " 书房 ");
    await click(button(document.body, "生成安装命令"));
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "enroll",
      args: { name: "书房", url: location.origin },
    });
    expect(text()).toContain(
      "curl -fsSL 'https://eta.test/machines/install.sh?code=c0de' | sh",
    );
    expect(text()).toContain("命令只能用一次");
    // With no tailnet address there is nothing to choose.
    expect(document.getElementById("machine-address")).toBeNull();
    await click(back());
    expect(button(document.body, "添加机器")).toBeTruthy();
  });

  it("approves a machine that shows up after the command, with the pasted fingerprint", async () => {
    const fake = productHost({ machines: [primary] });
    fake.handle("machines.addresses", () => ({ tailnet: null }));
    fake.handle("machines.enroll", () => ({
      code: "c0de",
      expiresAt: Date.now() + 3_600_000,
      url: location.origin,
      command: "curl -fsSL x | sh",
    }));
    fake.handle("machines.approve", () => ({
      machine: { ...laptop, status: "online" },
    }));
    await mount(<MachineSettings />);
    await flush();
    await click(button(document.body, "添加机器"));
    await click(button(document.body, "生成安装命令"));
    expect(text()).toContain("等待那台机器运行命令");
    await act(async () =>
      fake.set("machines", {
        list: [primary, { ...laptop, status: "pending", fingerprint: "ABCD" }],
        installs: [],
      }),
    );
    await flush();
    const field = input("笔记本 的指纹");
    await type(field, "abcd efgh:ijkl");
    await submit(field.closest("form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "approve",
      args: { machineId: "m2", fingerprint: "abcd efgh:ijkl" },
    });
    expect(toasts.message).toHaveBeenCalledWith("已批准 笔记本");
  });

  it("shows the host's refusal as it is when the fingerprint does not match", async () => {
    const fake = productHost({
      machines: [primary, { ...laptop, status: "pending" }],
    });
    fake.handle("machines.approve", () => {
      throw new Error("fingerprint does not match");
    });
    await mount(<MachineSettings />);
    await flush();
    const field = input("笔记本 的指纹");
    await type(field, "WRONG");
    await submit(field.closest("form")!);
    expect(toasts.error).toHaveBeenCalledWith("fingerprint does not match");
    expect(toasts.message).not.toHaveBeenCalled();
    // Still waiting, so the right one can be pasted next.
    expect(input("笔记本 的指纹")).not.toBeNull();
  });

  it("does not ask the host before anything is typed", async () => {
    const fake = productHost({
      machines: [primary, { ...laptop, status: "pending" }],
    });
    await mount(<MachineSettings />);
    await flush();
    expect(button(document.body, "批准")?.disabled).toBe(true);
    await submit(input("笔记本 的指纹").closest("form")!);
    expect(fake.calls).toHaveLength(0);
  });

  it("revokes after confirming, and the primary cannot be revoked", async () => {
    const fake = productHost({ machines: [primary, laptop] });
    fake.handle("machines.revoke", () => ({
      machine: { ...laptop, status: "revoked" },
    }));
    await mount(<MachineSettings />);
    await flush();
    await openMenu("主机");
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["重命名", "同时运行数"]);
    await act(async () => document.body.click());
    await openMenu("笔记本");
    await choose("撤销");
    expect(fake.calls).toHaveLength(0);
    expect(text()).toContain("撤销 笔记本？");
    const confirm = [
      ...document.querySelectorAll("[role=alertdialog] button"),
    ].find((b) => b.textContent === "撤销");
    await click(confirm);
    await flush();
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "revoke",
      args: { machineId: "m2" },
    });
  });

  it("renames a machine", async () => {
    const fake = productHost({ machines: [primary, laptop] });
    fake.handle("machines.rename", () => ({ machine: laptop }));
    await mount(<MachineSettings />);
    await flush();
    await openMenu("笔记本");
    await choose("重命名");
    const field = input("机器名称");
    await type(field, "书房");
    await submit(field.closest("form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "rename",
      args: { machineId: "m2", name: "书房" },
    });
  });

  it("sets how many task runs a machine works on at once", async () => {
    const fake = productHost({ machines: [primary, laptop] });
    fake.handle("machines.setMaxActiveRuns", () => ({ machine: laptop }));
    await mount(<MachineSettings />);
    await flush();
    expect(text()).toContain("同时运行 2 个任务");
    await openMenu("笔记本");
    await choose("同时运行数");
    const field = input("同时运行的任务数（1–20）");
    await type(field, "4");
    await submit(field.closest("form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "setMaxActiveRuns",
      args: { machineId: "m2", maxActiveRuns: 4 },
    });
  });
});
