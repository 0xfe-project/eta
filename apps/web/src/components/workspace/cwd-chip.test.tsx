import type { Group } from "@/queries/chat";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CwdChip } from "./cwd-chip";

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
});

const group = (cwd: string) =>
  ({ id: "g1", name: "装配", kind: "group", cwd }) as unknown as Group;

describe("header 上的目录", () => {
  it("shows the folder's name and keeps the whole path within reach", async () => {
    const container = await render(
      <CwdChip group={group("/Users/lemon/Desktop/eta")} />,
    );
    const chip = container.querySelector("[title]")!;
    expect(chip.textContent).toContain("eta");
    // The name is what fits; the path is the fact, so it is the title and the accessible name.
    expect(chip.getAttribute("title")).toBe("/Users/lemon/Desktop/eta");
    expect(chip.getAttribute("aria-label")).toContain(
      "/Users/lemon/Desktop/eta",
    );
  });

  it("says 未绑定目录 instead of showing nothing", async () => {
    const container = await render(<CwdChip group={group("")} />);
    expect(container.textContent).toContain("未绑定目录");
    expect(container.querySelector("[title]")?.getAttribute("title")).not.toBe(
      "",
    );
  });

  it("draws nothing when there is no group", async () => {
    const container = await render(<CwdChip group={undefined} />);
    expect(container.textContent).toBe("");
  });
});
