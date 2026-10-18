import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CreateGroup } from "./groups";

const actions = rstest.hoisted(() => ({
  create: { mutate: rstest.fn(), isPending: false },
}));
const navigation = rstest.hoisted(() => ({ open: rstest.fn() }));
rstest.mock("@/queries/groups", () => ({
  useGroupActions: () => ({ create: actions.create }),
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => navigation.open,
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: [], loaded: true, error: undefined }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];

async function render(node: React.ReactNode) {
  const client = new QueryClient();
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
  actions.create.mutate.mockClear();
  navigation.open.mockClear();
});

/** Type into a controlled input the way a person does: through the event React listens to. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The dialog renders through a portal, so the fields are in the document, not the container. */
function byLabel(container: ParentNode, text: string) {
  return [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.includes(text),
  );
}

function submit(container: ParentNode) {
  return container.querySelector("form")!;
}

describe("新建群的目录", () => {
  it("sends the folder with the group, and leaves it out when empty", async () => {
    await render(<CreateGroup open onOpenChange={() => {}} />);
    const nameLabel = byLabel(document, "群名") ?? byLabel(document, "名字");
    const nameInput = nameLabel!.querySelector("input")!;
    await type(nameInput, "装配");

    const cwdLabel = byLabel(document, "工作目录");
    expect(cwdLabel).toBeDefined();
    await type(cwdLabel!.querySelector("input")!, "  /tmp/app  ");

    await act(async () => {
      submit(document).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(actions.create.mutate.mock.calls[0]![0]).toEqual({
      name: "装配",
      goal: "",
      members: [],
      // Trimmed: a trailing space in a path is a path that does not exist.
      cwd: "/tmp/app",
    });
  });

  it("says nothing about a folder when the field is left empty", async () => {
    await render(<CreateGroup open onOpenChange={() => {}} />);
    const nameInput = (byLabel(document, "群名") ??
      byLabel(document, "名字"))!.querySelector("input")!;
    await type(nameInput, "无目录");
    await act(async () => {
      submit(document).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const body = actions.create.mutate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    // Omitted, not "": the store's own answer to "not said" is what makes a group unbound.
    expect("cwd" in body).toBe(false);
  });
});
