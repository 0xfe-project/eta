import type { AgentView } from "@eta/client-contracts";
import { act } from "react";
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
  vi.useRealTimers();
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

const saves = (host: FakeHost) =>
  host.calls.filter((c) => c.action === "update").map((c) => c.args);

/** Move the draw's clock on by `ms`. */
const pass = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });

/** Let `query` match, as a user who asked for less motion has it. */
function prefer(query: string) {
  const original = window.matchMedia;
  window.matchMedia = ((media: string) => ({
    matches: media === query,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

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

  it("passes over three faces, then saves only the one it lands on, once", async () => {
    const { host } = await editing(agentView({ id: "a1" }));
    vi.useFakeTimers();
    await click(drawButton());
    const passing = [faces()[0]];
    for (let frame = 1; frame < 3; frame++) {
      await pass(60);
      passing.push(faces()[0]);
    }
    // Passing faces are shown, not worn: the row and the store still have the old one.
    expect(new Set(passing).size).toBe(3);
    expect(passing).not.toContain("a1");
    expect(faces().slice(1)).toEqual(["a1"]);
    expect(saves(host)).toEqual([]);

    // A click while it rolls is ignored, and the button stays where focus can reach it.
    await click(drawButton());
    expect(drawButton()?.disabled).toBe(false);

    await pass(60);
    const landed = faces()[0]!;
    expect(passing).not.toContain(landed);
    expect(faces()).toEqual([landed, landed, "a1"]);
    await pass(160);
    expect(saves(host)).toEqual([{ agentId: "a1", avatarSeed: landed }]);
  });

  it("lands at once, with no faces passing, for a user who asked for less motion", async () => {
    const restore = prefer("(prefers-reduced-motion: reduce)");
    try {
      const { host } = await editing(agentView({ id: "a1" }));
      await click(drawButton());
      const landed = faces()[0]!;
      expect(landed).not.toBe("a1");
      expect(faces()).toEqual([landed, landed, "a1"]);
      expect(saves(host)).toEqual([{ agentId: "a1", avatarSeed: landed }]);
    } finally {
      restore();
    }
  });

  it("puts the old face back when the save fails", async () => {
    const { host, answer } = await editing(agentView({ id: "a1" }));
    vi.useFakeTimers();
    await click(drawButton());
    await pass(340);
    vi.useRealTimers();
    const drawn = faces()[0]!;
    expect(drawn).not.toBe("a1");
    expect(faces()).toEqual([drawn, drawn, "a1"]);
    expect(saves(host)).toEqual([{ agentId: "a1", avatarSeed: drawn }]);

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
    vi.useFakeTimers();
    await click(document.querySelectorAll("[aria-pressed]")[1]!);
    // No roll: the face is there at once, saved once.
    expect(faces()[0]).toBe("s1");
    expect(pressed()).toBe("s1");
    expect(saves(host)).toEqual([{ agentId: "a1", avatarSeed: "s1" }]);
    await pass(340);
    expect(faces()[0]).toBe("s1");
    expect(saves(host)).toHaveLength(1);
    vi.useRealTimers();

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
