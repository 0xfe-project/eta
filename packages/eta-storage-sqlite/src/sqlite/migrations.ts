import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./types.ts";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));

async function loadMigrations(directory: string) {
	const names = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
	const migrations = names.map((name) => {
		const match = /^(\d+)_([a-z0-9_]+)\.sql$/.exec(name);
		if (match === null) throw new Error(`Invalid SQLite migration filename: ${name}`);
		return { name, version: Number(match[1]) };
	}).sort((left, right) => left.version - right.version);
	if (migrations.length === 0) throw new Error("No SQLite migrations found");
	for (const [index, migration] of migrations.entries()) {
		if (migration.version !== index + 1) {
			throw new Error(`SQLite migrations must be consecutive from 1: ${migration.name}`);
		}
	}
	return Promise.all(migrations.map(async (migration) => ({
		...migration,
		sql: await readFile(join(directory, migration.name), "utf8"),
	})));
}

function schemaVersion(db: SqliteDatabase): number {
	const version = db.prepare("PRAGMA user_version").get<{ user_version: number }>()?.user_version;
	if (version === undefined || !Number.isSafeInteger(version) || version < 0) {
		throw new Error("Invalid SQLite schema version");
	}
	return version;
}

function checkSupported(version: number, latest: number): void {
	if (version > latest) {
		throw new Error(`SQLite schema version ${version} is newer than supported version ${latest}; update eta before opening this database`);
	}
}

/**
 * Apply bundled, numbered SQL files before using a writable database. user_version
 * tracks the physical schema, independently of the app and session storage versions.
 * Read files before taking the write lock; re-read the version inside the lock so
 * competing opens cannot both apply an ALTER TABLE. The entire upgrade is atomic.
 * SQL files must not contain transaction control or change user_version themselves.
 */
export async function applyMigrations(db: SqliteDatabase, directory = MIGRATIONS_DIRECTORY): Promise<void> {
	const migrations = await loadMigrations(directory);
	const latest = migrations.length;
	const current = schemaVersion(db);
	checkSupported(current, latest);
	if (current === latest) return;

	db.exec("BEGIN IMMEDIATE");
	try {
		const version = schemaVersion(db);
		checkSupported(version, latest);
		for (const migration of migrations) {
			if (migration.version <= version) continue;
			try {
				db.exec(migration.sql);
			} catch (cause) {
				throw new Error(`SQLite migration ${migration.name} failed`, { cause });
			}
			db.exec(`PRAGMA user_version = ${migration.version}`);
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the migration error if the connection also fails to roll back.
		}
		throw error;
	}
}

/** Read-only discovery/fork sources never silently migrate another owner's file. */
export async function assertReadableSchema(db: SqliteDatabase, metadataOnly = false): Promise<void> {
	const latest = (await loadMigrations(MIGRATIONS_DIRECTORY)).length;
	const version = schemaVersion(db);
	checkSupported(version, latest);
	// Discovery only reads the stable sessions metadata columns, so old sessions
	// remain discoverable before open() upgrades them. Full reads require migration.
	// Existing installations predate user_version and already have the 001 schema.
	if (!metadataOnly && version !== latest && !(version === 0 && latest === 1)) {
		throw new Error(`SQLite schema version ${version} requires migration to ${latest}; open this database with its owning repository first`);
	}
}

/** Compatibility entry point for callers that previously initialized the schema. */
export const applyInitialSchema = applyMigrations;
