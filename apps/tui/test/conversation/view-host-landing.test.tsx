/**
 * A reply ending on a real host, frame by frame. The line saying who is replying and the messages
 * held above the input are drawn from the same moment as the transcript, so no frame shows the
 * reply over before its words are on screen, and no frame shows a held message gone before the
 * transcript has it.
 */
import type { RenderedApp } from "../ui-support/app";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { gate, say } from "../../../eta/test/support/models";
import { until } from "../support/temp";
import { KEYS, plain, realDelay } from "../ui-support/render";
import { screenShows, withAda } from "./view-host-world";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const HINT = "Write a message";
const REPLYING = "Ada is replying";
/** Long enough for the frames that follow a reply's end to be drawn. */
const AFTER_END_MS = 1_000;

/** Each frame drawn since `from`, without colours and without the spaces that end its lines. */
const framesSince = (r: RenderedApp, from: number) =>
  r.stdout.frames
    .slice(from)
    .map((frame) => stripVTControlCharacters(frame).replace(/ +$/gm, ""));

/** The indexes of the frames from `start` on that do not hold. */
function failing(
  frames: readonly string[],
  holds: (frame: string) => boolean,
  start = 0,
): number[] {
  return frames.flatMap((frame, index) =>
    index >= start && !holds(frame) ? [index] : [],
  );
}

/** The user's own message drawn as a row of the transcript. */
const sentRow = (text: string) => (frame: string) =>
  new RegExp(`^› ${text}$`, "m").test(frame);

async function replyEnded(r: RenderedApp, answer: string): Promise<void> {
  await screenShows(r, answer);
  await until(
    async () => !plain(r).includes("is replying"),
    10_000,
    "the reply to end",
  );
  await realDelay(AFTER_END_MS);
}

describe("a reply ending", () => {
  it("shows who is replying in every frame until the reply's words are on screen", async () => {
    const letGo = gate();
    const world = await withAda(async () => {
      await letGo.opened;
      return say("pong from Ada");
    });
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await r.type("ping");
    await r.press(KEYS.enter);
    await screenShows(r, REPLYING);
    const from = r.stdout.frames.length;
    letGo.open();
    await replyEnded(r, "pong from Ada");

    const frames = framesSince(r, from);
    expect(frames.length).toBeGreaterThan(1);
    expect(
      failing(
        frames,
        (f) => f.includes(REPLYING) || f.includes("pong from Ada"),
      ),
    ).toEqual([]);
    const first = frames.findIndex((f) => f.includes("pong from Ada"));
    expect(failing(frames, (f) => f.includes("pong from Ada"), first)).toEqual(
      [],
    );
    expect(failing(frames, sentRow("ping"))).toEqual([]);
  }, 90_000);

  it("keeps a queued message drawn in every frame, held or in the transcript, as the reply before it ends", async () => {
    const letGo = gate();
    const world = await withAda(async (request) => {
      if (!request.last.includes("start working")) return say("pong from Ada");
      await letGo.opened;
      return say("started");
    });
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await world.send(world.group.id, "start working");
    await screenShows(r, REPLYING);
    await r.type("ping");
    await r.press(KEYS.enter);
    await screenShows(r, "⧗ ping");
    const from = r.stdout.frames.length;
    letGo.open();
    await replyEnded(r, "pong from Ada");

    const frames = framesSince(r, from);
    expect(frames.length).toBeGreaterThan(1);
    expect(
      failing(frames, (f) => f.includes("⧗ ping") || sentRow("ping")(f)),
    ).toEqual([]);
    expect(
      failing(frames, (f) => f.includes(REPLYING) || f.includes("started")),
    ).toEqual([]);
    const first = frames.findIndex((f) => f.includes("started"));
    expect(failing(frames, (f) => f.includes("started"), first)).toEqual([]);
  }, 90_000);
});
