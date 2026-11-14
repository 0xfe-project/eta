/**
 * Captain's own agent is made the way every agent is written (`writeAgent`): all of it or none of
 * it. It skips the rules for the agents users add — no model, the captain role, the fixed name —
 * so a user agent that is already called "Captain" does not stop the host from starting.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { databasePath } from "../src/db";
import { tempDir, testHost } from "./support/host";

const count = (db: Database, sql: string) =>
  db.query<{ n: number }, []>(sql).get()!.n;

describe("the first start of Captain", () => {
  it("leaves no agent row, project or directory behind when making it fails, and works next time", async () => {
    const dataDir = await tempDir();
    // The schema, without Captain.
    const plain = await testHost({ dataDir, captain: false });
    await plain.close();
    // Writing the base prompt — the last row of Captain's creation — fails.
    const db = new Database(databasePath(dataDir));
    db.run(`CREATE TRIGGER fail_base BEFORE INSERT ON captain_prompt_version
            WHEN NEW.kind = 'base' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
    db.close();

    await expect(testHost({ dataDir, captain: true })).rejects.toThrow(
      /disk on fire/,
    );

    const after = new Database(databasePath(dataDir));
    expect(count(after, "SELECT COUNT(*) AS n FROM agent")).toBe(0);
    expect(
      count(
        after,
        "SELECT COUNT(*) AS n FROM project WHERE kind = 'agent_home'",
      ),
    ).toBe(0);
    expect(
      count(after, "SELECT COUNT(*) AS n FROM captain_prompt_version"),
    ).toBe(0);
    expect(await readdir(join(dataDir, "agents")).catch(() => [])).toEqual([]);
    after.run("DROP TRIGGER fail_base");
    after.close();

    const host = await testHost({ dataDir, captain: true });
    const identity = host.product.captain.identity()!;
    expect(identity.name).toBe("Captain");
    expect(await readdir(join(dataDir, "agents"))).toEqual([identity.agentId]);
    expect(
      host.product.captain.store.latestPrompt("global", "base")?.version,
    ).toBe(1);
  });

  it("is made even when a user agent is already called Captain", async () => {
    const dataDir = await tempDir();
    const plain = await testHost({ dataDir, captain: false });
    const db = plain.db;
    db.run(
      `INSERT INTO agent (id, name, instructions, persona, runtime, model, created_at, updated_at)
       VALUES ('user-captain', 'captain', '', '', 'eta', 'fake:fake-model', 1, 1)`,
    );
    await plain.close();

    const host = await testHost({ dataDir, captain: true });
    const identity = host.product.captain.identity()!;
    expect(identity.agentId).not.toBe("user-captain");
    expect(identity.name).toBe("Captain");
    expect(
      host.db
        .query<{ id: string; role: string | null }, []>(
          "SELECT id, system_role AS role FROM agent ORDER BY created_at",
        )
        .all(),
    ).toEqual([
      { id: "user-captain", role: null },
      { id: identity.agentId, role: "captain" },
    ]);
  });

  it("does not make a second Captain when one is there", async () => {
    const dataDir = await tempDir();
    const first = await testHost({ dataDir, captain: true });
    const id = first.product.captain.identity()!.agentId;
    await first.close();
    const again = await testHost({ dataDir, captain: true });
    expect(again.product.captain.identity()!.agentId).toBe(id);
    expect(
      count(
        again.db,
        "SELECT COUNT(*) AS n FROM agent WHERE system_role = 'captain'",
      ),
    ).toBe(1);
  });
});
