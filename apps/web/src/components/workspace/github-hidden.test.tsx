import type {
  GitHubPull,
  GitHubStatus,
  MessageView,
  TaskPullView,
} from "@eta/client-contracts";
import type { TaskDetail } from "@/queries/tasks";
import type { FakeHost } from "@/test-wire";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { Chat } from "@/test-chat";
import {
  agentView,
  buildProductHost,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { SettingsDialog } from "./settings-dialog";
import { TaskPulls } from "./task-pulls";
import { useWorkspaceStore } from "./workspace-store";

// GitHub is a chain the host may or may not have loaded (`--github`, and `hello.mounted` says
// which). Without it the page shows none of it: no settings section, no delivery row on a task,
// and — the case worth writing down — no card under a pull request or an issue an agent opened
// into a timeline that is still here. What is drawn is the tool call itself and its words; the
// card whose source is not on this host is left out entirely, rather than drawn as a frame that
// leads somewhere the host cannot speak of.

const PULL_URL = "https://github.com/acme/web/pull/7";
const DRAFT_URL =
  "https://github.com/acme/web/issues/new?title=Login%20is%20slow";

/** The activity of a reply from a host that did have GitHub, years ago. */
const activity = [
  {
    id: "call-1",
    name: "open_pull_request",
    input: { repository: "acme/web", head: "feature", title: "Add web" },
    output: JSON.stringify({ url: PULL_URL, number: 7, created: true }),
    details: {
      kind: "pull_request",
      number: 7,
      url: PULL_URL,
      title: "Add web",
    },
    status: "completed",
  },
  {
    id: "call-2",
    name: "draft_issue",
    input: { repository: "acme/web", title: "Login is slow" },
    output: JSON.stringify({ url: DRAFT_URL, title: "Login is slow" }),
    details: { kind: "issue_draft", title: "Login is slow", url: DRAFT_URL },
    status: "completed",
  },
];

const status = (fields: Partial<GitHubStatus> = {}): GitHubStatus => ({
  state: "not_connected",
  app: null,
  installations: [],
  error: null,
  user: null,
  oauth: false,
  checked: true,
  ...fields,
});

const pull = (taskId: string): TaskPullView => ({
  taskId,
  url: PULL_URL,
  title: "Add web",
  number: 7,
  openedAt: 1000,
});

const open: GitHubPull = {
  url: PULL_URL,
  title: "Add web",
  state: "open",
  additions: 12,
  deletions: 3,
  headSha: "abc123",
  merge: "ready",
};

const task = {
  id: "t1",
  number: 1,
  title: "Ship it",
  status: "in_review",
} as unknown as TaskDetail;

const disposers: (() => void)[] = [];
let conversations = 0;
const errors: unknown[][] = [];
let errorSpy: { mockRestore: () => void };

beforeEach(() => {
  errors.length = 0;
  errorSpy = rstest.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args);
  });
});

