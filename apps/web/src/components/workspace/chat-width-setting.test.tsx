import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { act } from "react";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { agentView, buildProductHost, productHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { ChatPanel } from "./chat-panel";
import { SettingsDialog } from "./settings-dialog";
import { useWorkspaceStore } from "./workspace-store";

// The chat's content width: one `--chat-width` on the section, read by the transcript, the strip
// over the composer and the composer. happy-dom does not lay anything out, so the pixels are
// checked here as the value on the section and the three places that read it.

rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: (options?: { select?: (state: unknown) => unknown }) =>
    options?.select
      ? options.select({ location: { pathname: "/" } })
      : { location: { pathname: "/" } },
  useRouter: () => ({ navigate: () => undefined }),
  useNavigate: () => () => undefined,
  useLocation: (options?: { select?: (location: unknown) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => () => undefined,
}));

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ workspace: {} });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useWorkspaceStore.getState().setSettings({ open: false, section: "agents" });
});

function panel() {
  productHost({ agents: [agentView({ id: "a1", name: "乐子人" })] });
  return mount(
    <ChatPanel
      groupId="g1"
      groupName={undefined}
      held={[]}
      agents={[]}
      messages={[]}
      loading={false}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      questions={[]}
      draft={[]}
      onDraftChange={() => {}}
      onSend={() => {}}
      onCompact={() => {}}
      onStop={() => {}}
      onStopAll={() => {}}
      onChoose={() => {}}
      onAbort={() => {}}
      onGoal={async () => undefined}
      outgoing={[]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
      onResend={() => {}}
    />,
  );
}

const chatWidth = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>("section")
    ?.style.getPropertyValue("--chat-width");

describe("聊天内容宽度", () => {
  it("没设置过时是 860px", async () => {
    const { container } = await panel();
    expect(chatWidth(container)).toBe("860px");
  });

  it.each([
    ["extra-narrow", "600px"],
    ["narrow", "720px"],
    ["standard", "860px"],
    ["full", "none"],
  ] as const)("%s 对应 %s", async (value, width) => {
    useWorkspaceStore.getState().setWorkspace({ chatWidth: value });
    const { container } = await panel();
    expect(chatWidth(container)).toBe(width);
  });

  it("换一个选项立刻生效", async () => {
    const { container } = await panel();
    await act(async () =>
      useWorkspaceStore.getState().setWorkspace({ chatWidth: "extra-narrow" }),
    );
    expect(chatWidth(container)).toBe("600px");
  });

  it("对话记录、输入框上方那行和输入框读同一个值", async () => {
    const { container } = await panel();
    // The transcript's column and the strip over the composer.
    expect(
      container.querySelectorAll(".max-w-\\(--chat-width\\)"),
    ).toHaveLength(2);
    expect(container.querySelector(".input-outer")).not.toBeNull();
    const styles = readFileSync(
      new URL("../../styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatch(
      /\.input-outer \{[^}]*max-width: var\(--chat-width\);/,
    );
  });
});

describe("外观里的聊天内容宽度", () => {
  async function appearance() {
    const fake = buildProductHost({}, ["inbox", "github"]).target(
      "inbox",
      { list: [], approvals: { tools: [] } },
      { eager: true },
    );
    fake.install();
    fake.hello();
    useWorkspaceStore
      .getState()
      .setSettings({ open: true, section: "appearance" });
    await mount(
      <NuqsTestingAdapter>
        <SettingsDialog />
      </NuqsTestingAdapter>,
    );
    await flush();
    const group = document.querySelector(
      `[role="group"][aria-labelledby="${
        [...document.querySelectorAll("[id]")].find(
          (label) =>
            label.textContent === translate("settings:appearance.chatWidth"),
        )?.id
      }"]`,
    );
    expect(group).not.toBeNull();
    return [...group!.querySelectorAll("button")];
  }

  const pressed = (buttons: HTMLButtonElement[]) =>
    buttons.filter((button) => button.getAttribute("aria-pressed") === "true");

  it("默认选中标准，点一下写进 store 并存到本地", async () => {
    const buttons = await appearance();
    expect(buttons.map((button) => button.textContent)).toEqual([
      translate("settings:appearance.chatWidthExtraNarrow"),
      translate("settings:appearance.chatWidthNarrow"),
      translate("settings:appearance.chatWidthStandard"),
      translate("settings:appearance.chatWidthFull"),
    ]);
    expect(pressed(buttons)).toEqual([buttons[2]]);

    await act(async () => buttons[0]!.click());
    expect(useWorkspaceStore.getState().workspace.chatWidth).toBe(
      "extra-narrow",
    );
    expect(pressed(buttons)).toEqual([buttons[0]]);
    expect(
      JSON.parse(localStorage.getItem("eta.workspace.v1") ?? "{}"),
    ).toMatchObject({ chatWidth: "extra-narrow" });

    await act(async () => buttons[1]!.click());
    expect(useWorkspaceStore.getState().workspace.chatWidth).toBe("narrow");
    expect(pressed(buttons)).toEqual([buttons[1]]);

    await act(async () => buttons[3]!.click());
    expect(useWorkspaceStore.getState().workspace.chatWidth).toBe("full");
    expect(pressed(buttons)).toEqual([buttons[3]]);
  });
});
