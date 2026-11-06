/**
 * The builds `drive.ts` upgrades between, each a real host of its version in `<out>/<version>/`
 * under its release name, with `SHA256SUMS`. Run from a clean checkout with the page built; it
 * changes the tree for the broken builds and puts it back.
 *
 *   bun scripts/upgrade-e2e/build.ts <out>
 *
 *   0.9.0   what is installed
 *   0.9.1   good, with a new migration
 *   0.9.2   a migration that fails, so it never comes up
 *   0.9.3   a migration that cannot be undone, then it answers /up and dies two seconds later
 *   0.9.4   good, and ignores being told to stop
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..", "..");
const out = resolve(process.argv[2] ?? "builds");
const main = join(root, "apps", "eta", "src", "main.ts");
const migration = join(
  root,
  "apps",
  "eta",
  "src",
  "migrations",
  "9001-e2e.sql",
);
const original = readFileSync(main, "utf8");

const asset =
  process.platform === "win32"
    ? `eta-host-windows-${process.arch}.exe`
    : `eta-host-${process.platform}-${process.arch}`;
const staged = process.platform === "win32" ? "eta-host.exe" : "eta-host";

async function stage(version: string): Promise<void> {
  await $`${process.execPath} ${join(root, "apps", "desktop", "scripts", "stage-host.ts")}`
    .cwd(root)
    .env({ ...process.env, ETA_DAEMON_VERSION: version })
    .quiet();
  const dir = join(out, version);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset);
  cpSync(join(root, "apps", "desktop", "dist", "host", staged), file);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(readFileSync(file))
    .digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256}  ${asset}\n`);
  console.log(`built ${version}`);
}

function patch(from: string, to: string): void {
  const text = readFileSync(main, "utf8");
  if (!text.includes(from)) throw new Error(`main.ts has no: ${from}`);
  writeFileSync(main, text.replace(from, to));
}

try {
  await stage("0.9.0");
  writeFileSync(
    migration,
    `CREATE TABLE e2e_mark (id INTEGER PRIMARY KEY, note TEXT);
INSERT INTO e2e_mark (note) VALUES ('0.9.1 was here');
`,
  );
  await stage("0.9.1");

  writeFileSync(migration, "SELECT * FROM a_table_that_is_not_there;\n");
  await stage("0.9.2");

  writeFileSync(migration, "ALTER TABLE project DROP COLUMN archived;\n");
  patch(
    "/** A signal is a shutdown",
    "setTimeout(() => process.exit(1), 2000);\n\n/** A signal is a shutdown",
  );
  await stage("0.9.3");
  writeFileSync(main, original);

  rmSync(migration);
  patch("void host.close().then(() => process.exit(0));", "");
  await stage("0.9.4");
} finally {
  writeFileSync(main, original);
  rmSync(migration, { force: true });
}
