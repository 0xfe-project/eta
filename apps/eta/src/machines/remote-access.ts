/**
 * Remote access & smart route discovery for the primary host.
 *
 * Keeps the Tailscale HTTPS (`tailscale serve`) preference in SQLite (`setting` table), enforces
 * the security invariant that Tailscale Serve ALWAYS turns on the Token Gate before exposing the
 * loopback port, verifies reachability against `/.well-known/eta/host`, and computes the ordered
 * list of reachable routes (`public` > `tailscale_https` > `tailnet` > `lan` > `loopback`).
 *
 * Shutdown/upgrade intentionally does NOT tear down a persisted Tailscale Serve route so upgrades
 * do not drop remote connections; only an explicit disable removes it.
 */
import type {
  MachineResults,
  MachineRouteView,
  TailscaleServeDiagnostic,
  TailscaleServeHolderStatus,
  TailscaleServeStatusView,
} from "@eta/client-contracts";
import type { Access } from "../access";
import type { SettingStore } from "../settings/store";
import type { Tailscale } from "./tailscale";
import { hostname } from "node:os";
import { WELL_KNOWN_HOST_PATH } from "@eta/client-contracts";
import {
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  normalizeHostname,
  probeCloudMetadata,
  resolveDirectEndpoints,
} from "./direct-endpoints";
import {
  buildTailscaleHttpsBaseUrl,
  DEFAULT_TAILSCALE_SERVE_PORT,
  probeHttpsEndpoint,
  TAILSCALE_PROBE_ATTEMPTS,
  TAILSCALE_PROBE_RETRY_DELAY_MS,
  TAILSCALE_PROBE_TIMEOUT_MS,
  tailscaleDiagnosticMessage,
  TailscaleError,
} from "./tailscale";

export const TAILSCALE_SERVE_SETTING_KEY = "remote.tailscaleServe";

interface TailscaleServePreference {
  enabled: boolean;
  port: number;
}

export type TailscaleProbe = (input: {
  baseUrl: string;
  expectedHostId: string;
  tailnetIpv4?: string;
  path?: string;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}) => Promise<boolean>;

export function readTailscaleServePreference(
  settings: SettingStore,
): TailscaleServePreference {
  const raw = settings.get(TAILSCALE_SERVE_SETTING_KEY);
  if (typeof raw !== "object" || raw === null) {
    return { enabled: false, port: DEFAULT_TAILSCALE_SERVE_PORT };
  }
  const record = raw as { enabled?: unknown; port?: unknown };
  const port =
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    record.port >= 1 &&
    record.port <= 65_535
      ? record.port
      : DEFAULT_TAILSCALE_SERVE_PORT;
  return { enabled: record.enabled === true, port };
}

function normalizeHttpOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function localTargetHostOf(bound: string): string {
  const trimmed = bound.trim();
  if (
    trimmed === "" ||
    trimmed === "0.0.0.0" ||
    trimmed.toLowerCase() === "localhost"
  ) {
    return "127.0.0.1";
  }
  if (trimmed === "::" || trimmed === "::1" || trimmed === "[::1]") {
    return "::1";
  }
  return normalizeHostname(trimmed);
}

function loopbackUrlOf(bound: string, port: number): string {
  const normalized = normalizeHostname(bound);
  const host =
    normalized === "::" || normalized === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${port}`;
}

function boundFallbackUrlOf(bound: string, port: number): string {
  if (isWildcardHost(bound)) return `http://${hostname()}:${port}`;
  return `http://${formatHostForUrl(normalizeHostname(bound))}:${port}`;
}

function diagnosticFromError(error: unknown): TailscaleServeDiagnostic {
  if (error instanceof TailscaleError) {
    if (error.code === "https-disabled") return "https-disabled";
    if (error.code === "not-installed") return "not-installed";
    if (error.diagnostic !== undefined) {
      switch (error.diagnostic) {
        case "not-logged-in":
        case "not-running":
        case "permission-denied":
        case "unsupported-target":
          return error.diagnostic;
        case "no-existing-handler":
        case "unknown":
          return "unknown";
      }
    }
  }
  return "unknown";
}

