import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@eta/core";
import { describe, expect, it } from "vitest";
import { applyMigrations, createNodeSqliteFactory, SqliteSessionRepo, type SqliteDatabase } from "../src/index.ts";

const CTX = BACKGROUND_CONTEXT;
const initialSchema = () => readFile(new URL("../src/sqlite/migrations/001_initial.sql", import.meta.url), "utf8");
const version = (db: SqliteDatabase) => db.prepare("PRAGMA user_version").get<{ user_version: number }>()!.user_version;

async function fixture(run: (directory: string, db: SqliteDatabase) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "eta-migrations-"));
	const db = await createNodeSqliteFactory().open(":memory:");
	try {
		await run(directory, db);
	} finally {
		db.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function baseline(directory: string) {
	await writeFile(join(directory, "001_initial.sql"), await initialSchema());
}

function seed(db: SqliteDatabase) {
	db.exec("INSERT INTO scalar_values VALUES ('session', 'test', 'note', 1, '\"keep me\"')");
}

const addColumn = "ALTER TABLE scalar_values ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';";

describe("SQLite migrations", () => {
	it("initializes a fresh database and does nothing on repeated opens", async () => {
		await fixture(async (_directory, db) => {
			await applyMigrations(db);
			expect(version(db)).toBe(1);
			seed(db);
			await applyMigrations(db);
			expect(db.prepare("SELECT value FROM scalar_values").get()).toEqual({ value: '"keep me"' });
		});
	});

	it("adopts an unversioned legacy database and upgrades fields without losing data", async () => {
		await fixture(async (directory, db) => {
			await baseline(directory);
			db.exec(await initialSchema());
			seed(db);
			expect(version(db)).toBe(0);
			await writeFile(join(directory, "002_origin.sql"), addColumn);
			await writeFile(join(directory, "003_backfill.sql"), "UPDATE scalar_values SET origin = 'imported' WHERE origin = 'legacy';");
			await applyMigrations(db, directory);
			expect(version(db)).toBe(3);
			expect(db.prepare("SELECT value, origin FROM scalar_values").get()).toEqual({ value: '"keep me"', origin: "imported" });
			// Replaying ALTER TABLE would fail; a current database skips it.
			await applyMigrations(db, directory);
		});
	});

	it("upgrades a versioned database when a later application supplies a new migration", async () => {
		await fixture(async (directory, db) => {
			await baseline(directory);
			await applyMigrations(db, directory);
			seed(db);
			await writeFile(join(directory, "002_origin.sql"), addColumn);
			await applyMigrations(db, directory);
			expect(version(db)).toBe(2);
			expect(db.prepare("SELECT value, origin FROM scalar_values").get()).toEqual({ value: '"keep me"', origin: "legacy" });
		});
	});

	it("rolls back the entire pending upgrade and can retry after a failure", async () => {
		await fixture(async (directory, db) => {
			await baseline(directory);
			await applyMigrations(db, directory);
			seed(db);
			await writeFile(join(directory, "002_origin.sql"), addColumn);
			await writeFile(join(directory, "003_backfill.sql"), "DELETE FROM scalar_values; INSERT INTO missing_table VALUES (1);");
			await expect(applyMigrations(db, directory)).rejects.toThrow("003_backfill.sql failed");
			expect(version(db)).toBe(1);
			expect(db.prepare("SELECT value FROM scalar_values").get()).toEqual({ value: '"keep me"' });
			expect(() => db.prepare("SELECT origin FROM scalar_values")).toThrow();
			await writeFile(join(directory, "003_backfill.sql"), "UPDATE scalar_values SET origin = 'fixed';");
			await applyMigrations(db, directory);
			expect(version(db)).toBe(3);
			expect(db.prepare("SELECT origin FROM scalar_values").get()).toEqual({ origin: "fixed" });
		});
	});

	it("rejects newer database versions without changing them", async () => {
		await fixture(async (_directory, db) => {
			await applyMigrations(db);
			seed(db);
			db.exec("PRAGMA user_version = 999");
			await expect(applyMigrations(db)).rejects.toThrow("newer than supported");
			expect(version(db)).toBe(999);
			expect(db.prepare("SELECT value FROM scalar_values").get()).toEqual({ value: '"keep me"' });
		});
	});

	it.each(["003_gap.sql", "001_duplicate.sql", "invalid.sql"])("rejects an invalid migration sequence: %s", async (name) => {
		await fixture(async (directory, db) => {
			await baseline(directory);
			await writeFile(join(directory, name), "CREATE TABLE should_not_exist (id INTEGER);");
			await expect(applyMigrations(db, directory)).rejects.toThrow(/migration/i);
			expect(version(db)).toBe(0);
			expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
		});
	});

	it.each([false, true])("repository open upgrades legacy files (shared container: %s)", async (shared) => {
		await fixture(async (directory) => {
			const factory = createNodeSqliteFactory();
			const path = join(directory, shared ? "shared.sqlite" : "legacy.sqlite");
			const repo = new SqliteSessionRepo({ directory, databaseFactory: factory, ...(shared ? { databasePath: path } : {}) });
			try {
				const created = await repo.create({ id: "legacy" }, CTX);
				await created.close(CTX);
				const old = await factory.openExisting(path);
				try {
					old.exec("PRAGMA user_version = 0");
					seed(old);
				} finally { old.close(); }
				const [metadata] = await repo.list(undefined, CTX);
				expect(metadata?.id).toBe("legacy");
				const probe = await factory.openReadOnly(path);
				try { expect(version(probe)).toBe(0); } finally { probe.close(); }
				const opened = await repo.open(metadata!, CTX);
				await opened.close(CTX);
				const read = await factory.openReadOnly(path);
				try {
					expect(version(read)).toBe(1);
					expect(read.prepare("SELECT value FROM scalar_values WHERE key = 'note'").get()).toEqual({ value: '"keep me"' });
				} finally { read.close(); }
				const newer = await factory.openExisting(path);
				try { newer.exec("PRAGMA user_version = 999"); } finally { newer.close(); }
				await expect(repo.open(metadata!, CTX)).rejects.toThrow("newer than supported");
				expect(await repo.list(undefined, CTX)).toEqual([]);
				const reset = await factory.openExisting(path);
				try { reset.exec("PRAGMA user_version = 1"); } finally { reset.close(); }
				// A failed migration must release local ownership so opening can be retried.
				await (await repo.open(metadata!, CTX)).close(CTX);
			} finally { await repo.close(CTX); }
		});
	});
});
