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
import { Database } from "bun:sqlite";
import { unseal } from "../../apps/eta/src/secret";
import { connect, until } from "../../apps/eta/test/support/client";
import { MARK, serveModel } from "./fake-model";

const SEEDS = resolve(import.meta.dir, "..", "..", "test", "upgrade-seed");
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
export const SEED_MAIL_PASSWORD = "fake-mail-password";
export const SEED_PLUGIN_SECRET = "sk-fakefakefake";

/** Read back later: what each returned when the seed was made has to be what it returns then. */
const SAMPLES = [
  "SELECT name, model FROM agent ORDER BY name",
  "SELECT name FROM conversation WHERE name IS NOT NULL ORDER BY name",
  "SELECT title, status FROM task ORDER BY title",
  "SELECT status FROM task_run ORDER BY id",
  "SELECT title FROM artifact ORDER BY title",
  "SELECT number FROM artifact_version ORDER BY number",
  "SELECT name, address, smtp_host FROM email_account ORDER BY name",
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

const tables = (db: Database): string[] =>
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

/** Everything that is no longer as the seed left it; nothing, when it is all there. */
export function seedProblems(manifest: Manifest, dataDir: string): string[] {
  const problems: string[] = [];
  const db = new Database(join(dataDir, "eta.sqlite"), { readonly: true });
  try {
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
    const key = readFileSync(join(dataDir, "secret.key"));
    for (const { query, plain } of manifest.sealed) {
      const row = db.query<{ sealed: Uint8Array }, []>(query).get();
      const opened = row === null ? undefined : unseal(key, row.sealed);
      if (opened !== plain) problems.push(`does not open: ${query}`);
    }
  } finally {
    db.close();
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
  const call = <T>(target: string, action: string, args?: unknown) =>
    client.call(target, action, args) as Promise<T>;

  const { agent } = await call<{ agent: { id: string } }>("agents", "create", {
    name: "Ada",
    model: "fake:m1",
  });
  await call("agents", "create", { name: "Bob", model: "fake:m1" });
  const { project: made } = await call<{ project: { id: string } }>(
    "projects",
    "create",
    { path: project, stewardId: agent.id },
  );
  const { conversation } = await call<{ conversation: { id: string } }>(
    "conversations",
    "create",
    { projectId: made.id, agentIds: [agent.id], name: "Seed talk" },
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

  await call("email", "saveAccount", {
    name: "Seed mail",
    address: "seed@example.invalid",
    smtpHost: "smtp.example.invalid",
    smtpPort: 465,
    imapHost: "imap.example.invalid",
    imapPort: 993,
    pollIntervalSeconds: 86_400,
    username: "seed@example.invalid",
    password: SEED_MAIL_PASSWORD,
  });
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
        query: "SELECT value AS sealed FROM credential WHERE kind = 'password'",
        plain: JSON.stringify({ password: SEED_MAIL_PASSWORD }),
      },
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
