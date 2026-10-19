import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  productHost,
  projectView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
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
  });
  host.handle("projects.create", (args) => ({
    project: projectView({ id: "made", path: (args as { path: string }).path }),
    existed: false,
  }));
  host.handle("conversations.create", () => ({
    conversation: conversationView({ id: "c-new" }),
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
      search: { group: "c-new", view: "context" },
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

  it("没有项目时输入路径：先加成项目，主理人是所选的智能体", async () => {
    const { container: _container } = await start([]);
    const container = dialog();
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, " /tmp/app ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(start_(container));
    await flush();
    expect(calls()).toEqual([
      ["projects.create", { path: "/tmp/app", stewardId: "a1" }],
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
    const { container: _container } = await start([]);
    const container = dialog();
    host.handle("projects.create", () => {
      throw new Error("no such directory: /nope");
    });
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "/nope");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(start_(container));
    await flush();
    expect(container.textContent).toContain("no such directory: /nope");
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
