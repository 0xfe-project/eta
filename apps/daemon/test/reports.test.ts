/** What happened to a question while no link was up is told to the primary when one is. */
import { describe, expect, it } from "vitest";
import { Reports, UNREPORTED_LIMIT } from "../src/reports";

/** A peer that only counts what it was told. */
function fakePeer() {
  const told: { method: string; params: unknown }[] = [];
  return {
    told,
    lost: false,
    notify(method: string, params?: unknown): void {
      told.push({ method, params });
    },
  };
}

describe("reports", () => {
  it("go out at once while a link is up", () => {
    const reports = new Reports<string>("ask.observe", () => undefined);
    const peer = fakePeer();
    reports.attach(peer);
    reports.send("asked");
    expect(peer.told).toEqual([{ method: "ask.observe", params: "asked" }]);
    expect(reports.waiting).toBe(0);
  });

  it("wait for the next link when there is none, and go out in order", () => {
    const reports = new Reports<string>("ask.observe", () => undefined);
    const first = fakePeer();
    reports.attach(first);
    reports.detach(first);
    reports.send("asked");
    reports.send("canceled");
    expect(first.told).toEqual([]);
    expect(reports.waiting).toBe(2);

    const second = fakePeer();
    reports.attach(second);
    expect(second.told.map((told) => told.params)).toEqual([
      "asked",
      "canceled",
    ]);
    expect(reports.waiting).toBe(0);
  });

  it("wait too when the link is lost before the daemon has noticed", () => {
    const reports = new Reports<string>("ask.observe", () => undefined);
    const peer = fakePeer();
    reports.attach(peer);
    peer.lost = true;
    reports.send("asked");
    expect(peer.told).toEqual([]);
    expect(reports.waiting).toBe(1);
  });

  it("wait when sending throws, and say so", () => {
    const warnings: string[] = [];
    const reports = new Reports<string>("ask.observe", (m) => warnings.push(m));
    reports.attach({
      lost: false,
      notify: () => {
        throw new Error("socket closed");
      },
    });
    reports.send("asked");
    expect(reports.waiting).toBe(1);
    expect(warnings[0]).toContain("socket closed");
  });

  it("keep only the newest when a link never comes back", () => {
    const reports = new Reports<number>("ask.observe", () => undefined);
    for (let i = 0; i < UNREPORTED_LIMIT + 10; i++) reports.send(i);
    expect(reports.waiting).toBe(UNREPORTED_LIMIT);
    const peer = fakePeer();
    reports.attach(peer);
    expect(peer.told[0]!.params).toBe(10);
  });
});
