import type {
  DaemonInstall,
  MachineKind,
  MachineStatus,
} from "@eta/client-contracts";
/**
 * The machines sessions can run on.
 *
 * The primary is the one this host runs on: it is written the first time the host starts and read
 * back every time after, so its id is as stable as the database. A daemon gets its row when it
 * trades an install code (`pending`), and is let in when the user approves its fingerprint. The
 * fingerprint is the SHA-256 of the secret the daemon made for itself, so it is also what the
 * daemon's credential is checked against: the primary never holds the secret.
 */
import type { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface MachineRecord {
  id: string;
  kind: MachineKind;
  name: string;
  status: MachineStatus;
  fingerprint: string | null;
  home: string | null;
  os: string | null;
  maxActiveRuns: number;
  createdAt: number;
  lastSeenAt: number | null;
  /** The daemon's build, platform, how it was started and its link protocol, as it last said. */
  version: string | null;
  platform: string | null;
  install: DaemonInstall | null;
  protocol: number | null;
  /** Why it could not be brought up to date, the last time that was tried. */
  updateError: string | null;
  /** The Tailscale node it is, when it came in over the tailnet. */
  tailnetNode: string | null;
}

/** How many task runs a machine may work on at once, at most. */
const MAX_ACTIVE_RUNS_LIMIT = 20;

interface Row {
  id: string;
  kind: string;
  name: string;
  status: string;
  fingerprint: string | null;
  home: string | null;
  os: string | null;
  max_active_runs: number;
  created_at: number;
  last_seen_at: number | null;
  version: string | null;
  platform: string | null;
  install: string | null;
  protocol: number | null;
  update_error: string | null;
  tailnet_node: string | null;
}

const recordOf = (row: Row): MachineRecord => ({
  id: row.id,
  kind: row.kind as MachineKind,
  name: row.name,
  status: row.status as MachineStatus,
  fingerprint: row.fingerprint,
  home: row.home,
  os: row.os,
  maxActiveRuns: row.max_active_runs,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  version: row.version,
  platform: row.platform,
  install: row.install as DaemonInstall | null,
  protocol: row.protocol,
  updateError: row.update_error,
  tailnetNode: row.tailnet_node,
});

/** How long an install code is good for. */
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** An install code that could not be used; the reason is for the log, not for the caller. */
export class EnrollmentError extends Error {}

const digestOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** A fingerprint typed by a person: case, spaces and colons do not matter. */
const normalizeFingerprint = (value: string): string =>
  value.replace(/[\s:]/g, "").toLowerCase();

export class MachineStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * The primary machine, made the first time it is asked for. What it is called and where its home
   * is are facts about the computer *now*, so the second start refreshes them; the id and the name
   * the user may have chosen stay.
   */
  ensurePrimary(facts: {
    name: string;
    home: string;
    os: string;
  }): MachineRecord {
    const now = Date.now();
    const existing = this.primary();
    if (existing === undefined) {
      this.#db
        .query(
          `INSERT INTO machine (id, kind, name, status, home, os, created_at, last_seen_at)
           VALUES (?, 'primary', ?, 'online', ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), facts.name, facts.home, facts.os, now, now);
    } else {
      this.#db
        .query(
          "UPDATE machine SET status = 'online', home = ?, os = ?, last_seen_at = ? WHERE id = ?",
        )
        .run(facts.home, facts.os, now, existing.id);
    }
    return this.primary()!;
  }

  primary(): MachineRecord | undefined {
    const row = this.#db
      .query<Row, []>("SELECT * FROM machine WHERE kind = 'primary'")
      .get();
    return row === null ? undefined : recordOf(row);
  }

  list(): MachineRecord[] {
    return this.#db
      .query<Row, []>(
        "SELECT * FROM machine ORDER BY kind <> 'primary', name COLLATE NOCASE, id",
      )
      .all()
      .map(recordOf);
  }

  get(id: string): MachineRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM machine WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  rename(id: string, name: string): MachineRecord | undefined {
    const changed = this.#db
      .query("UPDATE machine SET name = ? WHERE id = ?")
      .run(name, id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /** How many task runs the machine works on at once. */
  setMaxActiveRuns(id: string, limit: number): MachineRecord | undefined {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVE_RUNS_LIMIT)
      throw new Error(
        `runs at once must be a whole number from 1 to ${MAX_ACTIVE_RUNS_LIMIT}`,
      );
    const changed = this.#db
      .query("UPDATE machine SET max_active_runs = ? WHERE id = ?")
      .run(limit, id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /* ---------------------------------------------------------------- daemons */

  /** A new install code. The code itself is returned once and never stored. */
  enroll(
    name: string | undefined,
    now: number = Date.now(),
  ): { code: string; expiresAt: number } {
    const code = `eta_${randomBytes(18).toString("base64url")}`;
    const expiresAt = now + ENROLLMENT_TTL_MS;
    // A week-old code is no use to anyone; the table does not need to remember it.
    this.#db
      .query("DELETE FROM machine_enrollment WHERE expires_at < ?")
      .run(now - 7 * 24 * 60 * 60 * 1000);
    this.#db
      .query(
        `INSERT INTO machine_enrollment (id, code_digest, name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        digestOf(code),
        name === undefined || name.trim() === "" ? null : name.trim(),
        now,
        expiresAt,
      );
    return { code, expiresAt };
  }

  /**
   * Use an install code: the machine behind it is made, pending. A code works once, within its
   * day; the second try, and a code that was never made, fail the same way.
   */
  exchange(
    input: {
      code: string;
      fingerprint: string;
      hostname: string;
      home: string;
      os: string;
    },
    now: number = Date.now(),
  ): MachineRecord {
    const fingerprint = normalizeFingerprint(input.fingerprint);
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new EnrollmentError("the fingerprint is not a SHA-256");
    return this.#db.transaction(() => {
      const row = this.#db
        .query<
          {
            id: string;
            name: string | null;
            expires_at: number;
            used_at: number | null;
          },
          [string]
        >(
          "SELECT id, name, expires_at, used_at FROM machine_enrollment WHERE code_digest = ?",
        )
        .get(digestOf(input.code));
      if (row === null) throw new EnrollmentError("unknown code");
      if (row.used_at !== null) throw new EnrollmentError("code already used");
      if (row.expires_at < now) throw new EnrollmentError("code expired");
      const id = crypto.randomUUID();
      this.#db
        .query(
          `INSERT INTO machine (id, kind, name, status, fingerprint, home, os, created_at, last_seen_at)
           VALUES (?, 'daemon', ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          row.name ??
            (input.hostname.trim() === "" ? "machine" : input.hostname),
          fingerprint,
          input.home,
          input.os,
          now,
          now,
        );
      this.#db
        .query(
          "UPDATE machine_enrollment SET used_at = ?, machine_id = ? WHERE id = ?",
        )
        .run(now, id, row.id);
      return this.get(id)!;
    })();
  }

  /** The machine that used an install code, once one has. */
  enrolledWith(code: string): MachineRecord | undefined {
    const row = this.#db
      .query<{ machine_id: string | null }, [string]>(
        "SELECT machine_id FROM machine_enrollment WHERE code_digest = ?",
      )
      .get(digestOf(code));
    return row?.machine_id == null ? undefined : this.get(row.machine_id);
  }

  /** The machine that is this tailnet node, when one is. */
  byTailnetNode(node: string): MachineRecord | undefined {
    const row = this.#db
      .query<Row, [string]>(
        "SELECT * FROM machine WHERE tailnet_node = ? AND status <> 'revoked'",
      )
      .get(node);
    return row === null ? undefined : recordOf(row);
  }

  /**
   * Let a pending machine in, if `fingerprint` is the one it enrolled with. A different one is
   * somebody else's machine (or a typo), and is refused the same way.
   */
  approve(id: string, fingerprint: string): MachineRecord | undefined {
    const machine = this.get(id);
    if (machine === undefined) return undefined;
    if (machine.kind !== "daemon" || machine.status !== "pending")
      throw new Error(`${machine.name} is not waiting for approval`);
    if (
      machine.fingerprint === null ||
      normalizeFingerprint(fingerprint) !== machine.fingerprint
    )
      throw new Error("that is not the fingerprint this machine enrolled with");
    this.setStatus(id, "offline");
    return this.get(id);
  }

  /** Close the door for good. Whatever the machine is running is not touched. */
  revoke(id: string): MachineRecord | undefined {
    const machine = this.get(id);
    if (machine === undefined) return undefined;
    if (machine.kind !== "daemon")
      throw new Error(`${machine.name} is not a daemon machine`);
    this.setStatus(id, "revoked");
    return this.get(id);
  }

  setStatus(
    id: string,
    status: MachineRecord["status"],
    seenAt: number | null = null,
  ): void {
    this.#db
      .query(
        "UPDATE machine SET status = ?, last_seen_at = COALESCE(?, last_seen_at) WHERE id = ?",
      )
      .run(status, seenAt, id);
  }

  setFacts(
    id: string,
    facts: {
      home: string;
      os: string;
      version?: string | undefined;
      platform?: string | undefined;
      install?: DaemonInstall | undefined;
      protocol?: number | undefined;
    },
  ): void {
    this.#db
      .query(
        "UPDATE machine SET home = ?, os = ?, version = ?, platform = ?, install = ?, protocol = ? WHERE id = ?",
      )
      .run(
        facts.home,
        facts.os,
        facts.version ?? null,
        facts.platform ?? null,
        facts.install ?? null,
        facts.protocol ?? null,
        id,
      );
  }

  /** Why the daemon could not be brought up to date; null when it is. */
  setUpdateError(id: string, error: string | null): void {
    this.#db
      .query("UPDATE machine SET update_error = ? WHERE id = ?")
      .run(error, id);
  }

  setTailnetNode(id: string, node: string): void {
    this.#db
      .query("UPDATE machine SET tailnet_node = ? WHERE id = ?")
      .run(node, id);
  }

  /**
   * Let a pending machine in without a fingerprint typed: the caller has established who it is
   * some other way (the tailnet says it is the user's own node).
   */
  admit(id: string): MachineRecord | undefined {
    const machine = this.get(id);
    if (machine === undefined) return undefined;
    if (machine.kind !== "daemon" || machine.status !== "pending")
      throw new Error(`${machine.name} is not waiting for approval`);
    this.setStatus(id, "offline");
    return this.get(id);
  }

  /** Nothing is connected when a host starts: whatever was online is not. */
  markDaemonsOffline(): void {
    this.#db
      .query(
        "UPDATE machine SET status = 'offline' WHERE kind = 'daemon' AND status = 'online'",
      )
      .run();
  }

  /**
   * The machine a credential belongs to, if it is good: a daemon that has not been revoked, whose
   * fingerprint is the digest of the secret. Compared as digests, so the time it takes says
   * nothing about the secret.
   */
  authenticate(id: string, secret: string): MachineRecord | undefined {
    const machine = this.get(id);
    if (
      machine === undefined ||
      machine.kind !== "daemon" ||
      machine.status === "revoked" ||
      machine.fingerprint === null
    )
      return undefined;
    const given = Buffer.from(digestOf(secret));
    const expected = Buffer.from(machine.fingerprint);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? machine
      : undefined;
  }
}
