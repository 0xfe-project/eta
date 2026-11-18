/**
 * Asking a machine about its directories, whichever machine it is.
 *
 * The primary answers in this process, with `@eta/places` over its own filesystem; a daemon
 * answers with the same code in its own process, over the link (`DaemonServiceParams.places`).
 * An SSH machine cannot be asked yet. What comes back is a value, or a `PlaceError` whose code
 * says which of the usual troubles it was: the machine away, too slow, too old, or the
 * filesystem's own no.
 */
import type {
  MachinePlaceOp,
  MachinePlaceResults,
  PathFlavor,
} from "@eta/client-contracts";
import type { MachineHub } from "../machines/hub";
import type { MachineRecord } from "../machines/store";
import { homedir } from "node:os";
import process from "node:process";
import { LINK_LIMITS } from "@eta/client-contracts";
import { LinkError } from "@eta/daemon";
import { PathRules, PlaceError, Places } from "@eta/places";

type OpName = MachinePlaceOp["op"];
type OpOf<O extends OpName> = Extract<MachinePlaceOp, { op: O }>;

/** How long each kind of question may take on the far side. */
const TIMEOUT_MS: Record<OpName, number> = {
  capabilities: 30_000,
  resolve: 15_000,
  list: 20_000,
  search: 20_000,
  mkdir: 15_000,
  repos: 30_000,
  clone: LINK_LIMITS.runTimeoutMs,
};

export interface AskOptions {
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
}

export class MachinePlaces {
  readonly #hub: MachineHub;
  /** The primary's places; a test hands in its own home. */
  readonly local: Places;

  constructor(options: { hub: MachineHub; local?: Places }) {
    this.#hub = options.hub;
    this.local =
      options.local ?? new Places({ home: homedir(), os: process.platform });
  }

  /** The machine's path rules, from what it said about itself; for writing paths it gave. */
  rules(machine: MachineRecord): PathRules {
    if (machine.kind === "primary") return this.local.rules;
    const flavor: PathFlavor = machine.os === "win32" ? "win32" : "posix";
    return new PathRules(
      flavor,
      machine.home ?? (flavor === "win32" ? "C:\\" : "/"),
    );
  }

  async ask<O extends OpName>(
    machine: MachineRecord,
    op: OpOf<O>,
    options: AskOptions = {},
  ): Promise<MachinePlaceResults[O]> {
    if (machine.kind === "primary") {
      const reply = await this.local.serve(op, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvent === undefined ? {} : { emit: options.onEvent }),
      });
      if (!reply.ok)
        throw new PlaceError(reply.failure.code, reply.failure.detail);
      return reply.value as MachinePlaceResults[O];
    }
    if (machine.kind !== "daemon") throw new PlaceError("unsupported", "ssh");
    const link = this.#hub.link(machine.id);
    if (link === undefined) throw new PlaceError("offline");
    let reply;
    try {
      reply = await link.daemon("places", op, {
        timeoutMs: TIMEOUT_MS[op.op],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
    } catch (error) {
      throw linkFailure(error);
    }
    if (!reply.ok)
      throw new PlaceError(reply.failure.code, reply.failure.detail);
    return reply.value as MachinePlaceResults[O];
  }

  /**
   * A typed path as the machine means it, which must be a directory there: what a project is made
   * of. `~`, drives and backslashes are the machine's business, not this host's.
   */
  async directory(machine: MachineRecord, raw: string): Promise<string> {
    const found = await this.ask(machine, { op: "resolve", path: raw });
    if (!found.exists) throw new PlaceError("not_found");
    if (!found.directory) throw new PlaceError("not_directory");
    return found.path;
  }
}

/** What went wrong on the way, rather than on the machine. */
function linkFailure(error: unknown): PlaceError {
  if (error instanceof LinkError) {
    if (error.kind === "timeout") return new PlaceError("timeout");
    if (error.kind === "aborted") return new PlaceError("cancelled");
    if (error.kind === "lost") return new PlaceError("offline");
    // A daemon from before places says it has no such method: it has to be brought up to date.
    if (error.kind === "remote" && /unknown method/.test(error.message))
      return new PlaceError("unsupported", "update");
    return new PlaceError("other", error.message);
  }
  return new PlaceError(
    "other",
    error instanceof Error ? error.message : String(error),
  );
}

/** A failure a person can read in a log or an old client: the code, and what the machine said. */
function describeFailure(error: unknown, path?: string): string {
  if (!(error instanceof PlaceError))
    return error instanceof Error ? error.message : String(error);
  const at = path === undefined ? "" : `: ${path}`;
  switch (error.failure.code) {
    case "not_found":
      return `no such directory${at}`;
    case "not_directory":
      return `not a directory${at}`;
    case "not_absolute":
      return `the path must be absolute${at}`;
    case "invalid":
      return `not a path on that machine${at}`;
    case "offline":
      return path === undefined
        ? "the machine is offline"
        : `the machine is offline, so ${path} cannot be checked`;
    case "unsupported":
      return error.failure.detail === "ssh"
        ? "directories on an SSH machine cannot be chosen yet"
        : "the machine's daemon is too old for this; update it";
    default:
      return error.message;
  }
}

/** A place failure as a wire error: the words for a log, the code for the client. */
export function wireFailure(error: unknown, path?: string): Error {
  if (!(error instanceof PlaceError))
    return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(describeFailure(error, path)), {
    problem: error.problem,
  });
}