function messageForDiagnostic(
  diagnostic: TailscaleServeDiagnostic,
  options: {
    servePort: number;
    localHost: string;
    holderStatus?: TailscaleServeHolderStatus;
    rollbackFailed?: boolean;
  },
): string {
  if (diagnostic === "probe-failed") {
    if (options.holderStatus === "ours") {
      return options.rollbackFailed
        ? `Tailscale Serve is still active on HTTPS port ${options.servePort} (rollback failed), and ${WELL_KNOWN_HOST_PATH} could not be verified. Check Tailscale permissions, then retry or turn Tailscale HTTPS off.`
        : `Tailscale Serve is active on HTTPS port ${options.servePort}, but ${WELL_KNOWN_HOST_PATH} could not be verified. Ensure HTTPS certificates are enabled on your tailnet, then retry or turn Tailscale HTTPS off.`;
    }
    return `Tailscale HTTPS verification failed on port ${options.servePort} (${WELL_KNOWN_HOST_PATH} could not be reached), so Tailscale Serve was rolled back. Ensure HTTPS certificates are enabled on your tailnet and try again.`;
  }
  return tailscaleDiagnosticMessage(diagnostic, options);
}

export interface RemoteAccessOptions {
  settings: SettingStore;
  hostname: string;
  port: () => number;
  hostId: () => string | undefined;
  publicUrl?: string | undefined;
  tailscale?: Tailscale | undefined;
  access?: Access | undefined;
  initialEnabled?: boolean | undefined;
  initialPort?: number | undefined;
  probe?: TailscaleProbe | undefined;
  onCloudVm?: boolean | undefined;
  changed: () => void;
  warn: (message: string) => void;
}

export class RemoteAccess {
  readonly #settings: SettingStore;
  readonly #hostname: string;
  readonly #port: () => number;
  readonly #hostId: () => string | undefined;
  readonly #explicitPublicUrl: string | undefined;
  readonly #tailscale: Tailscale | undefined;
  readonly #access: Access | undefined;
  readonly #probe: TailscaleProbe;
  readonly #changed: () => void;
  readonly #warn: (message: string) => void;

  #enabled: boolean;
  #servePort: number;
  #activeUrl: string | null = null;
  #lastHolderStatus: TailscaleServeHolderStatus | undefined;
  #lastDiagnostic: TailscaleServeDiagnostic | undefined;
  #lastError: string | undefined;
  #cloudVmPromise: Promise<boolean> | undefined;
  #cloudVmFixed: boolean | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RemoteAccessOptions) {
    this.#settings = options.settings;
    this.#hostname = options.hostname;
    this.#port = options.port;
    this.#hostId = options.hostId;
    this.#explicitPublicUrl = normalizeHttpOrigin(options.publicUrl);
    this.#tailscale = options.tailscale;
    this.#access = options.access;
    this.#probe =
      options.probe ?? (async (input) => await probeHttpsEndpoint(input));
    this.#changed = options.changed;
    this.#warn = options.warn;
    this.#cloudVmFixed = options.onCloudVm;

