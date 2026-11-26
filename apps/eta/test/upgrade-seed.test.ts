/**
 * The seeds the release pipeline upgrades (`test/upgrade-seed/<version>`).
 *
 * A seed is what a real host of that version left behind, made by that version's own binary through
 * the calls its pages make (`scripts/upgrade-e2e/seed.ts`). The cross-version job downloads two
 * builds and does the whole thing on a runner; this file is the half that needs no download: the
 * data is put where a host keeps it, this build migrates it, and everything the seed said it held
 * has to still be there — rows, samples, and the values sealed with the seed's own key.
 *
 * It also holds the two properties the seeds are chosen for: a 0.3.0 seed is really at 0.3.0's
 * schema (so `from=0.3.0` runs 0054 instead of being handed a 0.2.0 shape, as it was before), and
 * a 0.4.0-rc.3 one is already past it, which is the rc → next answer the workflow could not ask
 * until there was a seed for an rc.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseSeed,
  leaveOutSystemData,
  problemsIn,
  readManifest,
  restoreSeed,
} from "../../../scripts/upgrade-e2e/seed";
import { AgentStore } from "../src/agents/store";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { tempDir } from "./support/host";

const SEEDS = fileURLToPath(
  new URL("../../../test/upgrade-seed", import.meta.url),
);

const seeds = readdirSync(SEEDS)
  .filter((name) => /^\d/.test(name))
  .sort((a, b) => Bun.semver.order(a, b));

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** A seed put down where a host keeps its data, and this build's migrations run on it. */
async function upgraded(version: string) {
  const seed = join(SEEDS, version);
  const home = await tempDir("eta-seed-home-");
  const dataDir = join(home, ".eta");
  // `restoreSeed` empties a data directory a host already has; it does not make one.
  mkdirSync(dataDir, { recursive: true });
  restoreSeed(seed, dataDir, home);
  const db = openDatabase(databasePath(dataDir));
  open.push(db);
  const before = db
    .query<{ id: string }, []>("SELECT id FROM eta_migrations ORDER BY id")
    .all()
    .map((row) => row.id);
  const applied = applyMigrations(db, loadMigrations());
  return { seed, home, dataDir, db, before, applied };
}

const emailTables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'email\\_%' ESCAPE '\\' OR name = 'session_email')",
    )
    .all()
    .map(({ name }) => name);

const emailCredentials = (db: Database): number =>
  db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM credential WHERE integration = 'email'",
    )
    .get()!.n;

