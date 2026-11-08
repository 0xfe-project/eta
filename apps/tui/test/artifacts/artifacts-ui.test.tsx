/**
 * `/artifacts` against a wire the test fills: kinds the host here cannot publish (a `download`
 * version), a publisher that is gone, the order by update time, and the empty list.
 */
import type { AgentView, ArtifactView } from "@eta/client-contracts";
import type { WireClient } from "../../src/connection/types";
import type { RenderedApp } from "../ui-support/app";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "../ui-support/app";
import { fakeWire } from "../ui-support/fake-wire";
import { KEYS, plain, realDelay } from "../ui-support/render";

const open: RenderedApp[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

const MINUTE = 60_000;

function artifact(
  id: string,
  title: string,
  updatedAt: number,
  viewer: "iframe" | "download",
  publisherAgentId: string | null = "ada",
): ArtifactView {
  return {
    id,
    title,
    publisherAgentId,
    taskId: null,
    conversationId: null,
    versions: [
      {
        number: 3,
        kind: viewer === "iframe" ? "site" : "unknown",
        viewer,
        files: 1,
        bytes: 1,
        size: 1,
        createdAt: updatedAt,
        archiveUrl: `/artifacts/${id}/3/archive.zip`,
        shareUrl: null,
        sharedAt: null,
      },
    ],
    createdAt: updatedAt,
    updatedAt,
  };
}

async function show(artifacts: ArtifactView[] | undefined) {
  const wire = fakeWire({
    ops: ["artifacts.preview"],
    targets: {
      agents: {
        sections: { list: [{ id: "ada", name: "Ada" } as AgentView] },
        revisions: {},
        version: 1,
      },
      ...(artifacts === undefined
        ? {}
        : {
            artifacts: {
              sections: { list: artifacts },
              revisions: {},
              version: 1,
            },
          }),
    },
  });
  const subscribed: string[] = [];
  const watched: WireClient & { calls: string[] } = {
    ...wire,
    subscribe: (target) => {
      subscribed.push(target);
      return () => {
        subscribed.push(`-${target}`);
      };
    },
  };
  const r = await renderApp({ patch: { wire: watched }, ops: [] });
  open.push(r);
  await r.type("/artifacts");
  await r.press(KEYS.enter);
  return { r, wire: watched, subscribed };
}

const rowOf = (r: RenderedApp, title: string) =>
  plain(r)
    .split("\n")
    .find((line) => line.includes(title))
    ?.replace(/│/g, "")
    .replace(/^\s*›?\s*/, "")
    .trim() ?? "";

describe("/artifacts on a filled wire", () => {
  it("orders by update time, newest first, and leaves out a publisher it does not know", async () => {
    const now = Date.now();
    const { r } = await show([
      artifact("a", "Older", now - 3 * MINUTE, "iframe"),
      artifact("b", "Newest", now - 10_000, "iframe", "gone"),
      artifact("c", "Middle", now - 2 * 60 * MINUTE, "iframe", null),
    ]);
    const screen = plain(r);
    expect(screen.indexOf("Newest")).toBeLessThan(screen.indexOf("Older"));
    expect(screen.indexOf("Older")).toBeLessThan(screen.indexOf("Middle"));
    expect(rowOf(r, "Newest")).toMatch(/^Newest\s+v3\s+just now$/);
    expect(rowOf(r, "Older")).toMatch(/^Older\s+v3\s+Ada\s+3m ago$/);
    expect(rowOf(r, "Middle")).toMatch(/^Middle\s+v3\s+2h ago$/);
  });

  it("says a download kind cannot be previewed and asks for no address", async () => {
    const { r, wire } = await show([
      artifact("a", "Archive", Date.now(), "download"),
    ]);
    await r.press(KEYS.enter);
    expect(plain(r)).toContain(
      "This kind cannot be previewed. Download it from the web or desktop app",
    );
    expect(plain(r)).not.toContain("Valid for an hour");
    expect(wire.calls).toEqual([]);
  });

  it("follows the artifacts target only while the layer is open", async () => {
    const { r, subscribed } = await show([]);
    expect(subscribed.filter((s) => s.endsWith("artifacts"))).toEqual([
      "artifacts",
    ]);
    await r.press(KEYS.escape);
    await realDelay(20);
    expect(subscribed.filter((s) => s.endsWith("artifacts"))).toEqual([
      "artifacts",
      "-artifacts",
    ]);
  });
});
