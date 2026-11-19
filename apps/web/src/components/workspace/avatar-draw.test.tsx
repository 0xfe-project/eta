import type { AgentView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { agentView } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { AvatarDraw } from "./avatar-draw";

vi.mock("./agent-identity", () => ({
  AgentAvatar: ({ agent }: { agent: Pick<AgentView, "avatarSeed"> }) => (
    <span data-seed={agent.avatarSeed} />
  ),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (message: string) => toastError(message) },
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  toastError.mockReset();
});

/** The faces on screen: the large one first, then the recent ones in order. */
const faces = () =>
  [...document.querySelectorAll("[data-seed]")].map((face) =>
    face.getAttribute("data-seed"),
  );
const pressed = () =>
  document
    .querySelector('[aria-pressed="true"] [data-seed]')
    ?.getAttribute("data-seed");
const drawButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="重新抽一张"]');

/** An editor over an agent whose save the test answers by hand. */
async function editing(agent: AgentView) {
  let answer!: { resolve: () => void; reject: (error: Error) => void };
  const host = new FakeHost()
    .target("agents", { list: [agent] }, { eager: true })
    .plugins([{ name: "agents", source: "bundled" }])
    .handle(
      "agents.update",
      () =>
        new Promise<void>((resolve, reject) => {
          answer = { resolve, reject };
        }),
    )
    .install();
  host.hello();
  const { show } = await mount(<AvatarDraw agent={agent}>name</AvatarDraw>);
  await flush();
  return { host, show, answer: () => answer };
}

describe("drawing another face", () => {
  it("shows an old agent the face its id draws, as the only one", async () => {
    await editing(agentView({ id: "a1" }));
    expect(faces()).toEqual(["a1", "a1"]);
    expect(pressed()).toBe("a1");
    expect(drawButton()).not.toBeNull();
  });

  it("wears the new face at once and puts the old one back when the save fails", async () => {
    const { host, answer } = await editing(agentView({ id: "a1" }));
    await click(drawButton());
    const drawn = faces()[0]!;
    expect(drawn).not.toBe("a1");
    expect(faces()).toEqual([drawn, drawn, "a1"]);
    expect(host.calls.find((c) => c.action === "update")?.args).toEqual({
      agentId: "a1",
      avatarSeed: drawn,
    });

    answer().reject(new Error("disk full"));
    await flush(10);
    expect(faces()).toEqual(["a1", "a1"]);
    expect(toastError).toHaveBeenCalledWith("disk full");
  });

  it("goes back to the face it wore before, the second of the recent ones", async () => {
    const agent = agentView({
      id: "a1",
      avatarSeed: "s2",
      avatarSeeds: ["s2", "s1", "a1"],
    });
    const { host, show, answer } = await editing(agent);
    expect(pressed()).toBe("s2");
    await click(document.querySelectorAll("[aria-pressed]")[1]!);
    expect(faces()[0]).toBe("s1");
    expect(pressed()).toBe("s1");
    expect(host.calls.find((c) => c.action === "update")?.args).toEqual({
      agentId: "a1",
      avatarSeed: "s1",
    });

    // Saved: the host's answer is the agent from then on.
    answer().resolve();
    await show(
      <AvatarDraw
        agent={{ ...agent, avatarSeed: "s1", avatarSeeds: ["s1", "s2", "a1"] }}
      >
        name
      </AvatarDraw>,
    );
    await flush(10);
    expect(faces()).toEqual(["s1", "s1", "s2", "a1"]);
    expect(toastError).not.toHaveBeenCalled();
  });
});
