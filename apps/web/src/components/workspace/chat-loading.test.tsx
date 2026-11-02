import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { agentView, productHost } from "@/test-product";
import { cleanup, mount } from "@/test-render";
import { ChatPanel } from "./chat-panel";

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

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

function panel(loading: boolean, groupId?: string) {
  productHost({ agents: [agentView({ id: "a1", name: "乐子人" })] });
  return mount(
    <ChatPanel
      groupId={groupId}
      groupName={undefined}
      held={[]}
      agents={[]}
      messages={[]}
      loading={loading}
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

const statuses = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="status"]')].map(
    (node) => node.textContent,
  );

describe("对话还在读取时", () => {
  it("draws the turns' outline, named 正在读取对话…, and no empty state", async () => {
    const { container } = await panel(true);
    expect(statuses(container)).toContain(translate("chat:history.loading"));
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(4);
    expect(container.textContent).not.toContain(
      translate("chat:history.noConversations"),
    );
    expect(container.textContent).not.toContain(
      translate("chat:history.empty"),
    );
    // Nor does the box claim there are no agents before the agents are read.
    expect(container.textContent).not.toContain(
      translate("chat:composer.createAgentFirst"),
    );
  });

  it("says there is nothing yet once it has been read", async () => {
    const { container } = await panel(false, "g1");
    expect(statuses(container)).not.toContain(
      translate("chat:history.loading"),
    );
    expect(container.textContent).toContain(translate("chat:history.empty"));
    expect(container.textContent).toContain(
      translate("chat:composer.createAgentFirst"),
    );
  });
});
