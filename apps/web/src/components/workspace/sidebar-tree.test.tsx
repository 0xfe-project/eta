import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FolderTree } from "./sidebar-tree";

const data = rstest.hoisted(() => ({
  groups: [] as unknown[],
  current: undefined as unknown,
  activeReplies: [] as unknown[],
}));
const navigation = rstest.hoisted(() => ({
  open: rstest.fn(),
  openAgent: rstest.fn(),
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: data.groups, current: data.current }),
  useOpenGroup: () => navigation.open,
}));
rstest.mock("./use-agents", () => ({
  useOpenAgent: () => navigation.openAgent,
  useAgents: () => ({ agents: [], loaded: true, error: undefined }),
}));
rstest.mock("@/queries/chat", () => ({
  // The tree reads the snapshot directly, so the seeded cache below is what it sees.
  chatQueryOptions: () => ({ queryKey: ["chat"], queryFn: () => data }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["chat"], {
    groups: data.groups,
    agents: [],
    active_replies: data.activeReplies,
    interactions: [],
    event_cursor: 0,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  navigation.open.mockClear();
  navigation.openAgent.mockClear();
  data.activeReplies = [];
});

const participant = (id: string, name: string) => ({
  agent_id: id,
  name,
  member: true,
  status: "idle",
});

const group = (
  id: string,
  name: string,
  cwd: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  kind: "group",
  cwd,
  goal: "",
  decided: "",
  archived: false,
  unread: 0,
  read_seq: 0,
  last_seq: 0,
  preview: "",
  revision: 1,
  last_message_at: "2026-10-17T00:00:00Z",
  updated_at: "2026-10-17T00:00:00Z",
  participants: [participant("a1", "乐子人"), participant("a2", "装配检查")],
  ...extra,
});

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );

describe("侧边栏的树", () => {
  it("heads each folder and puts its conversations underneath", async () => {
    data.groups = [
      group("g1", "装配", "/Users/me/Desktop/eta"),
      group("g2", "装修", "/Users/me/work/house"),
    ];
    const container = await render(<FolderTree />);
    const headings = [...container.querySelectorAll("h3")].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["eta", "house"]);
  });

  it("opens a conversation when its row is clicked", async () => {
    data.groups = [group("g1", "装配", "/p")];
    const container = await render(<FolderTree />);
    await act(async () => button(container, "装配")!.click());
    expect(navigation.open).toHaveBeenCalledWith("g1");
  });

  it("shows members when expanded, and a member row opens that agent alone", async () => {
    data.groups = [group("g1", "装配", "/p")];
    const container = await render(<FolderTree />);
    expect(button(container, "乐子人")).toBeUndefined();

    await act(async () =>
      container
        .querySelector('[aria-label="展开成员"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => button(container, "乐子人")!.click());
    expect(navigation.openAgent).toHaveBeenCalledWith("a1");
  });

  it("marks who is answering and how much is unread", async () => {
    data.groups = [group("g1", "装配", "/p", { unread: 3 })];
    data.activeReplies = [
      { group_id: "g1", agent_id: "a2", status: "responding" },
    ];
    const container = await render(<FolderTree />);
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("●");
  });

  it("falls back to a sentence when a search matches nothing", async () => {
    data.groups = [group("g1", "装配", "/p")];
    const container = await render(<FolderTree query="没有这个" />);
    expect(container.textContent).toContain("没有匹配的对话");
  });
});
