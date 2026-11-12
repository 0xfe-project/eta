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

// The chat's right-edge rail is off until 设置 → 外观 turns it on. The rail itself is stood in for:
// what it draws is transcript-rail.test.tsx's business, whether it is there at all is this file's.

rstest.mock("./transcript-rail", () => ({
  TranscriptRail: () => <div data-testid="transcript-rail" />,
}));

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

const rail = (container: HTMLElement) =>
  container.querySelector('[data-testid="transcript-rail"]');

describe("聊天区右边缘的导航轨道", () => {
  it("没设置过时不画", async () => {
    const { container } = await panel();
    expect(rail(container)).toBeNull();
  });

  it("关着时不画", async () => {
    useWorkspaceStore.getState().setWorkspace({ transcriptRail: false });
    const { container } = await panel();
    expect(rail(container)).toBeNull();
  });

  it("打开时画出来，开关一动就跟着出现、消失", async () => {
    useWorkspaceStore.getState().setWorkspace({ transcriptRail: true });
    const { container } = await panel();
    expect(rail(container)).not.toBeNull();
    await act(async () =>
      useWorkspaceStore.getState().setWorkspace({ transcriptRail: false }),
    );
    expect(rail(container)).toBeNull();
    await act(async () =>
      useWorkspaceStore.getState().setWorkspace({ transcriptRail: true }),
    );
    expect(rail(container)).not.toBeNull();
  });
});

describe("外观里的导航轨道开关", () => {
  async function appearance() {
    const fake = buildProductHost({}, ["inbox"]).target(
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
    const toggle = document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${translate("settings:appearance.transcriptRail")}"]`,
    );
    expect(toggle).not.toBeNull();
    return toggle!;
  }

  it("默认关着，点一下写进 store 并存到本地，再点一下关掉", async () => {
    const toggle = await appearance();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain(
      translate("settings:appearance.transcriptRailHint"),
    );

    await act(async () => toggle.click());
    expect(useWorkspaceStore.getState().workspace.transcriptRail).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      JSON.parse(localStorage.getItem("eta.workspace.v1") ?? "{}"),
    ).toMatchObject({ transcriptRail: true });

    await act(async () => toggle.click());
    expect(useWorkspaceStore.getState().workspace.transcriptRail).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
