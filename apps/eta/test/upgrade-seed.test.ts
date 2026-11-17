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
import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseSeed,
  leaveOutSystemData,
  problemsIn,
  readManifest,
  restoreSeed,
} from "../../../scripts/upgrade-e2e/seed";
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
    expect(applied).toEqual(["0054-task-archive"]);
  });

  it("is already past it at 0.4.0-rc.3, which is what an rc upgrade has to do: nothing", async () => {
    const { before, applied } = await upgraded("0.4.0-rc.3");
    expect(before.at(-1)).toBe("0054-task-archive");
    expect(applied).toEqual([]);
  });
});
