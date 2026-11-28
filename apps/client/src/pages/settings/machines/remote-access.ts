import type {
  MachineResults,
  MachineRouteKind,
  MachineRouteView,
  TailscaleServeStatusView,
} from "@eta/client-contracts";
import { uiText } from "../../../i18n";
import { addressFrom } from "../../../services/host";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const FALLBACK_TAILSCALE_SERVE_PORT = 8443;

/**
 * Tailscale Serve setup (`readStatus`, `readServeRootHolder`, `ensureServe`, up to 44s HTTPS
 * verification probe, and potential rollback `disableServe`) can take up to ~78s in the worst case,
 * exceeding Wire's 30s default call timeout.
 */
export const TAILSCALE_SERVE_CALL_TIMEOUT_MS = 90_000;

export function tailscaleHttpsUrl(
  magicDnsName: string,
  port = DEFAULT_TAILSCALE_SERVE_PORT,
): string {
  return port && port !== DEFAULT_TAILSCALE_SERVE_PORT
    ? `https://${magicDnsName}:${port}`
    : `https://${magicDnsName}`;
}

export function setTailscaleServeArgs(
  enabled: boolean,
  port?: number,
): { enabled: boolean; port?: number } {
  if (
    port !== undefined &&
    (enabled || port !== DEFAULT_TAILSCALE_SERVE_PORT)
  ) {
    return { enabled, port };
  }
  return { enabled };
}

function isTailscaleServeStillActive(
  status: TailscaleServeStatusView | undefined,
): boolean {
  return (
    !!status &&
    (status.holderStatus === "ours" ||
      (status.enabled && status.holderStatus !== "none"))
  );
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return /^(?:localhost|::1|\[::1\]|0\.0\.0\.0|127(?:\.\d+){3})$/.test(
      hostname,
    );
  } catch {
    return false;
  }
}

export function normalizeCustomHostUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: "invalid" | "loopback" } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "invalid" };
  try {
    const url = addressFrom(trimmed);
    if (isLoopbackUrl(url)) return { ok: false, reason: "loopback" };
    return { ok: true, url };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function routeKindLabel(kind: MachineRouteKind): string {
  switch (kind) {
    case "public":
      return uiText("phoneRoutePublic");
    case "tailscale_https":
      return uiText("phoneRouteTailscaleHttps");
    case "tailnet":
      return uiText("phoneRouteTailnet");
    case "lan":
      return uiText("phoneRouteLan");
    case "loopback":
      return "localhost";
  }
}

export function routeChipLabel(
  route: MachineRouteView,
  routes: readonly MachineRouteView[],
): string {
  const base = routeKindLabel(route.kind);
  const sameKind = routes.filter((entry) => entry.kind === route.kind).length;
  if (sameKind <= 1) return base;
  try {
    const host = new URL(route.url).hostname;
    return host ? `${base} · ${host}` : base;
  } catch {
    return base;
  }
}

export function alternateTailscalePort(
  status: TailscaleServeStatusView | undefined,
): number | undefined {
  if (!status || status.diagnostic !== "port-occupied") return undefined;
  return status.port === FALLBACK_TAILSCALE_SERVE_PORT
    ? undefined
    : FALLBACK_TAILSCALE_SERVE_PORT;
}

export function tailscaleDiagnosticText(
  status: TailscaleServeStatusView | undefined,
): string | undefined {
  if (!status) return undefined;
  switch (status.diagnostic) {
    case "not-installed":
      return uiText("tailscaleDiagNotInstalled");
    case "not-running":
      return uiText("tailscaleDiagNotRunning");
    case "not-logged-in":
      return uiText("tailscaleDiagNotLoggedIn");
    case "magic-dns-missing":
      return uiText("tailscaleDiagMagicDnsMissing");
    case "https-disabled":
      return uiText("tailscaleDiagHttpsDisabled");
    case "permission-denied":
      return uiText("tailscaleDiagPermissionDenied");
    case "port-occupied":
      return uiText("tailscaleDiagPortOccupied", { port: status.port });
    case "unsupported-target":
      return uiText("tailscaleDiagUnsupportedTarget");
    case "probe-failed": {
      const port = status.port || DEFAULT_TAILSCALE_SERVE_PORT;
      return isTailscaleServeStillActive(status)
        ? uiText("tailscaleDiagProbeFailedActive", { port })
        : uiText("tailscaleDiagProbeFailed", { port });
    }
    case "unknown":
      return status.error || uiText("tailscaleDiagUnknown");
    case undefined:
      return status.error || undefined;
  }
}

export function mergeTailscaleServeResult(
  prev: MachineResults["addresses"] | undefined,
  result: MachineResults["setTailscaleServe"],
): MachineResults["addresses"] {
  const tailnet =
    result.tailscaleServe.activeUrl ??
    result.routes.find(
      (route) => route.kind === "tailscale_https" || route.kind === "tailnet",
    )?.url ??
    null;
  return {
    tailnet,
    routes: result.routes,
    preferredUrl: result.preferredUrl,
    listeningHost: prev?.listeningHost ?? "127.0.0.1",
    port: prev?.port ?? 0,
    tailscaleServe: result.tailscaleServe,
  };
}
