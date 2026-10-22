import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  productHost,
  projectView,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { CreateGroup } from "./groups";

const navigation = rstest.hoisted(() => ({ open: rstest.fn() }));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => navigation.open,
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [{ id: "a1", name: "乐子人" }],
    loaded: true,
    error: undefined,
  }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.open.mockClear();
});

/** Type into a controlled input the way a person does: through the event React listens to. */
async function type(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The dialog renders through a portal, so the fields are in the document, not the container. */
function byLabel(text: string) {
  return [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.includes(text),
  );
}

async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function host(
  projects = [projectView({ id: "p1", name: "eta", path: "/work/eta" })],
) {
  const fake = productHost({ agents: [agentView({ id: "a1" })], projects });
  fake.handle("projects.create", (args) => ({
    project: projectView({ id: "made", path: (args as { path: string }).path }),
    existed: false,
  }));
  fake.handle("conversations.create", () => ({
    conversation: conversationView({ id: "c-new" }),
  }));
  fake.handle("conversations.update", () => ({}));
  return fake;
}

const named = async (name: string) => {
  const nameInput = byLabel("群名")!.querySelector("input")!;
  await type(nameInput, name);
};

describe("新建群的项目", () => {
  it("starts in the chosen project with the chosen members, and sets the goal after", async () => {
    const fake = host();
    await mount(<CreateGroup open members={["a1"]} onOpenChange={() => {}} />);
    await named("装配");
    await type(byLabel("目标")!.querySelector("textarea")!, "上线");
    await submit();
    // The first project is the default, so nothing is added.
    expect(fake.calls.map((c) => `${c.target}.${c.action}`)).toEqual([
      "conversations.create",
      "conversations.update",
    ]);
    expect(fake.calls[0]!.args).toEqual({
      projectId: "p1",
      name: "装配",
      agentIds: ["a1"],
    });
    expect(fake.calls[1]!.args).toEqual({
      conversationId: "c-new",
      goal: "上线",
    });
    expect(navigation.open).toHaveBeenCalledWith("c-new");
  });

  it("群名留空就交空串，名字由后端按项目定", async () => {
    const fake = host();
    await mount(<CreateGroup open members={["a1"]} onOpenChange={() => {}} />);
    await submit();
    // The project's name is the host's to decide, so the page says nothing rather than guess.
    expect(fake.calls.map((c) => `${c.target}.${c.action}`)).toEqual([
      "conversations.create",
    ]);
    expect(fake.calls[0]!.args).toEqual({
      projectId: "p1",
      name: "",
      agentIds: ["a1"],
    });
    expect(navigation.open).toHaveBeenCalledWith("c-new");
  });

  it("adds a typed path as a project first, trimmed, with the first member as its steward", async () => {
    const fake = host([]);
    await mount(<CreateGroup open members={["a1"]} onOpenChange={() => {}} />);
    await named("无项目");
    await type(
      document.querySelector<HTMLInputElement>('input[aria-label="目录路径"]')!,
      "  /tmp/app  ",
    );
    await submit();
    expect(fake.calls[0]).toMatchObject({
      target: "projects",
      action: "create",
      // Trimmed: a trailing space in a path is a path that does not exist.
      args: { path: "/tmp/app", stewardId: "a1" },
    });
    expect(fake.calls[1]!.args).toMatchObject({ projectId: "made" });
  });
});
