import type { EmailAccountView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { EmailSettings } from "./email-settings";

const account: EmailAccountView = {
  id: "mail-1",
  name: "Alice",
  address: "alice@example.com",
  username: "alice@example.com",
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  inboxFolder: "INBOX",
  junkFolder: null,
  pollIntervalSeconds: 60,
  status: "ready",
  lastError: null,
  lastCheckedAt: null,
  lastPollAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function host(
  accounts: EmailAccountView[] = [
    account,
    {
      ...account,
      id: "mail-2",
      name: "Bob",
      address: "bob@example.com",
      username: "bob@example.com",
    },
  ],
) {
  const fake = buildProductHost({}, ["email"]).target(
    "email",
    {
      accounts,
      threads: [],
      proposals: [],
      stats: { unread: 0, pendingProposals: 0 },
    },
    { eager: true },
  );
  fake.handle("email.saveAccount", () => ({ account }));
  fake.install();
  fake.hello();
  return fake;
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("email settings", () => {
  it("matches the provider settings empty state", async () => {
    host([]);
    const view = await mount(<EmailSettings />);
    const empty = view.container.querySelector("p.border-dashed");
    expect(empty?.textContent).toBe("还没有邮箱账号。绑一个，才能收发邮件。");
    expect(view.container.querySelector("ul")).toBeNull();
    expect(
      [...view.container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === "绑定邮箱",
      ),
    ).toBe(true);
  });

  it("opens the add account detail and goes back", async () => {
    host();
    const view = await mount(<EmailSettings />);
    [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent === "绑定邮箱")!
      .click();
    await flush();
    expect(view.container.textContent).toContain("邮箱服务商");
    expect(view.container.querySelector("ul")).toBeNull();
    const fields = view.container.querySelector("form")?.firstElementChild;
    expect(
      [...(fields?.children ?? [])].map(
        (field) => field.querySelector("label")?.textContent,
      ),
    ).toEqual(["邮箱服务商", "邮箱地址", "名称", "授权码或应用密码"]);
    expect(
      fields
        ?.querySelector('[data-slot="select-trigger"]')
        ?.classList.contains("w-full"),
    ).toBe(true);
    [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent === "返回")!
      .click();
    await flush();
    expect(view.container.textContent).not.toContain("邮箱服务商");
    expect(view.container.querySelector("ul")).not.toBeNull();
  });

  it("submits an edit without overwriting the saved password", async () => {
    const fake = host();
    const view = await mount(<EmailSettings />);
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="编辑邮箱"]')!
      .click();
    await flush();
    expect(
      view.container.querySelector<HTMLInputElement>("#email-address")?.value,
    ).toBe("alice@example.com");
    expect(
      view.container.querySelector<HTMLInputElement>("#email-password")
        ?.required,
    ).toBe(false);
    expect(
      view.container.querySelector<HTMLInputElement>("#email-password")
        ?.placeholder,
    ).toBe("已配置——输入即替换");
    expect(
      view.container
        .querySelector<HTMLInputElement>("#email-username")
        ?.closest("details"),
    ).not.toBeNull();
    expect(
      view.container.querySelector<HTMLInputElement>("#email-username")
        ?.placeholder,
    ).toBe("默认同邮箱地址");
    expect(view.container.textContent).toContain("保存并检查连接");
    const name = view.container.querySelector<HTMLInputElement>("#email-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(name, "Alice work");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      view.container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await flush();
    expect(
      fake.calls.find((call) => call.action === "saveAccount")?.args,
    ).toMatchObject({
      id: "mail-1",
      name: "Alice work",
      username: "alice@example.com",
      password: "",
    });
  });

  it("only shows pending on the account being checked", async () => {
    const fake = host();
    let finish: (() => void) | undefined;
    fake.handle(
      "email.verifyAccount",
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ account });
        }),
    );
    const view = await mount(<EmailSettings />);
    const checkButtons = () =>
      [...view.container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent === "检查连接",
      );
    await click(checkButtons()[0]);
    expect(checkButtons()).toHaveLength(1);
    expect(checkButtons()[0]?.disabled).toBe(false);
    const checking = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "正在检查连接…",
    );
    expect(checking?.disabled).toBe(true);
    finish?.();
    await flush();
  });

  it("confirms before disconnecting a mailbox", async () => {
    const fake = host();
    fake.handle("email.removeAccount", () => ({ removed: true }));
    const view = await mount(<EmailSettings />);
    const trash = () =>
      view.container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="解除绑定"]',
      )[1];
    const dialogButton = (text: string) =>
      [...document.querySelectorAll("[role=alertdialog] button")].find(
        (candidate) => candidate.textContent === text,
      );
    const removed = () =>
      fake.calls.filter((call) => call.action === "removeAccount");
    await click(trash());
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      "解除绑定 Bob？",
    );
    expect(removed()).toHaveLength(0);
    await click(dialogButton("取消"));
    expect(removed()).toHaveLength(0);
    await click(trash());
    await click(dialogButton("解除绑定"));
    await flush();
    expect(removed().map((call) => call.args)).toEqual([
      { accountId: "mail-2" },
    ]);
  });
});
