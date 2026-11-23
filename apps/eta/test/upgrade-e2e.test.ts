/**
 * The parts of `scripts/upgrade-e2e` that decide something without a service: what the seed check
 * leaves out on a host that has since started (the Captain a later build makes for itself, and
 * nothing else), how the button's driver reads the pre-release switch, and whether the workflow
 * still runs for the client files the browser scenario presses. The views are over the real schema,
 * so a migration that renames what they read breaks this, not a release.
 *
 * The real runs are `upgrade-cross.yml` (between releases, over `test/upgrade-seed`) and
 * `upgrade-e2e.yml`.
 */
import type { Database } from "bun:sqlite";
import type { Check } from "../../../scripts/upgrade-e2e/button";
import type { Manifest } from "../../../scripts/upgrade-e2e/seed";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasPrereleaseSwitch } from "../../../scripts/upgrade-e2e/button";
import {
  leaveOutSystemData,
  problemsIn,
  tables,
} from "../../../scripts/upgrade-e2e/seed";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";

const SAMPLES = [
  "SELECT name, model FROM agent ORDER BY name",
  "SELECT name FROM conversation ORDER BY name",
];

/**
 * What a seed holds: a person's agents (one of them called Captain), a group and a talk with each
 * agent alone (a private chat, before 0061 made those groups of one).
 */