describe("the seeds a release upgrades", () => {
  it("has the ones the versions in flight need", () => {
    expect(seeds).toEqual(expect.arrayContaining(["0.2.0", "0.3.0"]));
    // The seed a `from` version is given: the newest one it could have written. This is the
    // difference the seeds make — 0.3.0 used to be handed 0.2.0's data and migrated it, so the
    // shape people actually upgrade from was never the shape tested.
    expect(chooseSeed("0.2.0")).toBe(join(SEEDS, "0.2.0"));
    expect(chooseSeed("0.2.9")).toBe(join(SEEDS, "0.2.0"));
    expect(chooseSeed("0.3.0")).toBe(join(SEEDS, "0.3.0"));
    expect(chooseSeed("0.4.0-rc.2")).toBe(join(SEEDS, "0.3.0"));
    expect(chooseSeed("0.4.0-rc.3")).toBe(join(SEEDS, "0.4.0-rc.3"));
    // A pre-release sorts before its release, so the last rc is what a full release is given.
    expect(chooseSeed("0.4.0")).toBe(join(SEEDS, "0.4.0-rc.3"));
  });

  for (const version of seeds)
    it(`${version}: still holds everything it said, after this build's migrations`, async () => {
      const manifest = readManifest(join(SEEDS, version));
      const { dataDir, db, before, applied } = await upgraded(version);

      // The manifest is the seed's own statement: the migrations add their records and nothing
      // else may move.
      const recorded = db
        .query<{ id: string }, []>("SELECT id FROM eta_migrations ORDER BY id")
        .all()
        .map((row) => row.id);
      expect(recorded).toEqual([...before, ...applied]);
      expect(new Set(recorded).size).toBe(recorded.length);

      leaveOutSystemData(db);
      expect(
        problemsIn(manifest, db, readFileSync(join(dataDir, "secret.key"))),
      ).toEqual([]);

      // A board at rest. A task left in review whose run never delivered its summary is run again
      // by whatever host starts on the data, so a seed that ended that way would change every time
      // a service came up on it (and its own check would call that drift).
      expect(
        db
          .query<{ n: number }, []>(
            `SELECT count(*) AS n FROM task AS t
              WHERE t.status = 'in_review' AND (
                SELECT status FROM task_run WHERE task_id = t.id
                ORDER BY created_at DESC LIMIT 1) = 'failed'`,
          )
          .get()!.n,
      ).toBe(0);

      // Everything fake, as a seed has to be: the machine a container named, and the home the
      // script used, never the runner's.
      expect(manifest.home).toBe("/tmp/eta-seed-home");
      expect(
        (manifest.samples["SELECT name, kind FROM machine ORDER BY name"] ??
          []) as { name: string }[],
      ).toEqual([{ name: "eta-seed", kind: "primary" }]);
    });

  it("is at 0.3.0's schema, so a 0.3.0 upgrade really runs 0054", async () => {
    const { before, applied } = await upgraded("0.3.0");
    expect(before.at(-1)).toBe("0053-routines-run-by-captain");
    expect(applied.slice(0, 1)).toEqual(["0054-task-archive"]);
  });

  it("is already past it at 0.4.0-rc.3, which is what an rc upgrade has to do: only what came after", async () => {
    const { before, applied } = await upgraded("0.4.0-rc.3");
    expect(before.at(-1)).toBe("0054-task-archive");
    expect(applied).toEqual([
      "0055-steward-only-in-groups",
      "0056-places",
      "0057-task-usage",
      "0058-agent-avatar",
      "0059-pending-session-settings",
      "0060-interaction-context",
      "0061-captain-conversation",
      "0062-drop-email",
      "0063-plugins",
      "0064-task-attachments",
      "0065-external-runtime-bounds",
      "0066-remove-revoked-machines",
    ]);
  });

  /*
   * Every seed was made with a mailbox signed in (an account and its sealed password). After the
   * upgrade there is no email: not a table, not a credential.
   */
  for (const version of seeds)
    it(`${version}: drops the mailbox and its password`, async () => {
      const { seed, db } = await upgraded(version);
      const old = new Database(join(seed, "data", "eta.sqlite"), {
        readonly: true,
      });
      open.push(old);
      expect(emailTables(old)).toContain("email_account");
      expect(emailCredentials(old)).toBe(1);

      expect(emailTables(db)).toEqual([]);
      expect(emailCredentials(db)).toBe(0);
    });

  /*
   * Every seed's group follows its project's steward (Ada, a member) and every agent has its own
   * workspace stewarded by itself: the shape 0055 turns into a group's own steward and a
   * workspace's owner. A message that names nobody still goes to Ada.
   */
  for (const version of seeds)
    it(`${version}: keeps the group's steward, and each agent's own workspace`, async () => {
      const { db } = await upgraded(version);
      const ada = db
        .query<{ id: string }, []>("SELECT id FROM agent WHERE name = 'Ada'")
        .get()!.id;
      expect(
        db
          .query<{ steward_id: string | null }, []>(
            "SELECT steward_id FROM conversation WHERE name = 'Seed talk'",
          )
          .get(),
      ).toEqual({ steward_id: ada });
      const homes = db
        .query<{ name: string; owner: string | null }, []>(
          `SELECT p.name, a.name AS owner FROM project AS p
             LEFT JOIN agent AS a ON a.id = p.owner_agent_id
            WHERE p.kind = 'agent_home' AND p.name IN ('Ada', 'Bob') ORDER BY p.name`,
        )
        .all();
      expect(homes).toEqual([
        { name: "Ada", owner: "Ada" },
        { name: "Bob", owner: "Bob" },
      ]);
      expect(
        db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM project WHERE kind = 'project' AND owner_agent_id IS NOT NULL",
          )
          .get()!.n,
      ).toBe(0);
    });

  // No agent from before had a face of its own: each still draws it from its id.
  for (const version of seeds)
    it(`${version}: leaves every agent the face its id draws`, async () => {
      const { db } = await upgraded(version);
      const agents = new AgentStore(db).list();
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents)
        expect(agent).toMatchObject({ avatarSeed: null, avatarSeeds: [] });
    });
});
