/**
 * The connection as the interface sees it: the wire to the host, and the controller that decides
 * which host that is and walks through finding, starting, losing and regaining it.
 */
import type { MountedPlugin, UpgradeBusy } from "@eta/client-contracts";
import type { StoreApi } from "zustand/vanilla";
import type { ConnectionSetting, SaveProblem } from "../config/types";

/** What the client holds for one target. */
export interface TargetState {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
  /**
   * 0: the copy is not being kept up to date (it came with `hello`, or its last user has left).
   * Above 0: the copy last came from the state frames of a subscription that is still held. It
   * follows the host while the connection is open; between a drop and the next `hello` it may
   * lag behind the host.
   */
  version: number;
}

/**
 * `connecting`: the first attempt. `open`: the host said hello. `reconnecting`: the connection
 * dropped (or the first attempt failed) and another one is coming.
 */
export type WireStatus = "connecting" | "open" | "reconnecting";

export interface WireState {
  status: WireStatus;
  /** `hello.ops`: the name of everything callable, `target.action`. */
  ops: string[];
  /** `hello.mounted`. */
  mounted: MountedPlugin[];
  /** Per target: what the client holds. Only targets with users, and the eager ones. */
  targets: Record<string, TargetState>;
  /** The targets the host answered `target:missing` for. Cleared by state for it and by a new connection. */
  missing: Record<string, true>;
  /** The last frame the host could not read at all. */
  error: string | undefined;
}

export interface WireEvent {
  name: string;
  data: unknown;
}

/** One connection to one host's `/ws`, kept open across drops until it is closed. */
export interface WireClient {
  readonly store: StoreApi<WireState>;
  /** Whether the host registered `target.action`, as of the last hello. */
  can: (op: string) => boolean;
  /**
   * Call `target.action` and wait for the reply. Without a connection it rejects at once; a call
   * the connection dropped under rejects too and is not sent again.
   */
  call: <T = unknown>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  /** Want a target's state; it is subscribed again after every reconnect. Returns the release, which works once. */
  subscribe: (target: string) => () => void;
  /** Listen to a subscribed target's events. Returns the release. */
  onEvent: (target: string, listener: (event: WireEvent) => void) => () => void;
}

/** Why the controller stopped trying and asks the user what to do. */
export type UnreachableReason =
  /** The host did not answer for the whole grace period. */
  | "timeout"
  /** The temporary host never said which port it listens on. */
  | "temporary-failed"
  /** The temporary host ended while in use. */
  | "temporary-exited";

/** Where the controller is. The interface draws one screen per phase. */
export type ConnectionPhase =
  | { name: "idle" }
  /**
   * No connection in the settings: the three choices. `suggestedUrl` is the host `eta-host running`
   * names, else a host that answered `/up` at the local address.
   */
  | { name: "first-run"; suggestedUrl: string | undefined }
  /** `eta-host` was needed and is nowhere: how to install it. */
  | { name: "host-missing"; wanted: "temporary" | "install" }
  /**
   * The user asked for a host on this computer (`wanted`), and `eta-host running` named one that
   * already serves its `~/.eta`: none is started over it, and the user may connect to that one.
   */
  | {
      name: "existing-host";
      url: string;
      token: ExistingHostToken;
      wanted: "temporary" | "install";
    }
  | { name: "starting-temporary" }
  | { name: "installing"; step: "running" | "waiting-up" }
  /** `install-service` failed or the service never answered; `output` is what it printed. */
  | {
      name: "install-failed";
      output: string;
      /** Which part failed: running `install-service`, or waiting for the service's `/up`. */
      step: "running" | "waiting-up";
    }
  | { name: "connecting"; url: string; temporary: boolean }
  | { name: "connected"; url: string; temporary: boolean }
  /** The connection dropped or the first attempt failed; retries are running. `since` is epoch ms. */
  | { name: "reconnecting"; url: string; temporary: boolean; since: number }
  /** The host refused the token. */
  | { name: "unauthorized"; url: string }
  /** Retries stopped: the three choices. `output` is the temporary host's, when it is the one that failed. */
  | {
      name: "unreachable";
      url: string | undefined;
      reason: UnreachableReason;
      output: string | undefined;
    }
  | { name: "stopped" };

/** The token of a host `eta-host running` named. */
export type ExistingHostToken =
  /** It names no token file. */
  | { kind: "none" }
  | { kind: "read"; value: string }
  /** It names a token file that could not be read, or that holds nothing. */
  | { kind: "unreadable"; file: string };

/** The host's build differs from this TUI's. */
export interface VersionWarning {
  host: string;
  tui: string;
}

export interface ConnectionState {
  phase: ConnectionPhase;
  /** The wire of the current host; replaced when the host changes. */
  wire: WireClient | undefined;
  /** The setting in use, which may differ from the file (a one-off temporary host). */
  setting: ConnectionSetting | undefined;
  /** The token comes from `ETA_TOKEN`, so the settings' token is not the one in use. */
  tokenFromEnv: boolean;
  versionWarning: VersionWarning | undefined;
  /** The last choice could not be saved to the settings file. */
  saveProblem: SaveProblem | undefined;
  /**
   * The resident address in the settings (`configured`) did not answer, and the connection is to
   * the host `eta-host running` named (`url`) instead, for this run; the settings are unchanged.
   */
  fallback: { configured: string; url: string } | undefined;
}

/** How to run `eta-host`: the program, and the arguments that come before the host's own. */
export interface HostProgram {
  command: string;
  args: string[];
}

/** What a quick look at an address found. */
export type AddressCheck =
  | { result: "ok"; url: string }
  | { result: "needs-token"; url: string }
  | { result: "bad-token"; url: string }
  | { result: "unreachable"; url: string }
  | { result: "invalid" };

/**
 * Finds the host and keeps the connection to it. Every action moves `phase`; the interface only
 * reads the state and calls actions, and never reaches the host program or the settings itself.
 */
export interface ConnectionController {
  getState: () => ConnectionState;
  subscribe: (listener: () => void) => () => void;
  /** Read the settings and connect, start a temporary host, or ask (`first-run`). Once. */
  start: () => Promise<void>;
  /** Normalise an address and see whether a host answers there, and whether it wants a token. */
  checkAddress: (url: string, token?: string) => Promise<AddressCheck>;
  /** Connect to a host at an address and save it as the connection. */
  connectResident: (input: { url: string; token?: string }) => Promise<void>;
  /** Start a temporary host and connect to it; `persist` saves it as the connection. */
  startTemporary: (options: { persist: boolean }) => Promise<void>;
  /** Install the local host as a service, wait for it, connect and save it as the connection. */
  installResident: () => Promise<void>;
  /**
   * What moving to an installed service would interrupt; undefined when the host cannot say
   * (no `upgrade.check`, or it failed).
   */
  handoverBusy: () => Promise<UpgradeBusy[] | undefined>;
  /** Stop the temporary host, install the service, wait for it, reconnect, save. */
  handover: () => Promise<void>;
  /**
   * Leave `install-failed`, `host-missing` or `existing-host`: back to the choices that led there
   * (the first-run choices, the unreachable choices, or the temporary host a handover stopped,
   * started again). From `existing-host` with no choices behind it (a temporary host from the
   * settings, a handover), back to the first-run choices.
   */
  dismissFailure: () => Promise<void>;
  /** Close the wire and stop the temporary host, waiting for it to end. */
  stop: () => Promise<void>;
}
