/**
 * `eta-host upgrade`, against a fake of GitHub's release API and a fake service.
 *
 * The "builds" are shell scripts that answer `--version` and `--migrations`, which is all an
 * upgrade runs before a restart. What a build does once started is the fake service's script: the
 * file it finds under the executable's name decides whether `/up` answers. The database is real.
 */
import type { HostService } from "../src/upgrade/service";
import type { UpgradeOptions } from "../src/upgrade/upgrade";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databasePath, openDatabase } from "../src/db";
import {
  backupDatabase,
  BACKUPS_KEPT,
  busyAgents,
  restoreDatabase,
} from "../src/upgrade/database";
import { parseSums, Releases, releaseToken } from "../src/upgrade/releases";
import { inServiceCgroup, upUrl } from "../src/upgrade/service";
import { upgradeHost } from "../src/upgrade/upgrade";
import { tempDir } from "./support/host";

const PLATFORM = `eta-host-${process.platform}-${process.arch}`;

/** A build: it says `says` is its version and carries `migrations`. */
const build = (
  says: string,
  migrations: string[] = ["0001-a", "0002-b"],
): string =>
  `#!/bin/sh
case "$1" in
  --version) echo "eta-host ${says} (abc123)" ;;
  --migrations) printf '%s\\n' ${migrations.join(" ")} ;;
  *) echo "started ${says}" ;;
esac
`;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

interface FakeRelease {
  body: string;
  sums?: string;
  prerelease?: boolean;
}

