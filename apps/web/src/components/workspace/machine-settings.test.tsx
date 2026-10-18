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
        laptop,
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
    const status = (name: string) =>
      [...document.querySelectorAll("li")]
        .find((item) => item.textContent?.includes(name))
        ?.querySelector('[role="img"]')
        ?.getAttribute("aria-label");
    expect(status("主机")).toBe("在线");
    expect(status("旧电脑")).toBe("离线");
    expect(status("新电脑")).toBe("待批准");
    expect(status("弃用")).toBe("已撤销");
    expect(text()).toContain("macOS");
    expect(text()).toContain("上次在线");
    // Only the pending machine asks for a fingerprint, and a revoked one has no menu.
    expect(
      document.querySelectorAll('input[aria-label$="的指纹"]'),
    ).toHaveLength(1);
    expect(document.querySelector('[aria-label="弃用 的操作"]')).toBeNull();
  });

  it("enrolls: asks for the command with this page's origin and shows it with its expiry", async () => {
    const fake = productHost({ machines: [primary] });
    fake.handle("machines.enroll", () => ({
      code: "c0de",
      expiresAt: Date.now() + 3_600_000,
      url: location.origin,
      command: "curl -fsSL https://eta.test/install | sh -s -- c0de",
    }));
    await mount(<MachineSettings />);
    await flush();
    await click(button(document.body, "添加机器"));
    await type(input("机器名称"), " 书房 ");
    await submit(document.querySelector("[role=dialog] form")!);
    expect(fake.calls.at(-1)).toMatchObject({
      target: "machines",
      action: "enroll",
      args: { name: "书房", url: location.origin },
    });
    expect(text()).toContain(
      "curl -fsSL https://eta.test/install | sh -s -- c0de",
    );
    expect(text()).toContain("命令只能用一次");
    expect(text()).toContain("前有效");
  });

  it("approves a machine that shows up after the command, with the pasted fingerprint", async () => {
    const fake = productHost({ machines: [primary] });
    fake.handle("machines.enroll", () => ({
      code: "c0de",
      expiresAt: Date.now() + 3_600_000,
      url: location.origin,
      command: "eta-daemon enroll c0de",
    }));
    fake.handle("machines.approve", () => ({
      machine: { ...laptop, status: "online" },
    }));
    await mount(<MachineSettings />);
    await flush();
    await click(button(document.body, "添加机器"));
    await submit(document.querySelector("[role=dialog] form")!);
    expect(document.querySelectorAll("[role=dialog] input")).toHaveLength(0);
    await act(async () =>
      fake.set("machines", {
        list: [primary, { ...laptop, status: "pending", fingerprint: "ABCD" }],
      }),
    );
    await flush();
    const field = document.querySelector<HTMLInputElement>(
      '[role=dialog] input[aria-label="笔记本 的指纹"]',
    )!;
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
    ).toEqual(["重命名"]);
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
});
