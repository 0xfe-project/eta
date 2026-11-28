/**
 * `AcpAdmin`: the one piece of code that edits a machine's `acp.json`, on the primary and on every
 * daemon alike. What these pin: an older file's `cwd` and `autoAllow` are read past and gone after
 * the next save; a file that cannot be read whole is never written over; `save` does not wait for
 * the look, and `settled` does.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AcpAdmin, createAcpRuntimes } from "../src/index";
import { configFile, fakeAgent, until } from "./support";

function admin(path: string) {
  let changes = 0;
  const acp = createAcpRuntimes({ configPath: path });
  return {
    admin: new AcpAdmin({ acp, changed: () => changes++ }),
    changes: () => changes,
  };
}

describe("an acp.json from before cwd and autoAllow went", () => {
  it("lists without them, and the next save writes them out of the file", () => {
    const one = fakeAgent("one").config;
    const two = fakeAgent("two").config;
    const path = configFile([]);
    writeFileSync(
      path,
      JSON.stringify({
        agents: [{ ...one, cwd: "/srv/old", autoAllow: false }],
      }),
    );
    const { admin: a } = admin(path);
    const [listed] = a.list();
    expect(listed).not.toHaveProperty("cwd");
    expect(listed).not.toHaveProperty("autoAllow");
    a.save(two);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      agents: [one, two],
    });
  });
});

describe("a file that cannot be read whole", () => {
  it("keeps a bad agent: saving the good one beside it is refused, and not a byte is written", () => {
    const good = fakeAgent("good").config;
    const path = configFile([]);
    const text = JSON.stringify({
      agents: [{ id: "Bad Id", command: "x" }, good],
    });
    writeFileSync(path, text);
    const { admin: a, changes } = admin(path);
    expect(() => a.save({ ...good, label: "Better" }, "good")).toThrow(
      /agent 1 \("Bad Id"\): the id "Bad Id" is not valid/,
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(changes()).toBe(0);
  });
});

describe("saving", () => {
  it("returns before the look, which arrives as a change; settled waits for it", async () => {
    const slow = fakeAgent("slow", {
      env: { FAKE_ACP_INIT_DELAY_MS: "1500" },
    }).config;
    const { admin: a, changes } = admin(configFile([]));
    const started = Date.now();
    expect(a.save(slow)).toMatchObject({
      status: "available",
      detail: "Checking…",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    const after = changes();
    const settled = await a.settled();
    expect(settled[0]).toMatchObject({ status: "available", version: "0.0.1" });
    await until(() => changes() > after, "the change after the look");
  }, 20_000);
});
