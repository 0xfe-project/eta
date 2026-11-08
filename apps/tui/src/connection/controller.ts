/**
 * The connection controller: which host to use, and the walk through finding, starting,
 * installing, losing and regaining it, as one `ConnectionState` the interface draws.
 */
import type { UpgradeBusy, UpgradeCheckView } from "@eta/client-contracts";
import type { ConnectionSetting, SaveProblem, TuiPaths } from "../config/types";
import type { TemporaryHost } from "./temporary-host";
import type {
  ConnectionController,
  ConnectionPhase,
  ConnectionState,
  HostProgram,
} from "./types";
import type { WireObserver } from "./wire";
import { saveConnection } from "../config/save";
import { normalizeAddress, wireUrl } from "./address";
import { installService } from "./install";
import { checkAddress, probeToken, probeUp } from "./probe";
import { launchTemporaryHost } from "./temporary-host";
import { versionWarning } from "./version-check";
import { Wire } from "./wire";

export interface ControllerDeps {
  paths: TuiPaths;
  /** The `connection` of the settings as read. */
  setting: ConnectionSetting | undefined;
  /** Read for `ETA_TOKEN`; also the environment of the host processes it starts. */
  env: NodeJS.ProcessEnv;
  findHost: () => HostProgram | undefined;
  tuiVersion: string;
  /** Where a local resident host listens; `http://127.0.0.1:8787` by default. */
  localUrl?: string;
  timing?: Partial<ControllerTiming>;
}

export interface ControllerTiming {
  /** How long retries run after the connection is lost before the controller gives up. */
  giveUpMs: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs: number;
  maxRetryMs: number;
  probeTimeoutMs: number;
  /** How long a temporary host may take to say its port. */
  temporaryStartMs: number;
  /** How long a temporary host may take to end after it is asked to, before it is killed. */
  temporaryStopMs: number;
  /** How long `install-service` may run. */
  installRunMs: number;
  /** How long the installed service may take to answer `/up`. */
  installUpMs: number;
}

export const DEFAULT_TIMING: ControllerTiming = {
  giveUpMs: 15_000,
  initialRetryMs: 500,
  maxRetryMs: 5_000,
  probeTimeoutMs: 1_500,
  temporaryStartMs: 60_000,
  temporaryStopMs: 10_000,
  installRunMs: 120_000,
  installUpMs: 60_000,
};

/**
 * The timing a controller runs with: each value given, the default for the rest. A value set to
 * undefined counts as not given.
 */
