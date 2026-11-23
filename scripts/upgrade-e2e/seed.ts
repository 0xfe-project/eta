/**
 * The data an upgrade has to keep: `test/upgrade-seed/<version>/`, one directory per release that
 * changed what a host stores. All of it is made up. The directory is what a host of that version
 * left in `~/.eta` after a person used it, through the same calls the page makes, and
 * `manifest.json` is what must still be true of it later.
 *
 *   bun scripts/upgrade-e2e/seed.ts <eta-host> <version>
 *
 * It starts that build with a HOME of its own (`docs/release.md`). The rest of this file is what
 * `drive.ts` uses to put a seed under a service and to check it afterwards.
 */
import type { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { unseal } from "../../apps/eta/src/secret";
import { connect, until } from "../../apps/eta/test/support/client";
import { MARK, serveModel } from "./fake-model";

// A URL, not `import.meta.dir`: apps/eta's tests load this under vitest, which has no `dir`.
const SEEDS = fileURLToPath(
  new URL("../../test/upgrade-seed", import.meta.url),
);
/** Where the seed was made, and what paths in it start with. Replaced when it is put down. */
const SEED_HOME = "/tmp/eta-seed-home";
const SEED_PORT = 18_894;
export const MODEL_PORT = 19_901;
const CONFIG = {
  providers: [
    {
      id: "fake",
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`,
      apiKey: "not-a-real-key",
      models: [{ id: "m1", name: "m1", contextWindow: 128_000 }],
    },
  ],
};
export const SEED_PLUGIN_SECRET = "sk-fakefakefake";

/** Read back later: what each returned when the seed was made has to be what it returns then. */
const SAMPLES = [
  "SELECT name, model FROM agent ORDER BY name",
  "SELECT name FROM conversation WHERE name IS NOT NULL ORDER BY name",
  "SELECT title, status FROM task ORDER BY title",
  "SELECT status FROM task_run ORDER BY id",
  "SELECT title FROM artifact ORDER BY title",
  "SELECT number FROM artifact_version ORDER BY number",
  "SELECT name FROM routine ORDER BY name",
  "SELECT name, kind FROM machine ORDER BY name",
  "SELECT key FROM setting ORDER BY key",
];

export interface Manifest {
  version: string;
  home: string;
  /** Rows in each table with any. */
  counts: Record<string, number>;
  samples: Record<string, unknown[]>;
  /** A conversation with its text, to open and to go on with. */
  conversation: { id: string; said: string; replied: string };
  sealed: { query: string; plain: string }[];
}

/**
 * The database's own tables, from `sqlite_master`: that is the main schema's catalogue, so the
 * temporary views `leaveOutSystemData` puts over some of them neither add names nor stand in for
 * a table that is gone.
 */
export const tables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'eta_migrations' AND name NOT LIKE '%\\_fts%' ESCAPE '\\'",
    )
    .all()
    .map(({ name }) => name);

const count = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()!.n;

/** The newest seed a build of `version` can have written: a later one may not open under it. */
export function chooseSeed(version: string): string {
  const fits = readdirSync(SEEDS)
    .filter((name) => /^\d/.test(name))
    .filter((name) => Bun.semver.order(name, version) <= 0)
    .sort(Bun.semver.order);
  const chosen = fits.at(-1);
  if (chosen === undefined) throw new Error(`no seed for ${version}`);
  return join(SEEDS, chosen);
}

export const readManifest = (seed: string): Manifest =>
  JSON.parse(readFileSync(join(seed, "manifest.json"), "utf8")) as Manifest;

/** Put a seed where a host keeps its data, with the service stopped. */
export function restoreSeed(seed: string, dataDir: string, home: string): void {
  // `service` is not data: on Windows it is what the service runs from.
  for (const name of readdirSync(dataDir))
    if (name !== "service")
      rmSync(join(dataDir, name), { recursive: true, force: true });
  cpSync(join(seed, "data"), dataDir, { recursive: true });
  chmodSync(join(dataDir, "secret.key"), 0o600);
  const db = new Database(join(dataDir, "eta.sqlite"));
  try {
    db.query(
      "UPDATE project SET path = ?1 || substr(path, ?2) WHERE path LIKE ?3",
    ).run(home, SEED_HOME.length + 1, `${SEED_HOME}%`);
    // Git keeps no empty directories, and an agent's home is one.
    for (const { path } of db
      .query<{ path: string }, []>("SELECT path FROM project")
      .all())
      mkdirSync(path, { recursive: true });
  } finally {
    db.close();
  }
  const escaped = JSON.stringify(home).slice(1, -1);
  for (const file of readdirSync(join(dataDir, "sessions"), {
    recursive: true,
  }).map(String)) {
    if (!/\.jsonl?$/.test(file)) continue;
    const path = join(dataDir, "sessions", file);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(SEED_HOME, escaped),
    );
  }
}

/**
 * What a host makes for itself when it starts, out of what it is checked on: a later build makes
 * agents with a system role (Captain) and Captain's own conversation, which no seed has. The
 * agents are told by `system_role`, not by name, so a person's agent called Captain is still the
 * seed's. Temporary views of the same names come first in every query of this connection, the
 * manifest's own included; nothing is written to the database.
 *
 * The two rules below are not the same, on purpose for now:
 *
 * - `participant` leaves out every row of a system agent, in any conversation: a group a person
 *   made and then gave to Captain is the person's, and keeps its other members.
 * - `conversation` leaves out only Captain's own: kind `captain` since 0061, and before that the
 *   `direct` conversation with a system agent it had. That is everything a host makes for itself
 *   today; every group with Captain in it was made by a person, so it belongs in the check.
 *
 * It stops holding when a build makes another conversation for itself (a group of its own, say):
 * that conversation stays in the view, shows up in the samples of an upgraded host, and the check
 * reports it as drift although the seed is intact. Then leave out whatever that build makes, by how
 * it marks it, not by dropping the `kind` test: a person's group with Captain in it must still be
 * checked. apps/eta/test/upgrade-e2e.test.ts holds both rules.
 */
export function leaveOutSystemData(db: Database): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(agent)")
    .all();
  if (!columns.some(({ name }) => name === "system_role")) return;
  const system = "SELECT id FROM main.agent WHERE system_role IS NOT NULL";
  db.exec(`
    CREATE TEMP VIEW agent AS
      SELECT * FROM main.agent WHERE system_role IS NULL;
    CREATE TEMP VIEW conversation AS
      SELECT * FROM main.conversation AS c
      WHERE c.kind <> 'captain' AND NOT (c.kind = 'direct' AND EXISTS (
        SELECT 1 FROM main.participant AS p
        WHERE p.conversation_id = c.id AND p.agent_id IN (${system})));
    CREATE TEMP VIEW participant AS
      SELECT * FROM main.participant WHERE agent_id NOT IN (${system});
  `);
}

/** Everything that is no longer as the seed left it; nothing, when it is all there. */
export function seedProblems(manifest: Manifest, dataDir: string): string[] {
  const db = new Database(join(dataDir, "eta.sqlite"), { readonly: true });
  try {
    leaveOutSystemData(db);
    return problemsIn(manifest, db, readFileSync(join(dataDir, "secret.key")));
  } finally {
    db.close();
  }
}

/** `seedProblems` on an open database, with `leaveOutSystemData` already over it. */
export function problemsIn(
  manifest: Manifest,
  db: Database,
  key: Buffer,
): string[] {
  const problems: string[] = [];
  const present = new Set(tables(db));
  for (const [table, seeded] of Object.entries(manifest.counts)) {
    if (!present.has(table)) problems.push(`table ${table} is gone`);
    else if (count(db, table) < seeded)
      problems.push(`${table}: ${count(db, table)} rows of ${seeded}`);
  }
  for (const [query, rows] of Object.entries(manifest.samples)) {
    const now = JSON.stringify(db.query(query).all());
    if (now !== JSON.stringify(rows))
      problems.push(`${query}: ${now}, was ${JSON.stringify(rows)}`);
  }
  for (const { query, plain } of manifest.sealed) {
    const row = db.query<{ sealed: Uint8Array }, []>(query).get();
    const opened = row === null ? undefined : unseal(key, row.sealed);
    if (opened !== plain) problems.push(`does not open: ${query}`);
  }
  return problems;
}

async function generate(binary: string, version: string): Promise<void> {
  const home = SEED_HOME;
  const data = join(home, ".eta");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify(CONFIG));
  const project = join(home, "seed-project");
  mkdirSync(join(project, "site"), { recursive: true });
  writeFileSync(
    join(project, "site", "index.html"),
    "<!doctype html><title>seed</title><p>A made-up page.</p>\n",
  );
  const plugin = join(data, "plugins", "seed-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "seed-plugin",
      version: "1.0.0",
      description: "A made-up plugin with a secret.",
      license: "MIT",
      extensions: {
        "tech.0xfe.eta": {
          config: {
            api_key: {
              type: "string",
              title: "API key",
              description: "Made up.",
              required: true,
              secret: true,
            },
            team: { type: "string", title: "Team" },
          },
        },
      },
    }),
  );

  const model = serveModel(MODEL_PORT);
  const host = spawn(
    binary,
    ["--port", String(SEED_PORT), "--no-web", "--no-llm"],
    { env: { ...process.env, HOME: home }, stdio: "inherit" },
  );
  const origin = `http://127.0.0.1:${SEED_PORT}`;
  await until(
    () =>
      fetch(`${origin}/up`).then(
        (a) => a.ok,
        () => false,
      ),
    60_000,
  );

  const client = await connect(`ws://127.0.0.1:${SEED_PORT}/ws`, { origin });
  await client.hello();
  /**
   * A call, waiting for the host to have the op. `/up` answers as soon as the host is listening,
   * and a host mounts its plugins one by one after that, so the hello a client connects with can
   * be missing half of them: an older build (0.3.0) is slow enough to lose that race, and every
   * call then fails `unknown op`. An op that is not mounted has not run, so asking again is safe.
   */
  const call = async <T>(
    target: string,
    action: string,
    args?: unknown,
  ): Promise<T> => {
    const missing = `unknown op: ${target}.${action}`;
    for (const until = Date.now() + 60_000; ; ) {
      try {
        return (await client.call(target, action, args)) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(missing) || Date.now() > until) throw error;
        await Bun.sleep(100);
      }
    }
  };

  const { agent } = await call<{ agent: { id: string } }>("agents", "create", {
    name: "Ada",
    model: "fake:m1",
  });
  await call("agents", "create", { name: "Bob", model: "fake:m1" });
  // Ada stewards the group. A host before 0.5 kept that on the project (its `stewardId`, which
  // the group followed); a later one keeps it on the group and ignores the project's. Both are
  // sent, so a seed of either kind has Ada there to answer a message that names nobody.
  const { project: made } = await call<{ project: { id: string } }>(
    "projects",
    "create",
    { path: project, stewardId: agent.id },
  );
  const { conversation } = await call<{ conversation: { id: string } }>(
    "conversations",
    "create",
    {
      projectId: made.id,
      agentIds: [agent.id],
      stewardId: agent.id,
      name: "Seed talk",
    },
  );
  const say = async (text: string): Promise<void> => {
    await call("conversations", "send", {
      conversationId: conversation.id,
      text: `@Ada ${text}`,
      mentions: [agent.id],
    });
  };
  const db = new Database(join(data, "eta.sqlite"), { readonly: true });
  const rows = (table: string): number => count(db, table);
  const settled = () =>
    until(
      () =>
        db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM task_run WHERE status IN ('queued', 'running')",
          )
          .get()!.n === 0,
      60_000,
    );

  const said = "Is this thing on?";
  await say(said);
  await until(() => rows("message") >= 2, 30_000);
  await say(MARK.artifact);
  await until(() => rows("artifact") >= 1, 30_000);
  const artifact = db
    .query<{ id: string }, []>("SELECT id FROM artifact")
    .get()!;
  await say(`${MARK.version}${artifact.id}]`);
  await until(() => rows("artifact_version") >= 2, 30_000);
  await say(MARK.task);
  await until(() => rows("task") >= 1, 30_000);
  await until(() => rows("task_run") >= 1, 30_000);
  await settled();
  // A task a host left in review stays put only until the next host starts on it: one whose run
  // never delivered its summary is run again, so the seed would change under its own check every
  // time a service started on it. Close it, the way a person would — a board at rest is what the
  // seed is for (and a done task is what 0054's archiver is about).
  const seeded = db
    .query<{ id: string }, []>("SELECT id FROM task ORDER BY number LIMIT 1")
    .get();
  if (seeded === null) throw new Error("the seed made no task to close");
  await call("tasks", "update", { taskId: seeded.id, status: "done" });

  await call("plugins", "recheck");
  await call("plugins", "configure", {
    name: "seed-plugin",
    values: { api_key: SEED_PLUGIN_SECRET, team: "seed team" },
  });
  await call("machines", "enroll", { name: "seed-box" });
  await call("routines", "create", {
    name: "Seed routine",
    brief: "Nothing real.",
    schedule: { kind: "daily", time: "09:00" },
    timezone: "UTC",
    agentId: agent.id,
    projectId: made.id,
  });
  await call("inbox", "setApprovals", { tools: ["bash"] });

  client.close();
  db.close();
  const gone = new Promise((done) => host.once("exit", done));
  host.kill("SIGTERM");
  await gone;
  await model.stop(true);

  const stopped = new Database(join(data, "eta.sqlite"));
  stopped.exec("PRAGMA journal_mode = DELETE");
  stopped.exec("VACUUM");
  // The manifest is what the check will read back, so it is read through the same lens: what a
  // host makes for itself (a Captain and its own conversation, a system agent) is left out of
  // both, because the upgraded host makes its own. A build that has a Captain would otherwise
  // write a seed its own check calls wrong.
  leaveOutSystemData(stopped);
  const reply = stopped
    .query<{ text: string }, []>(
      "SELECT text FROM message WHERE agent_id IS NOT NULL AND text LIKE 'Heard:%' ORDER BY seq LIMIT 1",
    )
    .get();
  if (reply === null) throw new Error("no reply to keep");
  const manifest: Manifest = {
    version,
    home,
    counts: Object.fromEntries(
      tables(stopped)
        .map((table) => [table, count(stopped, table)] as const)
        .filter(([, rows]) => rows > 0),
    ),
    samples: Object.fromEntries(
      SAMPLES.map((query) => [query, stopped.query(query).all()]),
    ),
    conversation: { id: conversation.id, said, replied: reply.text },
    sealed: [
      {
        query: "SELECT sealed FROM plugin_config WHERE plugin = 'seed-plugin'",
        plain: JSON.stringify({
          api_key: SEED_PLUGIN_SECRET,
          team: "seed team",
        }),
      },
    ],
  };
  stopped.close();

  const out = join(SEEDS, version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(data, join(out, "data"), {
    recursive: true,
    filter: (path) => !/\.sqlite-(?:wal|shm)$/.test(path),
  });
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const problems = seedProblems(manifest, join(out, "data"));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(`seed for ${version} in ${relative(process.cwd(), out)}`);
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2);
  if (binary === undefined || version === undefined)
    throw new Error("usage: seed.ts <eta-host> <version>");
  await generate(resolve(binary), version);
}
