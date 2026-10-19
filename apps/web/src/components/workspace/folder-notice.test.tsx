import type { Group } from "@/queries/chat";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UnboundFolderNotice } from "./folder-notice";

const actions = rstest.hoisted(() => ({
  update: { mutate: rstest.fn(), isPending: false },
}));
rstest.mock("@/queries/groups", () => ({
  useGroupActions: () => actions,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  actions.update.mutate.mockClear();
});

const group = (cwd: string) =>
  ({ id: "g1", name: "装配", kind: "group", cwd }) as unknown as Group;

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

describe("群没有目录时的提示", () => {
  it("says what is happening and takes a folder", async () => {
    const container = await render(<UnboundFolderNotice group={group("")} />);
    expect(container.textContent).toContain("这个群还没绑目录");

    const input = container.querySelector("input")!;
    await type(input, "  /tmp/app  ");
    await act(async () =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(actions.update.mutate.mock.calls[0]![0]).toEqual({
      id: "g1",
      cwd: "/tmp/app",
    });
  });

  it("stays out of the way once the group has a folder", async () => {
    const container = await render(
      <UnboundFolderNotice group={group("/tmp/app")} />,
    );
    expect(container.textContent).toBe("");
  });

  it("cannot be saved with an empty field", async () => {
    const container = await render(<UnboundFolderNotice group={group("")} />);
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
  });
});