export function resolveTiming(
  given: Partial<ControllerTiming> | undefined,
): ControllerTiming {
  const values = Object.entries(given ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  return { ...DEFAULT_TIMING, ...Object.fromEntries(values) };
}

const DEFAULT_LOCAL_URL = "http://127.0.0.1:8787";
const UPGRADE_CHECK = "upgrade.check";
/** What a build from source calls itself (`src/version.ts`). */
const DEV_VERSION = "dev";

type UnreachablePhase = Extract<ConnectionPhase, { name: "unreachable" }>;

/** The choices `dismissFailure` goes back to. */
type FailureOrigin =
  | { kind: "first-run" }
  | { kind: "unreachable"; phase: UnreachablePhase }
  | { kind: "handover" };

/** One wire to one host, from its first attempt until it is replaced or given up. */
interface Session {
  wire: Wire;
  url: string;
  temporary: boolean;
  token: string | undefined;
  firstAttemptAt: number;
  /** Set while reconnecting: when the connection was lost. */
  lostAt: number | undefined;
  /** Runs while there is no hello: from the first attempt, and again from each drop. */
  giveUpTimer: ReturnType<typeof setTimeout> | undefined;
}

/** A temporary host being started: aborting kills it; `done` settles when the start does. */
interface Launch {
  abort: AbortController;
  done: Promise<unknown>;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

class Controller {
  private state: ConnectionState = {
    phase: { name: "idle" },
    wire: undefined,
    setting: undefined,
    tokenFromEnv: false,
    versionWarning: undefined,
    saveProblem: undefined,
  };

  private readonly listeners = new Set<() => void>();
  private readonly timing: ControllerTiming;
  private readonly localUrl: string;
  private readonly envToken: string | undefined;
  private session: Session | undefined;
  /** The temporary host in use. */
  private temporary: TemporaryHost | undefined;
  /**
   * Every temporary host process still alive: the one in use, ones being stopped, and ones a
   * newer action replaced. `stop` and `killTemporaryNow` reach them all.
   */
  private readonly hosts = new Set<TemporaryHost>();
  /** Every start still running, including ones a newer action replaced. */
  private readonly launches = new Set<Launch>();
  /** Every `install-service` still running. */
  private readonly installs = new Set<AbortController>();
  private origin: FailureOrigin = { kind: "first-run" };
  private started = false;
  private stopped = false;
  private versionChecked = false;
  /**
   * Bumped by every action. A continuation of an older action (an await that comes back after
   * the user chose something else, or after `stop`) sees a newer number and does nothing.
   */
  private generation = 0;

  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.timing = resolveTiming(deps.timing);
    this.localUrl = deps.localUrl ?? DEFAULT_LOCAL_URL;
    this.envToken = nonEmpty(deps.env.ETA_TOKEN);
  }

  getState = (): ConnectionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start = async (): Promise<void> => {
    if (this.started || this.stopped) return;
    this.started = true;
    const generation = this.nextAction();
    const setting = this.deps.setting;
    if (setting === undefined) return await this.enterFirstRun(generation);
    if (setting.mode === "temporary")
      return await this.launchTemporary(false, generation);
    this.update({ setting, tokenFromEnv: this.envToken !== undefined });
    this.connect(setting.url, false, this.tokenFor(setting));
  };

  checkAddress = (url: string, token?: string) =>
    checkAddress(url, token, this.timing.probeTimeoutMs);

  connectResident = async (input: {
    url: string;
    token?: string;
  }): Promise<void> => {
    const url = normalizeAddress(input.url);
    if (url === undefined) throw new Error(`not a host address: ${input.url}`);
    const generation = this.nextAction();
    await this.moveToResident(url, nonEmpty(input.token), generation);
  };

  startTemporary = async (options: { persist: boolean }): Promise<void> => {
    const generation = this.nextAction();
    await this.launchTemporary(options.persist, generation);
  };

  installResident = async (): Promise<void> => {
    const generation = this.nextAction();
    this.rememberOrigin();
    await this.install(generation);
  };

  handoverBusy = async (): Promise<UpgradeBusy[] | undefined> => {
    const session = this.session;
    if (this.state.phase.name !== "connected" || session === undefined)
      return undefined;
    if (!session.wire.can(UPGRADE_CHECK)) return undefined;
    try {
      const view = await session.wire.call<UpgradeCheckView>(
        "upgrade",
        "check",
        {},
      );
      return Array.isArray(view.busy) ? view.busy : undefined;
    } catch {
      return undefined;
    }
  };

  handover = async (): Promise<void> => {
    if (this.temporary === undefined)
      throw new Error("the host in use is not a temporary host");
    const generation = this.nextAction();
    this.origin = { kind: "handover" };
    this.endSession();
    this.setPhase({ name: "installing", step: "running" });
    await this.stopTemporary();
    if (!this.isCurrent(generation)) return;
    await this.install(generation);
  };

  dismissFailure = async (): Promise<void> => {
    const { name } = this.state.phase;
    if (name !== "install-failed" && name !== "host-missing") return;
    const generation = this.nextAction();
    const origin = this.origin;
    if (origin.kind === "first-run")
      return await this.enterFirstRun(generation);
    if (origin.kind === "unreachable") return this.setPhase(origin.phase);
    await this.launchTemporary(false, generation);
  };

  stop = async (): Promise<void> => {
    this.stopped = true;
    this.nextAction();
    // Stopped from the first moment: what follows only waits for processes to end.
    if (this.state.phase.name !== "stopped") this.setPhase({ name: "stopped" });
    for (const install of this.installs) install.abort();
    for (const launch of this.launches) launch.abort.abort();
    this.endSession();
    this.temporary = undefined;
    await Promise.all([
      ...[...this.launches].map((launch) => launch.done),
      ...[...this.hosts].map((host) => host.stop(this.timing.temporaryStopMs)),
    ]);
  };

  killTemporaryNow = (): void => {
    for (const launch of this.launches) launch.abort.abort();
    for (const host of this.hosts) host.killNow();
  };

  private nextAction(): number {
    this.generation += 1;
    return this.generation;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.stopped;
  }

  private update(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private setPhase(
    phase: ConnectionPhase,
    patch: Partial<ConnectionState> = {},
  ): void {
    this.update({ ...patch, phase });
  }

  private tokenFor(setting: ConnectionSetting): string | undefined {
    if (setting.mode !== "resident") return undefined;
    return this.envToken ?? nonEmpty(setting.token);
  }

  private async enterFirstRun(generation: number): Promise<void> {
    const answered = await probeUp(this.localUrl, this.timing.probeTimeoutMs);
    if (!this.isCurrent(generation)) return;
    this.setPhase({
      name: "first-run",
      suggestedUrl: answered ? this.localUrl : undefined,
    });
  }

  /** Remember the choices the user is leaving, for `dismissFailure`. */
  private rememberOrigin(): void {
    const phase = this.state.phase;
    if (phase.name === "first-run") this.origin = { kind: "first-run" };
    else if (phase.name === "unreachable")
      this.origin = { kind: "unreachable", phase };
  }

  private async moveToResident(
    url: string,
    token: string | undefined,
    generation: number,
  ): Promise<void> {
    this.endSession();
    await this.stopTemporary();
    if (!this.isCurrent(generation)) return;
    const setting: ConnectionSetting =
      token === undefined
        ? { mode: "resident", url }
        : { mode: "resident", url, token };
    const saveProblem = await saveConnection(this.deps.paths.config, setting);
    if (!this.isCurrent(generation)) return;
    // A token the user has just given is the one to use, over ETA_TOKEN: otherwise a wrong
    // ETA_TOKEN would refuse every token typed to replace it.
    this.update({
      setting,
      saveProblem,
      tokenFromEnv: token === undefined && this.envToken !== undefined,
    });
    this.connect(url, false, token ?? this.tokenFor(setting));
  }

  private async launchTemporary(
    persist: boolean,
    generation: number,
  ): Promise<void> {
    const program = this.deps.findHost();
    if (program === undefined) {
      this.rememberOrigin();
      return this.setPhase({ name: "host-missing", wanted: "temporary" });
    }
    this.endSession();
    this.setPhase({ name: "starting-temporary" });
    await this.stopTemporary();
    if (!this.isCurrent(generation)) return;

    const abort = new AbortController();
    const started = launchTemporaryHost({
      program,
      env: this.deps.env,
      startMs: this.timing.temporaryStartMs,
      signal: abort.signal,
    });
    const launch: Launch = { abort, done: started };
    this.launches.add(launch);
    const result = await started;
    this.launches.delete(launch);
    if (result.ok) this.track(result.host);
    if (!this.isCurrent(generation)) {
      // A newer action (or `stop`) took over while this host started: it is not used.
      if (result.ok) void result.host.stop(this.timing.temporaryStopMs);
      return;
    }
    if (!result.ok) {
      return this.setPhase({
        name: "unreachable",
        url: undefined,
        reason: "temporary-failed",
        output: result.output,
      });
    }
    const host = result.host;
    this.temporary = host;
    host.onExit(() => this.temporaryExited(host));

    let saveProblem: SaveProblem | undefined = this.state.saveProblem;
    if (persist) {
      saveProblem = await saveConnection(this.deps.paths.config, {
        mode: "temporary",
      });
      if (!this.isCurrent(generation)) return;
    }
    if (this.temporary !== host) return;
    this.update({
      setting: { mode: "temporary" },
      tokenFromEnv: false,
      saveProblem,
    });
    this.connect(host.url, true, undefined);
  }

  private temporaryExited(host: TemporaryHost): void {
    // A host this controller asked to stop is no longer `this.temporary`.
    if (this.temporary !== host || this.stopped) return;
    this.temporary = undefined;
    this.endSession();
    this.setPhase({
      name: "unreachable",
      url: host.url,
      reason: "temporary-exited",
      output: host.output(),
    });
  }

  /** Keep a started host in `hosts` until its process ends. */
  private track(host: TemporaryHost): void {
    this.hosts.add(host);
    host.onExit(() => this.hosts.delete(host));
  }

  private async stopTemporary(): Promise<void> {
    const host = this.temporary;
    if (host === undefined) return;
    this.temporary = undefined;
    await host.stop(this.timing.temporaryStopMs);
  }

  private async install(generation: number): Promise<void> {
    const program = this.deps.findHost();
    if (program === undefined)
      return this.setPhase({ name: "host-missing", wanted: "install" });
    if (
      this.state.phase.name !== "installing" ||
      this.state.phase.step !== "running"
    )
      this.setPhase({ name: "installing", step: "running" });
    const abort = new AbortController();
    this.installs.add(abort);
    const result = await installService({
      program,
      env: this.deps.env,
      localUrl: this.localUrl,
      runMs: this.timing.installRunMs,
      upMs: this.timing.installUpMs,
      probeTimeoutMs: this.timing.probeTimeoutMs,
      signal: abort.signal,
      onStep: (step) => {
        if (this.isCurrent(generation))
          this.setPhase({ name: "installing", step });
      },
    });
    this.installs.delete(abort);
    if (!this.isCurrent(generation)) return;
    if (!result.ok) {
      return this.setPhase({
        name: "install-failed",
        output: result.output,
        step: result.step,
      });
    }
    await this.moveToResident(this.localUrl, undefined, generation);
  }

  /** Open a wire to `url` and follow it: hello, failed attempts, drops, the grace period. */
  private connect(
    url: string,
    temporary: boolean,
    token: string | undefined,
  ): void {
    this.endSession();
    // The wire reports only after `connect` below, once the session holds it.
    const observer: WireObserver = {};
    const wire = new Wire({
      url: wireUrl(url),
      ...(token === undefined ? {} : { token }),
      initialRetryMs: this.timing.initialRetryMs,
      maxRetryMs: this.timing.maxRetryMs,
      observer,
    });
    const session: Session = {
      wire,
      url,
      temporary,
      token,
      firstAttemptAt: Date.now(),
      lostAt: undefined,
      giveUpTimer: undefined,
    };
    observer.hello = () => this.helloFrom(session);
    observer.attemptFailed = () => this.attemptFailed(session);
    observer.dropped = () => this.lost(session, Date.now());
    this.session = session;
    this.setPhase(
      { name: "connecting", url, temporary },
      { wire: session.wire },
    );
    // A first attempt can hang without failing (a host that accepts and never answers): the
    // grace period runs from its start, not from a failure that may never come.
    this.armGiveUp(session, session.firstAttemptAt);
    session.wire.connect();
  }

  private endSession(): void {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    clearTimeout(session.giveUpTimer);
    session.wire.close();
    if (this.state.wire === session.wire) this.update({ wire: undefined });
  }

  private helloFrom(session: Session): void {
    if (this.session !== session) return;
    clearTimeout(session.giveUpTimer);
    session.giveUpTimer = undefined;
    session.lostAt = undefined;
    this.setPhase({
      name: "connected",
      url: session.url,
      temporary: session.temporary,
    });
    if (this.versionChecked) return;
    this.versionChecked = true;
    void this.checkVersion(session);
  }

  private attemptFailed(session: Session): void {
    if (this.session !== session) return;
    if (this.state.phase.name === "connecting")
      this.lost(session, session.firstAttemptAt);
    void probeToken(
      session.url,
      session.token,
      this.timing.probeTimeoutMs,
    ).then((answer) => {
      if (answer !== "unauthorized" || this.session !== session) return;
      this.endSession();
      this.setPhase({ name: "unauthorized", url: session.url });
    });
  }

  private lost(session: Session, since: number): void {
    if (this.session !== session || session.lostAt !== undefined) return;
    session.lostAt = since;
    this.setPhase({
      name: "reconnecting",
      url: session.url,
      temporary: session.temporary,
      since,
    });
    // After a failed first attempt the timer armed at the start keeps running.
    if (session.giveUpTimer === undefined) this.armGiveUp(session, since);
  }

  private armGiveUp(session: Session, since: number): void {
    const left = Math.max(0, since + this.timing.giveUpMs - Date.now());
    session.giveUpTimer = setTimeout(() => this.giveUp(session), left);
  }

  private giveUp(session: Session): void {
    if (this.session !== session) return;
    this.endSession();
    this.setPhase({
      name: "unreachable",
      url: session.url,
      reason: "timeout",
      output: undefined,
    });
  }

  // `upgrade.check` asks GitHub for the latest release every time, and GitHub allows an
  // unauthenticated caller 60 requests an hour: once per process is all this asks.
  private async checkVersion(session: Session): Promise<void> {
    // A dev build is never compared, so asking would only spend the allowance.
    if (this.deps.tuiVersion === DEV_VERSION) return;
    if (!session.wire.can(UPGRADE_CHECK)) return;
    let view: UpgradeCheckView;
    try {
      view = await session.wire.call<UpgradeCheckView>("upgrade", "check", {});
    } catch {
      return;
    }
    const version = (view as Partial<UpgradeCheckView> | null)?.version;
    if (this.session !== session || typeof version !== "string") return;
    const warning = versionWarning(version, this.deps.tuiVersion);
    if (warning !== undefined) this.update({ versionWarning: warning });
  }
}

/**
 * The controller for this run. `killTemporaryNow` kills a temporary host on the spot, for the
 * process's `exit` event where nothing can be awaited; otherwise end with `stop`.
 */
export function createConnectionController(
  deps: ControllerDeps,
): ConnectionController & { killTemporaryNow: () => void } {
  const controller = new Controller(deps);
  return {
    getState: controller.getState,
    subscribe: controller.subscribe,
    start: controller.start,
    checkAddress: controller.checkAddress,
    connectResident: controller.connectResident,
    startTemporary: controller.startTemporary,
    installResident: controller.installResident,
    handoverBusy: controller.handoverBusy,
    handover: controller.handover,
    dismissFailure: controller.dismissFailure,
    stop: controller.stop,
    killTemporaryNow: controller.killTemporaryNow,
  };
}