/** GitHub's release API as far as the upgrade uses it, on a real port. */
function fakeGitHub(options: { requireToken?: string } = {}) {
  const releases = new Map<string, FakeRelease>();
  let latest: string | undefined;
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { origin, pathname } = new URL(request.url);
      const authorization = request.headers.get("authorization");
      seen.push({ path: pathname, authorization });
      // The API hides a private repository; the signed address needs nothing but itself.
      if (
        options.requireToken !== undefined &&
        !pathname.startsWith("/signed/") &&
        authorization !== `Bearer ${options.requireToken}`
      )
        return new Response("not found", { status: 404 });
      const describe = (tag: string): Response => {
        const release = releases.get(tag);
        if (release === undefined)
          return new Response("not found", { status: 404 });
        return Response.json({
          tag_name: `v${tag}`,
          prerelease: release.prerelease === true,
          assets: [PLATFORM, "SHA256SUMS"].map((name) => ({
            name,
            url: `${origin}/assets/${tag}/${name}`,
          })),
        });
      };
      if (pathname === "/repo/releases/latest")
        return latest === undefined
          ? new Response("not found", { status: 404 })
          : describe(latest);
      const tagged = /^\/repo\/releases\/tags\/v(.+)$/.exec(pathname);
      if (tagged !== null) return describe(tagged[1] as string);
      // Like GitHub: the API sends a file on to a signed address elsewhere.
      const asset = /^\/assets\/([^/]+)\/(.+)$/.exec(pathname);
      if (asset !== null)
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://localhost:${server.port}/signed/${asset[1]}/${asset[2]}`,
          },
        });
      const signed = /^\/signed\/([^/]+)\/(.+)$/.exec(pathname);
      if (signed !== null) {
        const release = releases.get(signed[1] as string);
        if (release === undefined || authorization !== null)
          return new Response("refused", { status: 400 });
        if (signed[2] === PLATFORM) return new Response(release.body);
        return new Response(
          release.sums ?? `${sha256(release.body)}  ${PLATFORM}\n`,
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/repo`,
    seen,
    publish(version: string, release: FakeRelease) {
      releases.set(version, release);
      if (release.prerelease !== true) latest = version;
    },
    stop: () => server.stop(true),
  };
}

/**
 * A service over one executable. Starting it "runs" that file: it comes up unless the file's text
 * says otherwise, and a build that carries `0003-c` migrates the database as a real start would.
 */
function fakeService(
  exe: string,
  dataDir: string,
  options: {
    comesUp?: (text: string) => boolean;
    dies?: (text: string) => boolean;
  } = {},
) {
  const { comesUp = () => true, dies = () => false } = options;
  let running = true;
  let current = "";
  let pid = 100;
  const calls: string[] = [];
  const service: HostService & { inside: boolean } = {
    program: exe,
    inside: false,
    status: () => {
      if (running && dies(current)) {
        running = false;
        return Promise.resolve({ running: false, crashed: true, pid: 0 });
      }
      return Promise.resolve({
        running,
        crashed: false,
        pid: running ? pid : 0,
      });
    },
    stop: () => {
      calls.push("stop");
      running = false;
      return Promise.resolve();
    },
    start: async () => {
      calls.push("start");
      current = await readFile(exe, "utf8");
      running = true;
      pid += 1;
      // The new build's migration, on the database as it stands.
      if (current.includes("0003-c")) {
        const db = new Database(databasePath(dataDir));
        db.exec("INSERT OR IGNORE INTO eta_migrations VALUES ('0003-c', 'x')");
        db.exec("DROP TABLE IF EXISTS gone");
        db.close();
      }
    },
    up: () => Promise.resolve(running && comesUp(current)),
  };
  return {
    service,
    calls,
    isRunning: () => running,
    runs: () => current,
  };
}

describe("eta-host upgrade", () => {
  let github: ReturnType<typeof fakeGitHub>;
  let dir: string;
  let exe: string;
  let dataDir: string;
  let lines: string[];

  beforeEach(async () => {
    github = fakeGitHub();
    dir = await tempDir("eta-upgrade-");
    exe = join(dir, "eta-host");
    dataDir = join(dir, "data");
    lines = [];
    await writeFile(exe, build("1.0.0"), { mode: 0o755 });
    const db = openDatabase(databasePath(dataDir));
    db.exec(`
      CREATE TABLE eta_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO eta_migrations VALUES ('0001-a', 'x'), ('0002-b', 'x');
      CREATE TABLE gone (value TEXT);
      INSERT INTO gone VALUES ('kept');
      CREATE TABLE task (id TEXT PRIMARY KEY, number INTEGER, title TEXT);
      CREATE TABLE task_run (id TEXT PRIMARY KEY, task_id TEXT, status TEXT);
      CREATE TABLE routine (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE routine_run (id TEXT PRIMARY KEY, routine_id TEXT, status TEXT);
      CREATE TABLE conversation (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT);
    `);
    db.close();
  });
  afterEach(() => github.stop());

  const upgrade = (
    overrides: Partial<UpgradeOptions> & { service?: HostService } = {},
  ): Promise<void> =>
    upgradeHost({
      wanted: undefined,
      check: false,
      force: false,
      waitMs: 0,
      version: "1.0.0",
      execPath: exe,
      dataDir,
      releases: new Releases({
        url: github.url,
        token: () => Promise.resolve(undefined),
      }),
      findService: () => Promise.resolve(overrides.service),
      log: (line) => lines.push(line),
      timing: { pollMs: 5, upMs: 100, holdMs: 20 },
      ...overrides,
    });

  const said = (): string => lines.join("\n");
  const stored = (): unknown => {
    const db = new Database(databasePath(dataDir), { readonly: true });
    try {
      const table = db
        .query("SELECT name FROM sqlite_master WHERE name = 'gone'")
        .get();
      return table === null ? null : db.query("SELECT value FROM gone").get();
    } finally {
      db.close();
    }
  };
  const backups = (): string[] =>
    existsSync(join(dataDir, "backups"))
      ? readdirSync(join(dataDir, "backups"))
      : [];
  const leftovers = (): string[] =>
    readdirSync(dir).filter((file) => file.endsWith(".next"));

  describe("which version", () => {
    it("takes the latest full release and leaves a pre-release to be named", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      github.publish("1.2.0-rc.1", {
        body: build("1.2.0-rc.1"),
        prerelease: true,
      });
      await upgrade();
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));

      await upgrade({ wanted: "1.2.0-rc.1", version: "1.1.0" });
      expect(await readFile(exe, "utf8")).toBe(build("1.2.0-rc.1"));
    });

    it("--check says what there is and changes nothing", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const { service, calls } = fakeService(exe, dataDir);
      await upgrade({ check: true, service });
      expect(said()).toBe("1.1.0 is available; this is 1.0.0.");
      expect(calls).toEqual([]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));

      lines.length = 0;
      await upgrade({ check: true, version: "1.1.0" });
      expect(said()).toBe("eta-host 1.1.0 is up to date.");

      lines.length = 0;
      await upgrade({ check: true, version: "2.0.0" });
      expect(said()).toBe("This is 2.0.0, newer than 1.1.0.");

      lines.length = 0;
      await upgrade({ check: true, version: "abc123def456" });
      expect(said()).toContain("not a release");
    });

    it("does nothing at the version it is, and refuses an older one", async () => {
      github.publish("1.0.0", { body: build("1.0.0") });
      await upgrade();
      expect(said()).toContain("up to date");
      expect(existsSync(`${exe}.prev`)).toBe(false);

      await expect(upgrade({ version: "1.1.0" })).rejects.toThrow(
        /older than this build/,
      );
    });

    it("says when there is no such release", async () => {
      await expect(upgrade({ wanted: "9.9.9" })).rejects.toThrow(
        /v9\.9\.9: not found.*token/,
      );
    });

    it("goes from a checkout's build to a release", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      await upgrade({ version: "0f3d99e59084" });
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });
  });

  describe("a private repository", () => {
    it("cannot see it without a token, and upgrades with one", async () => {
      github.stop();
      github = fakeGitHub({ requireToken: "s3cret" });
      github.publish("1.1.0", { body: build("1.1.0") });
      await expect(upgrade()).rejects.toThrow(/not found.*GH_TOKEN/);

      await upgrade({
        releases: new Releases({
          url: github.url,
          token: () => Promise.resolve("s3cret"),
        }),
      });
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });

    it("drops a stale token on a public repository", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const asked: (string | null)[] = [];
      const releases = new Releases({
        url: github.url,
        token: () => Promise.resolve("stale"),
        fetch: (async (url: string, init?: RequestInit) => {
          const authorization = new Headers(init?.headers).get("authorization");
          asked.push(authorization);
          return authorization === null
            ? await fetch(url, init)
            : new Response("bad credentials", { status: 401 });
        }) as typeof fetch,
      });
      await expect(releases.latest()).resolves.toMatchObject({
        version: "1.1.0",
      });
      expect(asked).toEqual(["Bearer stale", null]);
    });

    it("does not carry the token to the signed address", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const releases = new Releases({
        url: github.url,
        token: () => Promise.resolve("s3cret"),
      });
      const release = await releases.latest();
      const path = join(dir, "file");
      const asset = release.assets.find((file) => file.name === PLATFORM);
      expect(await releases.download(asset!, path)).toBe(
        sha256(build("1.1.0")),
      );
      expect(github.seen.at(-2)).toMatchObject({
        authorization: "Bearer s3cret",
      });
      expect(github.seen.at(-1)).toMatchObject({ authorization: null });
    });
  });

  describe("before anything changes", () => {
    it("stops at a wrong checksum", async () => {
      github.publish("1.1.0", {
        body: build("1.1.0"),
        sums: `${"0".repeat(64)}  ${PLATFORM}\n`,
      });
      const { service, calls } = fakeService(exe, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(/checksum/);
      expect(calls).toEqual([]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
      expect(leftovers()).toEqual([]);
      expect(backups()).toEqual([]);
    });

    it("stops at sums that do not name the file", async () => {
      github.publish("1.1.0", {
        body: build("1.1.0"),
        sums: `${"0".repeat(64)}  something-else\n`,
      });
      await expect(upgrade()).rejects.toThrow(/does not name/);
    });

    it("stops at a build that does not run, or says something else", async () => {
      github.publish("1.1.0", { body: "not a program" });
      const { service, calls } = fakeService(exe, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(/did not run/);

      github.publish("1.2.0", { body: build("1.3.0") });
      await expect(upgrade({ service })).rejects.toThrow(/says "eta-host 1.3/);
      expect(calls).toEqual([]);
      expect(leftovers()).toEqual([]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
    });

    it("stops at a database ahead of the build", async () => {
      github.publish("1.1.0", { body: build("1.1.0", ["0001-a"]) });
      const { service, calls } = fakeService(exe, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(
        /database has migrations.*0002-b/,
      );
      expect(calls).toEqual([]);
    });

    it("does not touch a service that runs another file", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const other = join(dir, "other");
      await writeFile(other, build("1.0.0"), { mode: 0o755 });
      const { service, calls } = fakeService(other, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(/service runs/);
      expect(calls).toEqual([]);
    });

    it("does not restart the service it runs inside", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const { service, calls } = fakeService(exe, dataDir);
      service.inside = true;
      await expect(upgrade({ service, force: true })).rejects.toThrow(
        /inside the service/,
      );
      expect(calls).toEqual([]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
    });

    it("runs one at a time, and takes over a lock left by a dead process", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const lock = join(dataDir, "upgrade.lock");
      writeFileSync(lock, String(process.pid));
      await expect(upgrade()).rejects.toThrow(/another upgrade/);

      writeFileSync(lock, "2147483646");
      await upgrade();
      expect(existsSync(lock)).toBe(false);
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });
  });

  describe("with no service running", () => {
    it("replaces the file, backs up, and leaves the restart to the user", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      await upgrade();
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
      expect(await readFile(`${exe}.prev`, "utf8")).toBe(build("1.0.0"));
      expect(backups()).toHaveLength(1);
      expect(said()).toContain("restart the host yourself");
    });

    it("says how to start a service that is stopped, and does not", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const { service, calls } = fakeService(exe, dataDir);
      await service.stop();
      calls.length = 0;
      await upgrade({ service });
      expect(calls).toEqual([]);
      expect(said()).toContain("systemctl --user start");
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });
  });

  describe("restarting the service", () => {
    const next = build("1.1.0", ["0001-a", "0002-b", "0003-c"]);

    it("stops, backs up, swaps, starts, and keeps the old file", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      await upgrade({ service: fake.service });
      expect(fake.calls).toEqual(["stop", "start"]);
      expect(fake.runs()).toBe(next);
      expect(await readFile(`${exe}.prev`, "utf8")).toBe(build("1.0.0"));
      expect(backups()).toHaveLength(1);
      expect(backups()[0]).toMatch(/^upgrade-\d{8}T\d{6}Z-1\.0\.0\.sqlite$/);
      expect(said()).toContain("The service runs 1.1.0");
    });

    it("goes back when /up never answers: the file, the database, the service", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir, {
        comesUp: (text) => text !== next,
      });
      await expect(upgrade({ service: fake.service })).rejects.toThrow(
        /1\.1\.0 did not hold \(\/up did not answer.*back on 1\.0\.0, database restored/,
      );
      expect(fake.calls).toEqual(["stop", "start", "stop", "start"]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
      expect(fake.runs()).toBe(build("1.0.0"));
      expect(fake.isRunning()).toBe(true);
      // The new build dropped this table and recorded its migration; both are undone.
      expect(stored()).toEqual({ value: "kept" });
      const db = new Database(databasePath(dataDir), { readonly: true });
      expect(db.query("SELECT id FROM eta_migrations").all()).toEqual([
        { id: "0001-a" },
        { id: "0002-b" },
      ]);
      db.close();
      expect(existsSync(`${exe}.prev`)).toBe(false);
    });

    it("goes back when it exits after coming up", async () => {
      github.publish("1.1.0", { body: next });
      let looks = 0;
      const fake = fakeService(exe, dataDir, {
        dies: (text) => text === next && (looks += 1) > 2,
      });
      await expect(upgrade({ service: fake.service })).rejects.toThrow(
        /exited after coming up.*back on 1\.0\.0/,
      );
      expect(fake.runs()).toBe(build("1.0.0"));
      expect(stored()).toEqual({ value: "kept" });
    });

    it("goes back when a migration of the new build is not in the database", async () => {
      github.publish("1.1.0", {
        body: build("1.1.0", ["0001-a", "0002-b", "0009-z"]),
      });
      const fake = fakeService(exe, dataDir);
      await expect(upgrade({ service: fake.service })).rejects.toThrow(
        /migrations did not run: 0009-z/,
      );
      expect(fake.runs()).toBe(build("1.0.0"));
    });

    it("says so when the way back fails too", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir, { comesUp: () => false });
      await expect(upgrade({ service: fake.service })).rejects.toThrow(
        /going back failed too.*backup is .*upgrade-.*needs a hand/s,
      );
    });

    it("starts the old build again when the stop fails", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      const { stop } = fake.service;
      fake.service.stop = async () => {
        await stop();
        throw new Error("systemctl timed out");
      };
      await expect(upgrade({ service: fake.service })).rejects.toThrow(
        /timed out/,
      );
      expect(fake.isRunning()).toBe(true);
      expect(fake.runs()).toBe(build("1.0.0"));
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
    });

    it("starts the old build again when the backup fails, and changes nothing", async () => {
      github.publish("1.1.0", { body: next });
      await writeFile(join(dataDir, "backups"), "in the way");
      const fake = fakeService(exe, dataDir);
      await expect(upgrade({ service: fake.service })).rejects.toThrow();
      expect(fake.calls).toEqual(["stop", "start"]);
      expect(fake.runs()).toBe(build("1.0.0"));
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
    });
  });

  describe("working agents", () => {
    const working = (): void => {
      const db = new Database(databasePath(dataDir));
      db.exec(`
        INSERT INTO task VALUES ('t1', 45, 'host upgrade');
        INSERT INTO task_run VALUES ('r1', 't1', 'running');
        INSERT INTO task_run VALUES ('r2', 't1', 'queued');
        INSERT INTO task_run VALUES ('r3', 't1', 'completed');
        INSERT INTO routine VALUES ('o1', 'digest');
        INSERT INTO routine_run VALUES ('rr1', 'o1', 'running');
        INSERT INTO conversation VALUES ('c1', 'eta');
        INSERT INTO message VALUES ('m1', 'c1', 'waiting_for_input');
        INSERT INTO message VALUES ('m2', 'c1', 'done');
      `);
      db.close();
    };

    it("names what is working, and nothing that is not", () => {
      expect(busyAgents(dataDir)).toEqual([]);
      working();
      expect(busyAgents(dataDir)).toEqual([
        "task #45 host upgrade",
        "routine digest",
        "a reply in eta",
      ]);
    });

    it("gives up after --wait, with nothing changed", async () => {
      working();
      github.publish("1.1.0", { body: build("1.1.0") });
      const fake = fakeService(exe, dataDir);
      await expect(
        upgrade({ service: fake.service, waitMs: 20 }),
      ).rejects.toThrow(/still working.*task #45.*--force/);
      expect(said()).toContain("Waiting for what a restart would stop");
      expect(fake.calls).toEqual([]);
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
      expect(leftovers()).toEqual([]);
    });

    it("goes on once they are done", async () => {
      working();
      github.publish("1.1.0", { body: build("1.1.0") });
      const fake = fakeService(exe, dataDir);
      setTimeout(() => {
        const db = new Database(databasePath(dataDir));
        db.exec(`
          UPDATE task_run SET status = 'completed';
          UPDATE routine_run SET status = 'sent';
          UPDATE message SET status = 'done';
        `);
        db.close();
      }, 30);
      await upgrade({ service: fake.service, waitMs: 5000 });
      expect(fake.calls).toEqual(["stop", "start"]);
    });

    it("--force does not wait", async () => {
      working();
      github.publish("1.1.0", { body: build("1.1.0") });
      const fake = fakeService(exe, dataDir);
      await upgrade({ service: fake.service, force: true });
      expect(fake.calls).toEqual(["stop", "start"]);
      expect(said()).toContain("--force");
    });

    it("does not wait when there is no restart", async () => {
      working();
      github.publish("1.1.0", { body: build("1.1.0") });
      await upgrade();
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });
  });

  describe("backups", () => {
    it("holds the database with its write-ahead log folded in", () => {
      const db = openDatabase(databasePath(dataDir));
      db.exec("INSERT INTO gone VALUES ('only in the log')");
      const backup = backupDatabase(dataDir, "1.0.0") as string;
      db.close();
      const copy = new Database(backup, { readonly: true });
      expect(copy.query("SELECT value FROM gone").all()).toHaveLength(2);
      copy.close();
    });

    it("is put back without the log of the file it replaces", () => {
      const backup = backupDatabase(dataDir, "1.0.0") as string;
      const db = openDatabase(databasePath(dataDir));
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("DELETE FROM gone");
      expect(existsSync(`${databasePath(dataDir)}-wal`)).toBe(true);
      restoreDatabase(dataDir, backup);
      db.close();
      expect(stored()).toEqual({ value: "kept" });
      expect(existsSync(backup)).toBe(true);
    });

    it(`keeps the newest ${BACKUPS_KEPT} and nothing else is touched`, () => {
      mkdirSync(join(dataDir, "backups"));
      writeFileSync(join(dataDir, "backups", "mine.sqlite"), "");
      for (const day of [1, 2, 3, 4, 5])
        backupDatabase(dataDir, "1.0.0", new Date(`2026-11-0${day}T00:00:00Z`));
      expect(backups().sort()).toEqual([
        "mine.sqlite",
        "upgrade-20261103T000000Z-1.0.0.sqlite",
        "upgrade-20261104T000000Z-1.0.0.sqlite",
        "upgrade-20261105T000000Z-1.0.0.sqlite",
      ]);
    });

    it("has nothing to do without a database", () => {
      expect(backupDatabase(join(dir, "empty"), "1.0.0")).toBeUndefined();
    });
  });
});

describe("the pieces", () => {
  it("reads SHA256SUMS as sha256sum writes it", () => {
    const hash = "a".repeat(64);
    expect(
      parseSums(`${hash}  eta-host-linux-x64\n${hash} *binary\n\nnot this\n`),
    ).toEqual(
      new Map([
        ["eta-host-linux-x64", hash],
        ["binary", hash],
      ]),
    );
  });

  it("takes a token from the environment, and gh's login only for GitHub", async () => {
    const elsewhere = "http://fork.example/repos/o/r";
    expect(await releaseToken(elsewhere, { GH_TOKEN: "a" })).toBe("a");
    expect(await releaseToken(elsewhere, { GITHUB_TOKEN: "b" })).toBe("b");
    expect(
      await releaseToken(elsewhere, { GH_TOKEN: "a", GITHUB_TOKEN: "b" }),
    ).toBe("a");
    expect(await releaseToken(elsewhere, {})).toBeUndefined();
  });

  it("knows the service's cgroup, as systemd spells it", () => {
    const user = "0::/user.slice/user-1000.slice/user@1000.service/app.slice";
    expect(inServiceCgroup(`${user}/_io.eta.host.service\n`)).toBe(true);
    expect(inServiceCgroup(`${user}/io.eta.daemon.service\n`)).toBe(false);
    expect(inServiceCgroup(`${user}/run-r1.scope\n`)).toBe(false);
  });

  it("finds the service's port in its flags", async () => {
    expect(await upUrl([])).toBe("http://127.0.0.1:8787/up");
    expect(await upUrl(["--port", "8790", "--host", "100.1.2.3"])).toBe(
      "http://100.1.2.3:8790/up",
    );
    expect(await upUrl(["--host=0.0.0.0", "--port=9"])).toBe(
      "http://127.0.0.1:9/up",
    );
    expect(await upUrl(["--host", "::"])).toBe("http://[::1]:8787/up");
    expect(await upUrl(["--some-new-flag", "--port", "1"])).toBe(
      "http://127.0.0.1:1/up",
    );
    await expect(upUrl(["--port", "0"])).rejects.toThrow(/any free port/);
  });
});