function seedDatabase(): Database {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  // Only the three tables matter here, not the machine and project each row would need.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO agent (id, name, model, created_at, updated_at) VALUES
      ('ada', 'Ada', 'fake:m1', 1, 1),
      ('mine', 'Captain', 'fake:m1', 1, 1);
    INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES
      ('group', 'p', 'group', 'Seed talk', 1, 1),
      ('ada-direct', 'p', 'group', 'Ada alone', 1, 1),
      ('mine-direct', 'p', 'group', 'My Captain alone', 1, 1);
    INSERT INTO participant (conversation_id, agent_id, invited_at) VALUES
      ('group', 'ada', 1),
      ('group', 'mine', 1),
      ('ada-direct', 'ada', 1),
      ('mine-direct', 'mine', 1);
  `);
  return db;
}

function manifestOf(db: Database): Manifest {
  const count = (table: string) =>
    db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()!
      .n;
  return {
    version: "0.0.0",
    home: "/tmp/eta-seed-home",
    counts: Object.fromEntries(
      ["agent", "conversation", "participant"].map((t) => [t, count(t)]),
    ),
    samples: Object.fromEntries(
      SAMPLES.map((query) => [query, db.query(query).all()]),
    ),
    conversation: { id: "group", said: "", replied: "" },
    sealed: [],
  };
}

/** What a later build adds when it starts: Captain, its own conversation, and a place in the group. */
function hostStarted(db: Database): void {
  db.exec(`
    INSERT INTO agent (id, name, model, system_role, created_at, updated_at) VALUES
      ('captain', 'Captain', 'fake:m2', 'captain', 2, 2);
    INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES
      ('captain-direct', 'home', 'captain', 'Captain', 2, 2);
    INSERT INTO participant (conversation_id, agent_id, invited_at) VALUES
      ('captain-direct', 'captain', 2),
      ('group', 'captain', 2);
  `);
}

const KEY = Buffer.alloc(32);

describe("leaveOutSystemData", () => {
  it("finds the seed intact on a host that made its own Captain", () => {
    const db = seedDatabase();
    const manifest = manifestOf(db);
    hostStarted(db);
    leaveOutSystemData(db);
    expect(problemsIn(manifest, db, KEY)).toEqual([]);
  });

  it("leaves out the system agent, its direct talk and its place in a group", () => {
    const db = seedDatabase();
    hostStarted(db);
    leaveOutSystemData(db);
    const ids = (query: string) =>
      db
        .query<{ id: string }, []>(query)
        .all()
        .map(({ id }) => id);
    expect(ids("SELECT id FROM agent ORDER BY id")).toEqual(["ada", "mine"]);
    expect(ids("SELECT id FROM conversation ORDER BY id")).toEqual([
      "ada-direct",
      "group",
      "mine-direct",
    ]);
    expect(
      db
        .query<{ c: string; a: string }, []>(
          "SELECT conversation_id AS c, agent_id AS a FROM participant ORDER BY c, a",
        )
        .all(),
    ).toEqual([
      { c: "ada-direct", a: "ada" },
      { c: "group", a: "ada" },
      { c: "group", a: "mine" },
      { c: "mine-direct", a: "mine" },
    ]);
  });

  it("still checks a person's own agent called Captain, and its direct talk", () => {
    const db = seedDatabase();
    const manifest = manifestOf(db);
    hostStarted(db);
    db.exec(`
      DELETE FROM main.participant WHERE agent_id = 'mine';
      DELETE FROM main.conversation WHERE id = 'mine-direct';
      DELETE FROM main.agent WHERE id = 'mine';
    `);
    leaveOutSystemData(db);
    const problems = problemsIn(manifest, db, KEY);
    expect(problems).toContain("agent: 1 rows of 2");
    expect(problems).toContain("conversation: 2 rows of 3");
    expect(problems).toContain("participant: 2 rows of 4");
    expect(problems.join("\n")).toContain(
      "SELECT name, model FROM agent ORDER BY name: ",
    );
  });

  it("reports a renamed or deleted seed row", () => {
    const db = seedDatabase();
    const manifest = manifestOf(db);
    hostStarted(db);
    db.exec(`
      UPDATE main.agent SET name = 'Adele' WHERE id = 'ada';
      DELETE FROM main.conversation WHERE id = 'ada-direct';
    `);
    leaveOutSystemData(db);
    const problems = problemsIn(manifest, db, KEY);
    expect(problems).toEqual([
      "conversation: 2 rows of 3",
      `SELECT name, model FROM agent ORDER BY name: [{"name":"Adele","model":"fake:m1"},{"name":"Captain","model":"fake:m1"}], was [{"name":"Ada","model":"fake:m1"},{"name":"Captain","model":"fake:m1"}]`,
      `SELECT name FROM conversation ORDER BY name: [{"name":"My Captain alone"},{"name":"Seed talk"}], was [{"name":"Ada alone"},{"name":"My Captain alone"},{"name":"Seed talk"}]`,
    ]);
  });

  it("reads the tables, not the views over them", () => {
    const db = seedDatabase();
    const manifest = manifestOf(db);
    const before = tables(db);
    leaveOutSystemData(db);
    expect(tables(db)).toEqual(before);

    // The view of that name is still there, and must not stand in for the table. (The samples
    // would read it and throw, which fails the run too; this is about the count.)
    db.exec("DROP TABLE main.conversation");
    expect(tables(db)).not.toContain("conversation");
    expect(problemsIn({ ...manifest, samples: {} }, db, KEY)).toEqual([
      "table conversation is gone",
    ]);
  });

  it("does nothing on a build from before system agents", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE agent (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    leaveOutSystemData(db);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'view'",
        )
        .get()!.n,
    ).toBe(0);
  });
});

describe("hasPrereleaseSwitch", () => {
  const check = (prerelease: Check["prerelease"]): Check => ({
    blocked: null,
    latest: "0.3.0",
    ...(prerelease === undefined ? {} : { prerelease }),
  });

  it("is there when the page answers yes or no", () => {
    expect(hasPrereleaseSwitch(check(true))).toBe(true);
    expect(hasPrereleaseSwitch(check(false))).toBe(true);
  });

  it("is not there when the field is missing or null", () => {
    expect(hasPrereleaseSwitch(check(undefined))).toBe(false);
    expect(hasPrereleaseSwitch(check(null))).toBe(false);
  });
});

describe("upgrade-e2e.yml's patterns", () => {
  const { env } = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dirname, "../../../.github/workflows/upgrade-e2e.yml"),
      "utf8",
    ),
  ) as { env: Record<"on_pr" | "on_main", string> };
  const onPr = new RegExp(env.on_pr);
  const onMain = new RegExp(env.on_main);

  it("run on a pull request for the upgrade, and on a merge for the rest of the client", () => {
    expect(onPr.test("apps/client/src/pages/settings/updates/update.tsx")).toBe(
      true,
    );
    expect(onPr.test("apps/eta/src/upgrade/upgrade.ts")).toBe(true);
    expect(onPr.test("apps/daemon/src/swap.ts")).toBe(true);
    expect(onPr.test("apps/client/src/components/controls.tsx")).toBe(false);
    expect(onMain.test("apps/client/src/components/controls.tsx")).toBe(true);
  });
});
