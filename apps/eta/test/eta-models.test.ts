/**
 * There is no default model: an agent on eta's own loop and a routine run on the model they name.
 * What an upgrade does with the ones that named none, and what the host says to one that still
 * has none, or names a model the providers no longer have.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainRunError, missingModel } from "../src/agents/model";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import {
  clearMigrationInput,
  fallbackModelOf,
  stageMigrationInput,
} from "../src/model-backfill";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

const FILL = "0050-fill-eta-models";

function split() {
  const all = loadMigrations();
  const at = all.findIndex((migration) => migration.id === FILL);
  expect(at).toBeGreaterThan(0);
  return { before: all.slice(0, at), rest: all.slice(at) };
}

/** A database as the release before this one left it, with agents and routines of every kind. */
function seeded(db: Database): void {
  db.exec(`
    INSERT INTO agent (id, name, runtime, model, created_at, updated_at) VALUES
      ('unset', 'Unset', 'eta', NULL, 1, 1),
      ('empty', 'Empty', 'eta', '', 1, 1),
      ('chosen', 'Chosen', 'eta', 'a:m2', 1, 1),
      ('claude', 'Cody', 'claude', NULL, 1, 1);
    INSERT INTO routine (id, name, model, schedule, timezone, enabled, created_at, updated_at) VALUES
      ('r-unset', 'Digest', NULL, '{"kind":"daily","time":"09:00"}', 'UTC', 1, 1, 1),
      ('r-chosen', 'Report', 'a:m2', '{"kind":"daily","time":"09:00"}', 'UTC', 1, 1, 1);
  `);
}

function models(db: Database): Record<string, string | null> {
  const rows = db
    .query<{ id: string; model: string | null }, []>(
      "SELECT id, model FROM agent UNION ALL SELECT id, model FROM routine ORDER BY id",
    )
    .all();
  return Object.fromEntries(rows.map((row) => [row.id, row.model]));
}

async function configFile(content: unknown): Promise<string> {
  const dir = await tempDir("eta-config-");
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(content));
  return path;
}

const PROVIDERS = [
  {
    id: "a",
    baseUrl: "https://a.test/v1",
    models: [{ id: "m1" }, { id: "m2" }],
  },
];

describe("the model a session without one used to run on", () => {
  it.each([
    [
      "the config's default",
      { defaultModel: "a:m2", providers: PROVIDERS },
      "a:m2",
    ],
    [
      "a gateway default",
      { defaultModel: "llm:gpt-5", providers: PROVIDERS },
      "llm:gpt-5",
    ],
    [
      "the first model when there is no default",
      { providers: PROVIDERS },
      "a:m1",
    ],
    [
      "the first model when the default is not provider:model",
      { defaultModel: "m2", providers: PROVIDERS },
      "a:m1",
    ],
    ["nothing without a model", { providers: [] }, undefined],
  ] as const)("is %s", (_what, config, expected) => {
    expect(fallbackModelOf(JSON.stringify(config))).toBe(expected);
  });

  it("is nothing for a file that is missing or broken", () => {
    expect(fallbackModelOf(undefined)).toBeUndefined();
    expect(fallbackModelOf("{ not json")).toBeUndefined();
  });
});

describe("the upgrade's migration", () => {
  it("writes that model onto eta agents and routines that named none, and touches nothing else", async () => {
    const db = openDatabase(":memory:");
    const { before, rest } = split();
    applyMigrations(db, before);
    seeded(db);
    stageMigrationInput(
      db,
      await configFile({ defaultModel: "a:m1", providers: PROVIDERS }),
    );
    applyMigrations(db, rest);
    clearMigrationInput(db);
    expect(models(db)).toEqual({
      chosen: "a:m2",
      claude: null,
      empty: "a:m1",
      "r-chosen": "a:m2",
      "r-unset": "a:m1",
      unset: "a:m1",
    });
    // The staging table was this connection's, and it is gone.
    expect(
      db
        .query(
          "SELECT name FROM sqlite_temp_master WHERE name = 'migration_input'",
        )
        .all(),
    ).toEqual([]);
  });

  it("changes nothing when the config has no model to fill in", async () => {
    const db = openDatabase(":memory:");
    const { before, rest } = split();
    applyMigrations(db, before);
    seeded(db);
    const was = models(db);
    stageMigrationInput(db, join(await tempDir(), "no-config.json"));
    applyMigrations(db, rest);
    expect(models(db)).toEqual(was);
  });

  it("runs on a host start, with a config.json that still has a defaultModel", async () => {
    const dataDir = await tempDir();
    const db = openDatabase(databasePath(dataDir));
    applyMigrations(db, split().before);
    seeded(db);
    db.close();
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({ defaultModel: "a:m2", providers: PROVIDERS }),
    );
    const host = await testHost({ dataDir });
    expect(models(host.db)).toMatchObject({
      unset: "a:m2",
      empty: "a:m2",
      claude: null,
      "r-unset": "a:m2",
    });
  });
});

describe("an agent the host cannot run", () => {
  it("says so in words, for no model and for a model that is gone", () => {
    expect(missingModel({ name: "Ada", runtime: "eta", model: null })).toBe(
      "Ada has no model. Choose one in Ada's settings.",
    );
    expect(
      missingModel({ name: "Ada", runtime: "eta", model: "a:m1" }),
    ).toBeUndefined();
    expect(
      missingModel({ name: "Cody", runtime: "claude", model: null }),
    ).toBeUndefined();
    expect(explainRunError("model_unavailable: gone/away")).toBe(
      "The model gone:away is no longer available. Choose another one in the agent's settings.",
    );
    expect(explainRunError("model_unavailable: opencode-go:deepseek")).toBe(
      "The model opencode-go:deepseek is no longer available. Choose another one in the agent's settings.",
    );
    expect(explainRunError("provider exploded")).toBe("provider exploded");
  });

  it("fails the reply of an eta agent left without a model, and runs nothing on another one", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    w.host.db.query("UPDATE agent SET model = NULL WHERE id = ?").run(ada.id);
    const { conversation } = (await w.client.call("agents", "direct", {
      agentId: ada.id,
    })) as { conversation: ConversationSummary };
    await w.watch(conversation.id);
    const sent = await w.send(conversation.id, "hello");
    const reply = await w.settled(conversation.id, sent.replies[0]!.id, [
      "failed",
    ]);
    expect(reply.text).toBe("Ada has no model. Choose one in Ada's settings.");
    // No session was made for it.
    expect(
      w.host.server.sessions
        .openSessions()
        .filter((open) => open.meta.agentId === ada.id),
    ).toEqual([]);
  });
});
