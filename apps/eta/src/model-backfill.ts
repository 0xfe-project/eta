/**
 * What `0050-fill-eta-models.sql` needs from outside the database: the model an agent or routine
 * that named none was running on. That was the config's `defaultModel`, else the config's first
 * model — the fallback the host had before it dropped default models. SQL cannot read the
 * config, so the host stages that model in a temporary table on the connection it migrates with.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** `provider:modelId` with both halves present. */
function isModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const split = value.indexOf(":");
  return split > 0 && split < value.length - 1;
}

/**
 * The model a session without one used to run on, read from the config's text: `defaultModel`,
 * else the first provider's first model. Undefined when the file is missing, does not parse, or
 * has no model.
 */
export function fallbackModelOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof config !== "object" || config === null) return undefined;
  const { defaultModel, providers } = config as {
    defaultModel?: unknown;
    providers?: unknown;
  };
  if (isModelId(defaultModel)) return defaultModel.trim();
  if (!Array.isArray(providers)) return undefined;
  for (const provider of providers as { id?: unknown; models?: unknown }[]) {
    if (typeof provider?.id !== "string" || !Array.isArray(provider.models))
      continue;
    for (const model of provider.models as { id?: unknown }[]) {
      if (typeof model?.id === "string" && model.id !== "")
        return `${provider.id}:${model.id}`;
    }
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Put the fallback model where the migration reads it. Temporary, so it is this connection's
 * alone and never written to the file; `clearMigrationInput` drops it once migrating is done.
 */
export function stageMigrationInput(db: Database, configPath: string): void {
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS migration_input (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  db.exec("DELETE FROM temp.migration_input");
  const model = fallbackModelOf(readText(configPath));
  if (model !== undefined)
    db.query(
      "INSERT INTO temp.migration_input (key, value) VALUES ('fallback_model', ?)",
    ).run(model);
}

export function clearMigrationInput(db: Database): void {
  db.exec("DROP TABLE IF EXISTS temp.migration_input");
}