    const pref = readTailscaleServePreference(options.settings);
    this.#enabled = options.initialEnabled ?? pref.enabled;
    this.#servePort = options.initialPort ?? pref.port;
  }

  /** Verified Tailscale HTTPS origin, or null when inactive. */
  get activeUrl(): string | null {
    return this.#activeUrl;
  }

  /** Configured explicit `--public-url` or verified Tailscale HTTPS origin. */
  effectivePublicUrl(): string | undefined {
    return this.#explicitPublicUrl ?? this.#activeUrl ?? undefined;
  }

  /** Reconcile persisted or CLI-requested Tailscale Serve once the HTTP server is listening. */
  async reconcileStartup(options: { persist?: boolean } = {}): Promise<void> {
    if (!this.#enabled) return;
    // Fail-closed: ensure the token gate is on whenever Tailscale Serve is expected.
    this.#access?.setDynamicGate(true);
    const result = await this.setTailscaleServe({
      enabled: true,
      port: this.#servePort,
      persist: options.persist ?? true,
      keepIntentOnFailure: true,
    });
    if (!result.ok) {
      this.#warn(
        `[eta] Tailscale HTTPS could not be started on port ${this.#servePort}: ${result.tailscaleServe.error ?? result.tailscaleServe.diagnostic ?? "unknown error"}`,
      );
    }
  }

  /** Discover all routes and current Tailscale HTTPS status. */
  async addresses(): Promise<MachineResults["addresses"]> {
    // Let unexpected `tailscale.status()` rejections propagate (e.g. broken mock in TUI tests).
    const status = await this.#tailscale?.status();
    return await this.#buildAddresses(status);
  }

  /** Best default URL for phone pairing / daemon enrollment when no explicit URL was passed. */
  async defaultUrl(): Promise<string> {
    const info = await this.addresses();
    return (
      info.preferredUrl ?? boundFallbackUrlOf(this.#hostname, this.#port())
    );
  }

  /** Enable or disable Tailscale HTTPS (`tailscale serve`) and persist the choice. */
  async setTailscaleServe(input: {
    enabled: boolean;
    port?: number;
    persist?: boolean;
    keepIntentOnFailure?: boolean;
  }): Promise<MachineResults["setTailscaleServe"]> {
    const run = this.#queue.then(
      () => this.#applyTailscaleServe(input),
      () => this.#applyTailscaleServe(input),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async #applyTailscaleServe(input: {
    enabled: boolean;
    port?: number;
    persist?: boolean;
    keepIntentOnFailure?: boolean;
  }): Promise<MachineResults["setTailscaleServe"]> {
    const servePort =
      input.port ?? this.#servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) {
      throw new Error(
        "machines.setTailscaleServe: port must be an integer between 1 and 65535",
      );
    }

    if (!input.enabled) {
      return await this.#disable(servePort);
    }
    return await this.#enable(servePort, {
      persist: input.persist ?? true,
      keepIntentOnFailure: input.keepIntentOnFailure === true,
    });
  }

  async #enable(
    servePort: number,
    options: { persist: boolean; keepIntentOnFailure: boolean },
  ): Promise<MachineResults["setTailscaleServe"]> {
    const localHost = localTargetHostOf(this.#hostname);
    const localPort = this.#port();
    const prevEnabled = this.#enabled;
    const prevActiveUrl = this.#activeUrl;
    const prevPort = this.#servePort;

    const fail = async (
      diagnostic: TailscaleServeDiagnostic,
      details: {
        installed: boolean;
        running: boolean;
        magicDnsName: string | null;
        httpsCapable: boolean | null;
        holderStatus?: TailscaleServeHolderStatus;
        rollbackFailed?: boolean;
        error?: string;
      },
    ): Promise<MachineResults["setTailscaleServe"]> => {
      const error =
        details.error ??
        messageForDiagnostic(diagnostic, {
          servePort,
          localHost,
          ...(details.holderStatus === undefined
            ? {}
            : { holderStatus: details.holderStatus }),
          ...(details.rollbackFailed === undefined
            ? {}
            : { rollbackFailed: details.rollbackFailed }),
        });
      if (options.keepIntentOnFailure) {
        this.#lastDiagnostic = diagnostic;
        this.#lastError = error;
        this.#lastHolderStatus = details.holderStatus;
      } else if (
        diagnostic === "probe-failed" &&
        details.holderStatus === "ours"
      ) {
        this.#lastDiagnostic = diagnostic;
        this.#lastError = error;
        this.#lastHolderStatus = "ours";
        if (!prevEnabled && this.#activeUrl === null) {
          this.#servePort = servePort;
        }
      }
      const status = details.running
        ? await this.#tailscale?.status().catch(() => undefined)
        : undefined;
      const addr = await this.#buildAddresses(status);
      const tailscaleServe: TailscaleServeStatusView = {
        installed: details.installed,
        running: details.running,
        magicDnsName: details.magicDnsName,
        httpsCapable: details.httpsCapable,
        enabled: this.#enabled,
        activeUrl: this.#activeUrl,
        port: servePort,
        ...(details.holderStatus === undefined
          ? {}
          : { holderStatus: details.holderStatus }),
        diagnostic,
        error,
      };
      return {
        ok: false,
        tailscaleServe,
        routes: addr.routes,
        preferredUrl: addr.preferredUrl,
      };
    };

    if (this.#tailscale === undefined || !this.#tailscale.installed) {
      return await fail("not-installed", {
        installed: false,
        running: false,
        magicDnsName: null,
        httpsCapable: null,
      });
    }

    let parsed;
    try {
      parsed = await this.#tailscale.readStatus();
    } catch (error) {
      const diagnostic = diagnosticFromError(error);
      return await fail(diagnostic, {
        installed: true,
        running: false,
        magicDnsName: null,
        httpsCapable: null,
      });
    }

    if (parsed.running !== true) {
      return await fail("not-running", {
        installed: true,
        running: false,
        magicDnsName: parsed.magicDnsName,
        httpsCapable: parsed.httpsServeEnabled,
      });
    }

    if (parsed.magicDnsName === null || parsed.magicDnsName === "") {
      return await fail("magic-dns-missing", {
        installed: true,
        running: true,
        magicDnsName: null,
        httpsCapable: parsed.httpsServeEnabled,
      });
    }

    if (parsed.httpsServeEnabled === false) {
      return await fail("https-disabled", {
        installed: true,
        running: true,
        magicDnsName: parsed.magicDnsName,
        httpsCapable: false,
      });
    }

    let holder: TailscaleServeHolderStatus;
    try {
      holder = await this.#tailscale.readServeRootHolder(servePort, {
        host: localHost,
        port: localPort,
      });
    } catch (error) {
      const diagnostic = diagnosticFromError(error);
      return await fail(diagnostic, {
        installed: true,
        running: true,
        magicDnsName: parsed.magicDnsName,
        httpsCapable: parsed.httpsServeEnabled,
      });
    }

    if (holder === "other") {
      return await fail("port-occupied", {
        installed: true,
        running: true,
        magicDnsName: parsed.magicDnsName,
        httpsCapable: parsed.httpsServeEnabled,
        holderStatus: "other",
      });
    }

    const baseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: parsed.magicDnsName,
      servePort,
    });

    // Security invariant: ALWAYS turn on the Token Gate & allow the Tailscale origin BEFORE
    // publishing the loopback port via `tailscale serve`.
    this.#access?.setDynamicGate(true);
    this.#access?.setExtraAllowedOrigins(
      prevActiveUrl !== null && prevActiveUrl !== baseUrl
        ? [prevActiveUrl, baseUrl]
        : [baseUrl],
    );

    try {
      await this.#tailscale.ensureServe({
        localPort,
        servePort,
        localHost,
      });
    } catch (error) {
      if (!prevEnabled && !options.keepIntentOnFailure) {
        this.#access?.setExtraAllowedOrigins([]);
        this.#access?.setDynamicGate(false);
      } else {
        this.#access?.setExtraAllowedOrigins(
          prevActiveUrl === null ? [] : [prevActiveUrl],
        );
      }
      const diagnostic = diagnosticFromError(error);
      return await fail(diagnostic, {
        installed: true,
        running: true,
        magicDnsName: parsed.magicDnsName,
        httpsCapable:
          diagnostic === "https-disabled" ? false : parsed.httpsServeEnabled,
        holderStatus: holder,
      });
    }

    const hostId = this.#hostId();
    const tailnetIpv4 = parsed.tailnetIpv4Addresses[0];
    const verified =
      hostId !== undefined &&
      (await this.#probe({
        baseUrl,
        expectedHostId: hostId,
        ...(tailnetIpv4 === undefined ? {} : { tailnetIpv4 }),
        path: WELL_KNOWN_HOST_PATH,
        attempts: TAILSCALE_PROBE_ATTEMPTS,
        delayMs: TAILSCALE_PROBE_RETRY_DELAY_MS,
        timeoutMs: TAILSCALE_PROBE_TIMEOUT_MS,
      }));

    if (!verified) {
      let rolledBack = false;
      const rollbackAttempted = holder !== "ours";
      if (rollbackAttempted) {
        try {
          await this.#tailscale.disableServe({ servePort, mount: "/" });
          rolledBack = true;
        } catch (error) {
          rolledBack =
            error instanceof TailscaleError &&
            error.diagnostic === "no-existing-handler";
        }
      }
      // Fail-closed: only turn the dynamic gate back off if we confirmed no serve route remains
      // and we were not previously enabled.
      if (!prevEnabled && !options.keepIntentOnFailure && rolledBack) {
        this.#access?.setExtraAllowedOrigins([]);
        this.#access?.setDynamicGate(false);
      } else {
        this.#access?.setExtraAllowedOrigins(
          prevActiveUrl === null ? [] : [prevActiveUrl],
        );
      }
      if (rolledBack && prevActiveUrl !== null && prevPort === servePort) {
        this.#activeUrl = null;
        this.#changed();
      }
      const postFailureHolderStatus: TailscaleServeHolderStatus = rolledBack
        ? "none"
        : "ours";
      const rollbackFailed = rollbackAttempted && !rolledBack;
      return await fail("probe-failed", {
        installed: true,
        running: true,
        magicDnsName: parsed.magicDnsName,
        httpsCapable: parsed.httpsServeEnabled,
        holderStatus: postFailureHolderStatus,
        rollbackFailed,
      });
    }

    // Switching from another port we verified owning: best-effort cleanup of the old route.
    if (prevActiveUrl !== null && prevPort !== servePort) {
      await this.#tailscale
        .disableServe({ servePort: prevPort, mount: "/" })
        .catch(() => undefined);
    }

    this.#enabled = true;
    this.#servePort = servePort;
    this.#activeUrl = baseUrl;
    this.#lastHolderStatus = "ours";
    this.#lastDiagnostic = undefined;
    this.#lastError = undefined;
    this.#access?.setExtraAllowedOrigins([baseUrl]);
    if (options.persist) {
      this.#settings.set(TAILSCALE_SERVE_SETTING_KEY, {
        enabled: true,
        port: servePort,
      });
    }
    this.#changed();

    const status = await this.#tailscale.status().catch(() => undefined);
    const addr = await this.#buildAddresses(status);
    return {
      ok: true,
      tailscaleServe: addr.tailscaleServe,
      routes: addr.routes,
      preferredUrl: addr.preferredUrl,
    };
  }

  async #disable(
    servePort: number,
  ): Promise<MachineResults["setTailscaleServe"]> {
    const localHost = localTargetHostOf(this.#hostname);
    let finalHolderStatus: TailscaleServeHolderStatus = "none";

    const failDisable = async (
      error: unknown,
    ): Promise<MachineResults["setTailscaleServe"]> => {
      // Fail-closed: keep the token gate on if ownership cannot be verified or disableServe failed.
      const diagnostic = diagnosticFromError(error);
      const message = messageForDiagnostic(diagnostic, {
        servePort,
        localHost,
      });
      this.#lastDiagnostic = diagnostic;
      this.#lastError = message;
      const status = await this.#tailscale?.status().catch(() => undefined);
      const addr = await this.#buildAddresses(status);
      return {
        ok: false,
        tailscaleServe: {
          ...addr.tailscaleServe,
          diagnostic,
          error: message,
        },
        routes: addr.routes,
        preferredUrl: addr.preferredUrl,
      };
    };

    if (this.#tailscale?.installed) {
      const ownsActivePort =
        this.#activeUrl !== null && servePort === this.#servePort;
      let shouldDisable = ownsActivePort;
      if (!ownsActivePort) {
        try {
          const holder = await this.#tailscale.readServeRootHolder(servePort, {
            host: localHost,
            port: this.#port(),
          });
          shouldDisable = holder === "ours";
          if (holder === "other") finalHolderStatus = "other";
        } catch (error) {
          return await failDisable(error);
        }
      }

      if (shouldDisable) {
        try {
          await this.#tailscale.disableServe({ servePort, mount: "/" });
        } catch (error) {
          const isMissing =
            error instanceof TailscaleError &&
            error.diagnostic === "no-existing-handler";
          if (!isMissing) return await failDisable(error);
        }
      }
    }

    this.#enabled = false;
    this.#activeUrl = null;
    this.#lastHolderStatus = finalHolderStatus;
    this.#lastDiagnostic = undefined;
    this.#lastError = undefined;
    this.#settings.delete(TAILSCALE_SERVE_SETTING_KEY);
    this.#access?.setExtraAllowedOrigins([]);
    this.#access?.setDynamicGate(false);
    this.#changed();

    const status = await this.#tailscale?.status().catch(() => undefined);
    const addr = await this.#buildAddresses(status);
    return {
      ok: true,
      tailscaleServe: addr.tailscaleServe,
      routes: addr.routes,
      preferredUrl: addr.preferredUrl,
    };
  }

  async #isCloudVm(): Promise<boolean> {
    if (this.#cloudVmFixed !== undefined) return this.#cloudVmFixed;
    if (isLoopbackHost(this.#hostname)) return false;
    this.#cloudVmPromise ??= probeCloudMetadata().catch(() => false);
    return await this.#cloudVmPromise;
  }

  async #buildAddresses(
    status: Awaited<ReturnType<Tailscale["status"]>>,
  ): Promise<MachineResults["addresses"]> {
    const port = this.#port();
    const bound = this.#hostname;
    const routes: MachineRouteView[] = [];
    const seen = new Set<string>();
    const addRoute = (route: MachineRouteView): void => {
      if (seen.has(route.url)) return;
      seen.add(route.url);
      routes.push(route);
    };

    // 1. Explicit --public-url
    if (this.#explicitPublicUrl !== undefined) {
      const publicHost = new URL(this.#explicitPublicUrl).hostname;
      addRoute({
        kind: "public",
        url: this.#explicitPublicUrl,
        label: "Public URL",
        reachable: !isLoopbackHost(publicHost),
      });
    }

    // 2. Verified Tailscale HTTPS (Tailscale Serve)
    if (this.#activeUrl !== null) {
      addRoute({
        kind: "tailscale_https",
        url: this.#activeUrl,
        label: "Tailscale HTTPS",
        reachable: true,
      });
    }

    // 3. Direct tailnet HTTP (MagicDNS preferred when listening on tailnet or wildcard)
    let hasTailnetRoute = false;
    if (
      status !== undefined &&
      (isWildcardHost(bound) || status.self.addresses.includes(bound))
    ) {
      const name = status.self.dnsName || status.self.addresses[0];
      if (name !== undefined && name !== "") {
        addRoute({
          kind: "tailnet",
          url: `http://${formatHostForUrl(name)}:${port}`,
          label: "Tailscale",
          reachable: true,
        });
        hasTailnetRoute = true;
      }
    }

    // 3b & 4. Direct interface discovery (tailnet fallback + LAN)
    const directEndpoints = isLoopbackHost(bound)
      ? []
      : resolveDirectEndpoints({
          host: bound,
          port,
          onCloudVm: await this.#isCloudVm(),
        });

    for (const endpoint of directEndpoints) {
      if (endpoint.kind === "tailnet") {
        if (!hasTailnetRoute) {
          addRoute({
            kind: "tailnet",
            url: endpoint.url,
            label: "Tailscale",
            reachable: true,
          });
          hasTailnetRoute = true;
        }
      }
    }
    for (const endpoint of directEndpoints) {
      if (endpoint.kind === "lan") {
        addRoute({
          kind: "lan",
          url: endpoint.url,
          label: "LAN",
          reachable: true,
        });
      }
    }

    // 5. Loopback fallback (always listed last, marked unreachable for remote devices)
    addRoute({
      kind: "loopback",
      url: loopbackUrlOf(bound, port),
      label: "Localhost",
      reachable: false,
    });

    const preferredUrl = routes.find((route) => route.reachable)?.url ?? null;
    const tailnet =
      routes.find((route) => route.kind === "tailscale_https")?.url ??
      routes.find((route) => route.kind === "tailnet")?.url ??
      null;

    const installed = this.#tailscale?.installed === true;
    const running = status !== undefined;
    const magicDnsName =
      status !== undefined && status.self.dnsName !== ""
        ? status.self.dnsName
        : null;
    const httpsCapable = status !== undefined ? status.httpsServeEnabled : null;

    let diagnostic: TailscaleServeDiagnostic | undefined = this.#lastDiagnostic;
    let error: string | undefined = this.#lastError;
    if (diagnostic === undefined && this.#activeUrl === null) {
      if (!installed) {
        diagnostic = "not-installed";
        error = tailscaleDiagnosticMessage("not-installed");
      } else if (!running) {
        diagnostic = "not-running";
        error = tailscaleDiagnosticMessage("not-running");
      } else if (magicDnsName === null) {
        diagnostic = "magic-dns-missing";
        error = tailscaleDiagnosticMessage("magic-dns-missing");
      } else if (httpsCapable === false) {
        diagnostic = "https-disabled";
        error = tailscaleDiagnosticMessage("https-disabled");
      }
    }

    const tailscaleServe: TailscaleServeStatusView = {
      installed,
      running,
      magicDnsName,
      httpsCapable,
      enabled: this.#enabled,
      activeUrl: this.#activeUrl,
      port: this.#servePort,
      ...(this.#lastHolderStatus === undefined
        ? {}
        : { holderStatus: this.#lastHolderStatus }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(error === undefined ? {} : { error }),
    };

    return {
      tailnet,
      routes,
      preferredUrl,
      listeningHost: bound,
      port,
      tailscaleServe,
    };
  }
}
