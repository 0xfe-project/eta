import { homedir } from "node:os";
/**
 * A build that passes every check made before the restart and does not last after it: it runs its
 * migration, ruins the data, answers `/up` and dies. What is left is for the upgrade to put back.
 * Cheap on purpose, so each platform can have one without building a host:
 *
 *   bun build --compile scripts/upgrade-e2e/bad-host.ts --outfile <builds>/99.0.0/<asset>
 */
import { join } from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";

const MIGRATION = "9999-bad.sql";
const args = process.argv.slice(2);
const database = join(homedir(), ".eta", "eta.sqlite");

if (args.includes("--version")) {
  console.log("eta-host 99.0.0 (bad)");
  process.exit(0);
}
if (args.includes("--migrations")) {
  const db = new Database(database, { readonly: true });
  const rows = db.query<{ id: string }, []>("SELECT id FROM eta_migrations");
  console.log([...rows.all().map(({ id }) => id), MIGRATION].join("\n"));
  process.exit(0);
}

const db = new Database(database);
db.query("INSERT INTO eta_migrations (id, applied_at) VALUES (?, 1)").run(
  MIGRATION,
);
db.exec("DELETE FROM message; UPDATE task SET title = 'ruined'");
db.close();

const port = Number(args[args.indexOf("--port") + 1]);
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
setTimeout(() => process.exit(1), 2000);