afterEach(async () => {
  await cleanup();
  await act(async () => disposers.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  errorSpy.mockRestore();
});

const githubState = (host: FakeHost, pulls: TaskPullView[]) =>
  host.target("github", { state: status(), pulls });

/** The chat of a direct conversation whose one reply has that activity on its row. */
async function chat(withGitHub: boolean): Promise<{ host: FakeHost }> {
  conversations += 1;
  const id = `github-hidden-${conversations}`;
  const reply: MessageView = messageView({
    conversationId: id,
    author: "agent",
    agentId: "a1",
    text: "开了 PR",
    data: { activity },
  });
  const host = buildProductHost(
    {
      agents: [agentView({ id: "a1", name: "研究员" })],
      conversations: [
        conversationView({
          id,
          kind: "direct",
          participants: [memberView("a1", { sessionId: "s1" })],
        }),
      ],
      messages: { [id]: [reply] },
    },
    withGitHub ? ["github"] : [],
  );
  if (withGitHub) githubState(host, []);
  host.handle("github.pull", () => open);
  host.install();
  host.hello();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <Chat conversationId={id} />
        </NuqsAdapter>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  disposers.push(() => {
    root.unmount();
    container.remove();
  });
  await flush();
  return { host };
}

/** Settings, open at its first section. */
async function settings(withGitHub: boolean) {
  const host = buildProductHost({ agents: [] }, withGitHub ? ["github"] : []);
  if (withGitHub) githubState(host, []);
  host.install();
  host.hello();
  useWorkspaceStore.getState().setSettings({ open: true, section: "agents" });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <SettingsDialog />
        </NuqsAdapter>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  disposers.push(() => {
    root.unmount();
    container.remove();
  });
  await flush();
  return { host };
}

const sectionLabels = () =>
  [...document.querySelectorAll("nav")]
    .filter((nav) => nav.getAttribute("aria-label") === "设置分类")
    .flatMap((nav) => [...nav.querySelectorAll("button")])
    .map((button) => button.textContent?.trim() ?? "");

/** What the page asked to be told about, as the wire saw it. */
const subscribed = (host: FakeHost) =>
  host.socket.framesOf("subscribe").map((frame) => frame.target);

const links = () =>
  [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

const bodyText = () => document.body.textContent ?? "";

describe("a host without GitHub", () => {
  it("draws no card for the pull request and the issue in an old reply", async () => {
    const { host } = await chat(false);
    // The call itself stays: it happened, and its words are the record of it.
    expect(bodyText()).toContain("open_pull_request");
    expect(bodyText()).toContain("draft_issue");
    // Neither ref it left behind is drawn, and nothing points at GitHub.
    expect(links()).not.toContain(PULL_URL);
    expect(links()).not.toContain(DRAFT_URL);
    expect(bodyText()).not.toContain("去 GitHub 创建");
    expect(subscribed(host)).not.toContain("github");
    expect(host.calls.map((call) => call.target)).not.toContain("github");
    expect(errors).toEqual([]);
  });

  it("draws no delivery row for the pull requests a task delivered", async () => {
    const host = buildProductHost({}, []);
    // The section is even still there, from a host that had the plugin: without it the page does
    // not subscribe, does not ask, and draws no row.
    githubState(host, [pull("t1")]);
    host.handle("github.pull", () => open);
    host.handle("tasks.update", () => ({}));
    host.install();
    host.hello();
    await mount(
      <ul>
        <TaskPulls task={task} />
      </ul>,
    );
    await flush();
    expect(bodyText()).not.toContain("交付");
    expect(links()).not.toContain(PULL_URL);
    expect(subscribed(host)).not.toContain("github");
    expect(host.calls.map((call) => call.action)).not.toContain("pull");
    expect(errors).toEqual([]);
  });

  it("offers no 连接 section in settings", async () => {
    await settings(false);
    expect(sectionLabels()).not.toContain("连接");
    expect(bodyText()).not.toContain("GitHub App");
    expect(errors).toEqual([]);
  });
});

describe("the same host with GitHub loaded", () => {
  it("draws both cards under the very same activity", async () => {
    await chat(true);
    await flush();
    expect(links()).toContain(PULL_URL);
    expect(links()).toContain(DRAFT_URL);
    expect(bodyText()).toContain("去 GitHub 创建");
    expect(errors).toEqual([]);
  });

  it("draws the delivery row, and reads the pull request on GitHub", async () => {
    const host = buildProductHost({}, ["github"]);
    githubState(host, [pull("t1")]);
    host.handle("github.pull", () => open);
    host.handle("tasks.update", () => ({}));
    host.install();
    host.hello();
    await mount(
      <ul>
        <TaskPulls task={task} />
      </ul>,
    );
    await flush();
    expect(bodyText()).toContain("交付");
    expect(links()).toContain(PULL_URL);
    expect(
      host.calls.filter(
        (call) => call.target === "github" && call.action === "pull",
      ),
    ).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("still offers no 连接 section: it is off in this build, GitHub loaded or not", async () => {
    await settings(true);
    expect(sectionLabels()).not.toContain("连接");
    expect(errors).toEqual([]);
  });
});
