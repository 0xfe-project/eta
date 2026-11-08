/**
 * `eta-host upgrade`, against a fake of GitHub's release API and a fake service.
 *
 * The "builds" are shell scripts that answer `--version` and `--migrations`, which is all an
 * upgrade runs before a restart. What a build does once started is the fake service's script: the
 * file it finds under the executable's name decides whether `/up` answers. The database is real.
 */
import type { ReleaseToken } from "@eta/releases";
import type { HostService } from "../src/upgrade/service";
import type { UpgradeOptions } from "../src/upgrade/upgrade";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  BUILT_UPSTREAM,
  chooseUpstream,
  parseSums,
  parseUpstream,
  Releases,
  releaseToken,
  UPSTREAM_SETTING,
  upstreamLabel,
} from "@eta/releases";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { SettingStore } from "../src/inbox/setting";
import { loadSecretKey } from "../src/secret";
import {
  backupDatabase,
  BACKUPS_KEPT,
  busyAgents,
  busyText,
  restoreDatabase,
  savedToken,
  savedUpstream,
} from "../src/upgrade/database";
import { askUp, upUrl } from "../src/upgrade/service";
import {
  openToken,
  sealToken,
  TOKEN_SETTING,
  tokenHost,
} from "../src/upgrade/token";
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
  const service: HostService = {
    program: exe,
    startCommand: "systemctl --user start io.eta.host",
    status: () => {
      if (running && dies(current)) {
        running = false;
        return Promise.resolve({
          running: false,
          crashed: true,
          restarting: false,
          pid: 0,
        });
      }
      return Promise.resolve({
        running,
        crashed: false,
        restarting: false,
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
        upstream: github.url,
        token: () => Promise.resolve({}),
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
      await expect(upgrade()).rejects.toThrow(/not found.*ETA_RELEASES_TOKEN/);

      await upgrade({
        releases: new Releases({
          upstream: github.url,
          token: () => Promise.resolve({ token: "s3cret" }),
        }),
      });
      expect(await readFile(exe, "utf8")).toBe(build("1.1.0"));
    });

    it("drops a stale token on a public repository", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const asked: (string | null)[] = [];
      const releases = new Releases({
        upstream: github.url,
        token: () => Promise.resolve({ token: "stale" }),
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
        upstream: github.url,
        token: () => Promise.resolve({ token: "s3cret" }),
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

    it("refuses a build that can run but not list its migrations", async () => {
      github.publish("1.1.0", {
        body: build("1.1.0").replace(
          "--migrations)",
          "--migrations) exit 3 ;; x)",
        ),
      });
      const { service, calls } = fakeService(exe, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(/did not run/);
      expect(calls).toEqual([]);
    });

    it("cannot tell with the one release that does not list them", async () => {
      const old = build("0.1.0").replace(
        "--migrations)",
        "--migrations) exit 3 ;; x)",
      );
      github.publish("0.1.0", { body: old });
      // From a checkout's build, whose database may be anything.
      await expect(upgrade({ version: "abc123def456" })).rejects.toThrow(
        /database may be ahead/,
      );
      expect(await readFile(exe, "utf8")).toBe(build("1.0.0"));
      // From an older release, which it follows.
      await upgrade({ version: "0.0.9" });
      expect(await readFile(exe, "utf8")).toBe(old);
      expect(said()).toContain("does not list its migrations");
    });

    it("does not touch a service that runs another file", async () => {
      github.publish("1.1.0", { body: build("1.1.0") });
      const other = join(dir, "other");
      await writeFile(other, build("1.0.0"), { mode: 0o755 });
      const { service, calls } = fakeService(other, dataDir);
      await expect(upgrade({ service })).rejects.toThrow(/service runs/);
      expect(calls).toEqual([]);
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

    it("reports where it is, in order", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      const seen: string[] = [];
      let to: string | undefined;
      await upgrade({
        service: fake.service,
        report: {
          target: (version) => {
            to = version;
          },
          phase: (phase) => seen.push(phase),
          cancelled: () => undefined,
        },
      });
      expect(to).toBe("1.1.0");
      expect(seen).toEqual([
        "downloading",
        "stopping",
        "backing-up",
        "restarting",
        "verifying",
      ]);
    });

    it("says rolled back when it went back", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir, {
        comesUp: (text) => text !== next,
      });
      await expect(upgrade({ service: fake.service })).rejects.toMatchObject({
        state: "rolled-back",
      });
    });

    it("says broken when it could not", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir, { comesUp: () => false });
      await expect(upgrade({ service: fake.service })).rejects.toMatchObject({
        state: "broken",
      });
    });

    it("takes a service between two starts as running", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      const { status } = fake.service;
      let looks = 0;
      fake.service.status = async () => {
        looks += 1;
        return looks === 1
          ? { running: false, crashed: true, restarting: true, pid: 0 }
          : await status();
      };
      await upgrade({ service: fake.service });
      expect(fake.calls).toEqual(["stop", "start"]);
      expect(fake.runs()).toBe(next);
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

    it("asks systemctl again when one of them dies", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      const { start, stop } = fake.service;
      const onceFailing = (step: () => Promise<void>) => {
        let failed = false;
        return async () => {
          if (failed) return await step();
          failed = true;
          throw new Error("systemctl was killed");
        };
      };
      fake.service.stop = onceFailing(stop);
      fake.service.start = onceFailing(start);
      await upgrade({ service: fake.service });
      expect(fake.runs()).toBe(next);
      expect(said()).toContain("The service runs 1.1.0");
    });

    it("starts the old build again when the stop fails", async () => {
      github.publish("1.1.0", { body: next });
      const fake = fakeService(exe, dataDir);
      const { stop } = fake.service;
      fake.service.stop = async () => {
        await stop();
        fake.calls.pop();
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
        INSERT INTO message VALUES ('m3', 'c1', 'failed');
      `);
      db.close();
    };

    it("names what is working, and nothing that is not", () => {
      expect(busyAgents(dataDir)).toEqual([]);
      working();
      const busy = busyAgents(dataDir);
      expect(busy).toEqual([
        { kind: "task", number: 45, name: "host upgrade" },
        { kind: "routine", name: "digest" },
        { kind: "reply", name: "eta" },
      ]);
      expect(busyText(busy)).toBe(
        "task #45 host upgrade; routine digest; a reply in eta",
      );
    });

    it("counts a reply still starting, which a restart fails too", () => {
      const db = new Database(databasePath(dataDir));
      db.exec(`
        INSERT INTO conversation VALUES ('c1', 'eta');
        INSERT INTO message VALUES ('m1', 'c1', 'queued');
      `);
      db.close();
      expect(busyAgents(dataDir)).toEqual([{ kind: "reply", name: "eta" }]);
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

  it("asks /up directly, whatever proxy the shell has", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "0.0.0.0",
      fetch: () => new Response("ok"),
    });
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    const url = `http://${address ?? "127.0.0.1"}:${server.port}/up`;
    const saved = process.env.http_proxy;
    process.env.http_proxy = "http://127.0.0.1:1";
    try {
      expect(await askUp(url)).toBe(true);
      await server.stop(true);
      expect(await askUp(url)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.http_proxy;
      else process.env.http_proxy = saved;
    }
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

describe("where releases come from", () => {
  const SHAPES: [string, string, string, string][] = [
    [
      "someone/fork",
      "github",
      "https://api.github.com/repos/someone/fork",
      "someone/fork",
    ],
    [
      "  someone/fork.js ",
      "github",
      "https://api.github.com/repos/someone/fork.js",
      "someone/fork.js",
    ],
    [
      "https://github.com/someone/fork",
      "github",
      "https://api.github.com/repos/someone/fork",
      "someone/fork",
    ],
    [
      "https://github.com/someone/fork.git",
      "github",
      "https://api.github.com/repos/someone/fork",
      "someone/fork",
    ],
    [
      "github.com/someone/fork/",
      "github",
      "https://api.github.com/repos/someone/fork",
      "someone/fork",
    ],
    [
      "https://api.github.com/repos/someone/fork/",
      "github",
      "https://api.github.com/repos/someone/fork",
      "someone/fork",
    ],
    [
      "https://ghe.corp/api/v3/repos/someone/fork",
      "enterprise",
      "https://ghe.corp/api/v3/repos/someone/fork",
      "https://ghe.corp/api/v3/repos/someone/fork",
    ],
    [
      "https://ghe.corp:8443/api/v3/repos/someone/fork/",
      "enterprise",
      "https://ghe.corp:8443/api/v3/repos/someone/fork",
      "https://ghe.corp:8443/api/v3/repos/someone/fork",
    ],
    [
      "http://127.0.0.1:9900/repos/o/r",
      "other",
      "http://127.0.0.1:9900/repos/o/r",
      "http://127.0.0.1:9900/repos/o/r",
    ],
  ];

  it.each(SHAPES)("reads %s", (text, kind, api, label) => {
    expect(parseUpstream(text)).toMatchObject({ kind, api, label });
    expect(parseUpstream(label).api).toBe(api);
  });

  it("tells gh the server, and keeps a token on the API", () => {
    expect(parseUpstream("o/r")).toMatchObject({
      host: "github.com",
      root: "https://api.github.com",
    });
    expect(
      parseUpstream("https://ghe.corp:8443/api/v3/repos/o/r"),
    ).toMatchObject({
      host: "ghe.corp:8443",
      root: "https://ghe.corp:8443/api/v3",
    });
  });

  it("gives GitHub's credentials to nothing that only looks like it", () => {
    for (const lookalike of [
      "http://api.github.com/repos/o/r",
      "https://api.github.com.evil.example/repos/o/r",
      "https://evil.example/repos/o/r",
      "http://ghe.corp/api/v3/repos/o/r",
      "https://ghe.corp/api/v3/o/r",
      "https://ghe.corp/api/v4/repos/o/r",
      "https://api.github.com:8443/repos/o/r",
    ])
      expect(parseUpstream(lookalike).kind).toBe("other");
  });

  it.each([
    "",
    "nothing",
    "mirror.example/o/r",
    "https://mirror.example",
    "a/b/c/d/",
    "git@github.com:o/r.git",
    "ftp://github.com/o/r",
    "file:///etc/passwd",
    "https://github.com/o",
    "https://github.com/o/r/releases",
    "https://api.github.com/users/o",
    "https://github.com/o/..",
    "o/..",
    "o/.git",
    "https://mirror.example/repos/o/r?token=x",
    "https://mirror.example/repos/o/r#x",
  ])("refuses %j", (text) => {
    expect(() => parseUpstream(text)).toThrow(/not a repository/);
  });

  it("refuses an address that carries a login, and does not repeat it", () => {
    for (const text of [
      "https://me:s3cret@ghe.corp/api/v3/repos/o/r",
      "https://s3cret@mirror.example/repos/o/r",
    ]) {
      expect(() => parseUpstream(text)).toThrow(/cannot carry a login/);
      expect(() => parseUpstream(text)).not.toThrow(/s3cret/);
    }
  });

  it("names something unreadable as it is", () => {
    expect(upstreamLabel("nothing")).toBe("nothing");
    expect(upstreamLabel("https://github.com/o/r")).toBe("o/r");
  });

  it.each([
    "https://me:s3cret@ghe.corp:not-a-port/api/v3/repos/o/r",
    "https://me:s3cret/more@ghe.corp:not-a-port/api/v3/repos/o/r",
    "https://mirror.example/repos/o/r?token=s3cret",
    "https://mirror.example/repos/o/r#s3cret",
  ])("repeats no secret of what it cannot read: %s", (text) => {
    expect(() => parseUpstream(text)).toThrow(/not a repository/);
    expect(() => parseUpstream(text)).not.toThrow(/s3cret/);
    expect(upstreamLabel(text)).not.toContain("s3cret");
  });

  it("takes the first that is given", () => {
    const env = { ETA_RELEASES_URL: "from/env" };
    const all = { flag: "from/flag", saved: "from/setting", env };
    expect(chooseUpstream(all)).toEqual({ text: "from/flag", source: "flag" });
    expect(chooseUpstream({ ...all, flag: undefined })).toEqual({
      text: "from/env",
      source: "env",
    });
    expect(chooseUpstream({ saved: "from/setting", env: {} })).toEqual({
      text: "from/setting",
      source: "setting",
    });
    expect(
      chooseUpstream({
        saved: "from/setting",
        env: { ETA_RELEASES_URL: "" },
      }).source,
    ).toBe("setting");
    expect(chooseUpstream({ env: {} })).toEqual({
      text: BUILT_UPSTREAM,
      source: "build",
    });
    expect(BUILT_UPSTREAM).toBe("0xfe-project/eta");
  });
});

describe("the saved upstream, from outside the host", () => {
  it("is nothing without a database, or a settings table", async () => {
    const dir = await tempDir();
    expect(savedUpstream(dir)).toBeUndefined();
    new Database(join(dir, "eta.sqlite")).close();
    expect(savedUpstream(dir)).toBeUndefined();
  });

  it("is what the host saved", async () => {
    const dir = await tempDir();
    const db = openDatabase(databasePath(dir));
    applyMigrations(db, loadMigrations());
    new SettingStore(db).set(UPSTREAM_SETTING, "someone/fork");
    expect(savedUpstream(dir)).toBe("someone/fork");
    new SettingStore(db).delete(UPSTREAM_SETTING);
    expect(savedUpstream(dir)).toBeUndefined();
    db.close();
  });

  it("stops an upgrade rather than guess past a damaged database", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "eta.sqlite"), "this is not a database at all");
    expect(() => savedUpstream(dir)).toThrow();
  });
});

describe("which token", () => {
  const github = parseUpstream("someone/fork");
  const enterprise = parseUpstream("https://ghe.corp/api/v3/repos/o/r");
  const mirror = parseUpstream("http://mirror.example/repos/o/r");

  /** A `gh` on the PATH: what it answers for `auth token`, and whether it has a user in its config. */
  async function gh(script: string): Promise<NodeJS.ProcessEnv> {
    const bin = await tempDir("eta-gh-");
    await writeFile(join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  it("takes GitHub's from the environment, in order", async () => {
    expect(await releaseToken(github, { GH_TOKEN: "a" })).toEqual({
      token: "a",
      from: "GH_TOKEN",
    });
    expect(await releaseToken(github, { GITHUB_TOKEN: "b" })).toEqual({
      token: "b",
      from: "GITHUB_TOKEN",
    });
    expect(
      await releaseToken(github, { GH_TOKEN: "a", GITHUB_TOKEN: "b" }),
    ).toMatchObject({ token: "a" });
  });

  it("does not ask gh about what the environment answers", async () => {
    const env = await gh("exit 7");
    expect(await releaseToken(github, { ...env, GH_TOKEN: "a" })).toMatchObject(
      { token: "a" },
    );
  });

  it("takes GitHub Enterprise's own first", async () => {
    expect(
      await releaseToken(enterprise, {
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        GH_ENTERPRISE_TOKEN: "c",
      }),
    ).toEqual({ token: "c", from: "GH_ENTERPRISE_TOKEN" });
    expect(await releaseToken(enterprise, { GH_TOKEN: "a" })).toMatchObject({
      token: "a",
    });
  });

  it("gives another server only its own, and never asks gh", async () => {
    const env = await gh('echo "from-gh"');
    const all = {
      ...env,
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GH_ENTERPRISE_TOKEN: "c",
    };
    expect(await releaseToken(mirror, all)).toEqual({});
    expect(
      await releaseToken(mirror, { ...all, ETA_RELEASES_TOKEN: "d" }),
    ).toEqual({ token: "d", from: "ETA_RELEASES_TOKEN" });
    expect(
      await releaseToken(github, { ETA_RELEASES_TOKEN: "d", ...env }),
    ).toEqual({
      token: "from-gh",
      from: "gh",
    });
  });

  describe("one the user saved", () => {
    const saved = { host: "github.com", token: "saved" };

    it("comes after the environment and before gh", async () => {
      const env = await gh('echo "from-gh"');
      expect(
        await releaseToken(github, { ...env, GH_TOKEN: "a" }, saved),
      ).toEqual({ token: "a", from: "GH_TOKEN" });
      expect(await releaseToken(github, env, saved)).toEqual({
        token: "saved",
        from: "Settings",
      });
    });

    it("goes to its own host and nowhere else", async () => {
      const env = await gh('echo "from-gh"');
      expect(await releaseToken(enterprise, env, saved)).toEqual({
        token: "from-gh",
        from: "gh",
      });
      expect(await releaseToken(mirror, env, saved)).toEqual({});
      const lookalike = parseUpstream("http://github.com/repos/o/r");
      expect(lookalike.host).toBe("github.com");
      expect(await releaseToken(lookalike, env, saved)).toEqual({});
    });

    it("does not open under another host's key", () => {
      const stored = sealToken(randomBytes(32), saved);
      expect(tokenHost(stored)).toBe("github.com");
      expect(openToken(randomBytes(32), stored)).toBeUndefined();
      expect(JSON.stringify(stored)).not.toContain('saved"');
    });

    it("is read back outside the host", async () => {
      const dir = await tempDir();
      expect(savedToken(dir)).toBeUndefined();
      const db = openDatabase(databasePath(dir));
      applyMigrations(db, loadMigrations());
      expect(savedToken(dir)).toBeUndefined();
      expect(existsSync(join(dir, "secret.key"))).toBe(false);
      new SettingStore(db).set(
        TOKEN_SETTING,
        sealToken(loadSecretKey(dir), saved),
      );
      expect(savedToken(dir)).toEqual(saved);
      db.close();
    });

    it("is named by where it came from when it is refused", async () => {
      const releases = new Releases({
        upstream: "o/r",
        saved,
        fetch: ((_url: string, init: RequestInit) =>
          Promise.resolve(
            new Response("", {
              status: new Headers(init.headers).has("authorization")
                ? 401
                : 404,
            }),
          )) as unknown as typeof fetch,
        token: () => releaseToken(parseUpstream("o/r"), {}, saved),
      });
      await expect(releases.latest()).rejects.toThrow(
        /token from Settings was refused/,
      );
    });
  });

  it("asks gh about the upstream's own host", async () => {
    const env = await gh(
      '[ "$1 $2 $3" = "auth token --hostname" ] && echo "for $4"',
    );
    expect(await releaseToken(github, env)).toMatchObject({
      token: "for github.com",
    });
    expect(await releaseToken(enterprise, env)).toMatchObject({
      token: "for ghe.corp",
    });
  });

  it("knows gh without a login from gh that cannot read one", async () => {
    expect(
      await releaseToken(
        github,
        await gh('echo "no oauth token found for github.com" >&2; exit 1'),
      ),
    ).toEqual({ gh: "logged-out" });
    expect(
      await releaseToken(
        github,
        await gh('[ "$1" = config ] && echo someone && exit 0; exit 1'),
      ),
    ).toEqual({ gh: "unreadable" });
  });

  it("knows when there is no gh", async () => {
    const empty = await tempDir("eta-gh-");
    expect(await releaseToken(github, { PATH: empty })).toEqual({
      gh: "missing",
    });
  });
});

describe("what a repository that cannot be read says", () => {
  /** A GitHub that answers `status` for releases and `repository` for the repository itself. */
  const answering = (status: number, repository = 404, body = "") =>
    ((url: string) =>
      Promise.resolve(
        new Response(body, {
          status: url.endsWith("/repos/o/r") ? repository : status,
        }),
      )) as unknown as typeof fetch;
  const latest = (
    token: ReleaseToken,
    fetcher: typeof fetch,
    upstream = "o/r",
  ) =>
    new Releases({
      upstream,
      token: () => Promise.resolve(token),
      fetch: fetcher,
    }).latest();

  it("without a token, says why there is none", async () => {
    await expect(latest({ gh: "logged-out" }, answering(404))).rejects.toThrow(
      /private.*gh auth login.*GH_TOKEN/,
    );
    await expect(latest({ gh: "missing" }, answering(404))).rejects.toThrow(
      /gh is not on this process's PATH/,
    );
    await expect(latest({ gh: "unreadable" }, answering(404))).rejects.toThrow(
      /cannot read.*--insecure-storage.*GH_TOKEN/,
    );
  });

  it("says GitHub Enterprise's own way to log in", async () => {
    await expect(
      latest(
        { gh: "logged-out" },
        answering(404),
        "https://ghe.corp/api/v3/repos/o/r",
      ),
    ).rejects.toThrow(
      /gh auth login --hostname ghe\.corp.*GH_ENTERPRISE_TOKEN/,
    );
  });

  it("with a token, blames the token, by where it came from", async () => {
    await expect(
      latest({ token: "s3cret", from: "gh" }, answering(404)),
    ).rejects.toThrow(
      /o\/r does not exist, or the token from gh cannot read it/,
    );
    await expect(
      latest({ token: "s3cret", from: "GH_TOKEN" }, answering(403)),
    ).rejects.toThrow(/403.*the token from GH_TOKEN is not allowed/);
  });

  it("tells a token that was refused from one that is missing", async () => {
    const fetcher = ((url: string, init: RequestInit) =>
      Promise.resolve(
        new Response("", {
          status: new Headers(init.headers).has("authorization") ? 401 : 404,
        }),
      )) as unknown as typeof fetch;
    await expect(
      latest({ token: "old", from: "GH_TOKEN" }, fetcher),
    ).rejects.toThrow(/token from GH_TOKEN was refused/);
  });

  it("tells a repository with no release from one it cannot see", async () => {
    await expect(
      latest({ token: "s3cret", from: "gh" }, answering(404, 200)),
    ).rejects.toThrow(/o\/r has no such release/);
    await expect(latest({}, answering(404, 200))).rejects.not.toThrow(/token/);
  });

  it("tells another server about its own token, not about gh", async () => {
    const mirror = "https://mirror.example/repos/o/r";
    await expect(latest({}, answering(401), mirror)).rejects.toThrow(
      /401 \(set ETA_RELEASES_TOKEN\)/,
    );
    await expect(latest({}, answering(403), mirror)).rejects.not.toThrow(
      /gh|GH_TOKEN|GitHub/,
    );
    await expect(latest({}, answering(404), mirror)).rejects.toThrow(
      /ETA_RELEASES_TOKEN/,
    );
  });

  it("never repeats a token, even one the server echoes", async () => {
    const echo = answering(500, 404, "bad s3cret here");
    const error = await latest({ token: "s3cret", from: "gh" }, echo).catch(
      (caught: unknown) => caught as Error,
    );
    expect(String(error)).not.toContain("s3cret");
    expect(String(error)).toContain("[token]");
  });

  it("carries a token on the API alone", async () => {
    const seen: [string, string | null][] = [];
    const fetcher = ((url: string, init: RequestInit) => {
      seen.push([url, new Headers(init.headers).get("authorization")]);
      return Promise.resolve(
        seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "/storage/signed?sig=1" },
            })
          : new Response("{}"),
      );
    }) as unknown as typeof fetch;
    const releases = new Releases({
      upstream: "https://ghe.corp/api/v3/repos/o/r",
      token: () => Promise.resolve({ token: "s3cret", from: "gh" }),
      fetch: fetcher,
    });
    await releases.text({
      name: "SHA256SUMS",
      url: "https://ghe.corp/api/v3/repos/o/r/releases/assets/1",
    });
    expect(seen).toEqual([
      ["https://ghe.corp/api/v3/repos/o/r/releases/assets/1", "Bearer s3cret"],
      ["https://ghe.corp/storage/signed?sig=1", null],
    ]);
  });

  it("does not follow an asset off the API with a token", async () => {
    const seen: (string | null)[] = [];
    const fetcher = ((_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    const releases = new Releases({
      upstream: "o/r",
      token: () => Promise.resolve({ token: "s3cret", from: "gh" }),
      fetch: fetcher,
    });
    await releases.text({ name: "x", url: "https://evil.example/x" });
    await releases.text({
      name: "x",
      url: "https://api.github.com.evil.example/x",
    });
    expect(seen).toEqual([null, null]);
  });
});
