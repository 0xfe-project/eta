/**
 * The host through a real socket: started the way `main` starts it, a client connects to its
 * port, creates a session, prompts it, and watches the scripted model's answer arrive as state.
 * The models are scripted because the subject is the host; the socket and the frames are real.
 */
import type { ServerFrame } from "@eta/client-contracts";
import { stateSection } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { databasePath } from "../src/db";
import { connect, until } from "./support/client";
import { testHost } from "./support/host";

type StateFrame = Extract<ServerFrame, { type: "state" }>;

describe("the host", () => {
  it("says hello with the sessions and providers targets", async () => {
    const host = await testHost();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    const hello = await client.hello();

    const ops = hello.ops.map((op) => op.name);
    expect(ops).toContain("sessions.create");
    expect(ops).toContain("sessions.prompt");
    expect(ops).toContain("providers.save");
    // The eager targets: a page draws its sidebar and settings from hello without asking.
    expect(Object.keys(hello.state)).toEqual(
      expect.arrayContaining(["sessions", "providers"]),
    );
    expect(hello.mounted.map((plugin) => plugin.name)).toEqual(
      expect.arrayContaining(["sessions", "providers", "settings", "personas"]),
    );
    client.close();
  });

  it("runs a session: create, subscribe, prompt, and the reply arrives as state", async () => {
    const host = await testHost();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();

    const { session } = (await client.call("sessions", "create", {
      cwd: host.dataDir,
    })) as { session: string };
    const target = `sessions.${session}`;
    client.subscribe(target);
    await until(() =>
      client.frames.some(
        (frame) => frame.type === "state" && frame.target === target,
      ),
    );

    await client.call("sessions", "prompt", { session, text: "hello there" });
    const answered = (): boolean =>
      client.frames
        .filter(
          (frame): frame is StateFrame =>
            frame.type === "state" && frame.target === target,
        )
        .some((frame) => {
          const state = frame.snapshot ?? frame.patch;
          const transcript = state && stateSection(state, "transcript");
          return JSON.stringify(transcript?.messages ?? []).includes(
            "fake answer",
          );
        });
    await until(answered);
    client.close();
  });

  it("closes cleanly: the port is released, the client is dropped, the database is closed", async () => {
    const host = await testHost();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    await until(() => host.server.server.clients === 1);

    await host.close();
    await until(() => host.server.server.clients === 0);
    await expect(fetch(`http://127.0.0.1:${host.port}/up`)).rejects.toThrow();
    expect(() => host.db.query("SELECT 1").get()).toThrow();
  });

  it("opens its database in the data directory and migrates it", async () => {
    const host = await testHost();
    expect(host.db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(host.db.query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    // The runner has been through its bookkeeping, even with nothing to apply yet.
    expect(
      host.db
        .query("SELECT name FROM sqlite_master WHERE name = 'eta_migrations'")
        .get(),
    ).toEqual({ name: "eta_migrations" });
    expect(databasePath(host.dataDir)).toBe(`${host.dataDir}/eta.sqlite`);
  });
});
