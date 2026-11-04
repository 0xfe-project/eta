import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  machineView,
  productHost,
  projectView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { NewConversationDialog } from "./new-conversation-dialog";
import { useWorkspaceStore } from "./workspace-store";

const state = rstest.hoisted(() => ({
  navigate: rstest.fn(),
}));

rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
}));

let host: ReturnType<typeof productHost>;
function start(
  projects = [
    projectView({ id: "p1", name: "eta", path: "/work/eta" }),
    projectView({ id: "p2", name: "house", path: "/work/house" }),
  ],
  projectId: string | undefined = undefined,
) {
  host = productHost({
    agents: [
      agentView({ id: "a1", name: "乐子人" }),
      agentView({ id: "a2", name: "装配检查" }),
    ],
    projects,
    machines: [machineView({ id: "m1", kind: "primary" })],
  });
  host.handle("projects.create", (args) => ({
    project: projectView({ id: "made", path: (args as { path: string }).path }),
    existed: false,
  }));
  host.handle("conversations.create", () => ({
    conversation: conversationView({ id: "c-new" }),
  }));
  host.handle("projects.directories", () => ({
    path: "/home/me",
    home: "/home/me",
    parent: "/home",
    entries: [],
    truncated: false,
  }));
  // The form lives in a dialog now; the store opens it, and the dialog reads who it is for.
  useWorkspaceStore.setState({ newConversation: { open: true, projectId } });
  return mount(<NewConversationDialog />);
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  state.navigate.mockClear();
  useWorkspaceStore.setState({ newConversation: { open: false } });
});

/** The dialog's contents are portalled out of the container it was mounted in. */
const dialog = () => document.body;

const start_ = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("开始"),
  );

const calls = () => host.calls.map((c) => [`${c.target}.${c.action}`, c.args]);

/** Open the picker from the empty field, and take the machine's home. */
async function choose() {
  await click(dialog().querySelector("#new-project"));
  await flush();
  await click(button(dialog(), "选择此目录"));
  await flush();
}

describe("新对话", () => {
  it("选了人和项目就直接开一个对话，不用先建群", async () => {
    const { container: _container } = await start();
    const container = dialog();
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("装配检查"),
      ),
    );
    await click(start_(container));
    await flush();
    // An existing project is not added again.
    expect(calls()).toEqual([
      ["conversations.create", { projectId: "p1", agentIds: ["a2"] }],
    ]);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "c-new" },
    });
  });

  it("默认是第一个项目和第一位智能体", async () => {
    const { container: _container } = await start();
    const container = dialog();
    await click(start_(container));
    await flush();
    expect(calls()).toEqual([
      ["conversations.create", { projectId: "p1", agentIds: ["a1"] }],
    ]);
  });

  it("没有项目时选一个目录：先加成项目，主理人是所选的智能体", async () => {
    await start([]);
    await choose();
    await click(start_(dialog()));
    await flush();
    expect(calls().slice(-2)).toEqual([
      [
        "projects.create",
        { path: "/home/me", machineId: "m1", stewardId: "a1" },
      ],
      ["conversations.create", { projectId: "made", agentIds: ["a1"] }],
    ]);
  });

  it("路径为空时不能开始", async () => {
    const { container: _container } = await start([]);
    const container = dialog();
    expect(start_(container)!.disabled).toBe(true);
  });

  it("开在哪个项目就在哪个项目，即使它不是第一个", async () => {
    // The bug this replaces: the caller passed the project in the URL and the form never read it,
    // so "new conversation in this project" always landed in the first project.
    await start(undefined, "p2");
    const container = dialog();
    await click(start_(container));
    await flush();
    expect(calls()).toEqual([
      ["conversations.create", { projectId: "p2", agentIds: ["a1"] }],
    ]);
  });

  it("开完就关掉，不留在新对话后面", async () => {
    await start();
    await click(start_(dialog()));
    await flush();
    expect(useWorkspaceStore.getState().newConversation.open).toBe(false);
  });

  it("host 拒绝时把原因说出来，不跳走", async () => {
    await start([]);
    host.handle("projects.create", () => {
      throw new Error("no such directory: /nope");
    });
    await choose();
    await click(start_(dialog()));
    await flush();
    expect(dialog().textContent).toContain("no such directory: /nope");
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
