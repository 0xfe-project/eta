import type {
  ComputerCapabilityState,
  ComputerMachineCapabilities,
} from "@eta/client-contracts";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import process from "node:process";

/**
 * Default denylist of sensitive / security-boundary executables and app identifiers.
 *
 * Inspired by the `Andee v0.15.0` WeChat `FLAG_SECURE` lesson: high-risk targets (credential
 * managers, system security desktops, messaging clients with anti-automation protections) are
 * blocked before any process launch or window message injection occurs.
 */
export const SENSITIVE_PROCESS_DENYLIST = [
  "wechat.exe",
  "weixin.exe",
  "com.tencent.mm",
  "1password.exe",
  "keepass.exe",
  "bitwarden.exe",
  "winlogon.exe",
  "consent.exe",
  "lsass.exe",
  "csrss.exe",
] as const;

export type SensitiveProcessEntry = (typeof SENSITIVE_PROCESS_DENYLIST)[number];

export type ProcessTargetCheckResult =
  | {
      allowed: true;
      target: string;
    }
  | {
      allowed: false;
      code: "sensitive_target_blocked";
      target: string;
      matchedEntry: string;
    };

/**
 * Checks whether an executable path, process name, package identifier, or window title is
 * permitted for Computer Use automation.
 */
export function checkProcessTargetAllowed(
  targetExecutableOrWindowTitle: string,
  extraDenylist: readonly string[] = [],
): ProcessTargetCheckResult {
  const raw = targetExecutableOrWindowTitle.trim();
  const normalized = raw.toLowerCase();
  const basename =
    normalized
      .split(/[/\\]+/)
      .pop()
      ?.trim() ?? normalized;
  const stem = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;

  const combined = [...SENSITIVE_PROCESS_DENYLIST, ...extraDenylist];
  for (const entry of combined) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    const ruleStem = rule.endsWith(".exe") ? rule.slice(0, -4) : rule;

    if (
      normalized === rule ||
      basename === rule ||
      stem === ruleStem ||
      normalized.includes(rule) ||
      (ruleStem.length >= 4 &&
        new RegExp(
          `(^|[^a-z0-9])${escapeRegExp(ruleStem)}([^a-z0-9]|$)`,
          "i",
        ).test(normalized))
    ) {
      return {
        allowed: false,
        code: "sensitive_target_blocked",
        target: targetExecutableOrWindowTitle,
        matchedEntry: entry,
      };
    }
  }

  return {
    allowed: true,
    target: targetExecutableOrWindowTitle,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type WindowsDiagnosticCode =
  | "windows_child_session_ready"
  | "windows_child_session_disabled"
  | "windows_home_edition_no_child_session"
  | "windows_service_session_0"
  | "windows_hidden_desktop_ready"
  | "non_windows_os"
  | "browser_ready"
  | "browser_missing_binary";

export interface WindowsCapabilitiesProbeResult
  extends ComputerMachineCapabilities {
  diagnostics: WindowsDiagnosticCode[];
}

export interface ProbeWindowsCapabilitiesOptions {
  machineId?: string | undefined;
  platform?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  queryRegistryEdition?: (() => string | undefined) | undefined;
  queryChildSessionsEnabled?: (() => boolean | undefined) | undefined;
  isServiceSession?: (() => boolean) | undefined;
  findBrowserExecutable?: (() => string | undefined) | undefined;
}

const WINDOWS_HOME_EDITIONS = new Set([
  "core",
  "coresinglelanguage",
  "corecountryspecific",
  "coreconnected",
  "coren",
  "home",
]);

function isWindowsHomeEdition(edition: string | undefined): boolean {
  if (!edition) return false;
  return WINDOWS_HOME_EDITIONS.has(edition.trim().toLowerCase());
}

function defaultQueryRegistryEdition(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync(
      "reg.exe",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        "/v",
        "EditionID",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        windowsHide: true,
      },
    );
    const match = /EditionID\s+REG_SZ\s+([^\r\n]+)/i.exec(output);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function defaultQueryChildSessionsEnabled(): boolean | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync(
      "reg.exe",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Terminal Server",
        "/v",
        "fSingleSessionPerUser",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        windowsHide: true,
      },
    );
    if (/0x0\b/i.test(output)) {
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

function defaultIsServiceSession(
  env: Record<string, string | undefined>,
): boolean {
  const sessionName = env.SESSIONNAME?.trim().toLowerCase();
  if (sessionName === "services" || sessionName === "service") {
    return true;
  }
  const sessionId = env.SESSIONID?.trim();
  if (sessionId === "0") {
    return true;
  }
  return false;
}

function defaultFindBrowserExecutable(
  platform: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA ?? "";

    const candidates = [
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(localAppData
        ? [
            `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : []),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  if (platform === "darwin") {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const candidate of macCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const linuxCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of linuxCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Probes machine capabilities for Computer Use realms across browser CDP, Windows Child Session
 * (`WTSCreateChildSession`), and Windows Hidden Desktop (`CreateDesktopW` + `PrintWindow`).
 */
export function probeWindowsCapabilities(
  options: ProbeWindowsCapabilitiesOptions = {},
): WindowsCapabilitiesProbeResult {
  const platform = options.platform ?? process.platform;
  const env =
    options.env ?? (process.env as Record<string, string | undefined>);
  const machineId =
    options.machineId ?? env.COMPUTERNAME ?? hostname() ?? "local";
  const diagnostics: WindowsDiagnosticCode[] = [];

  const browserExecutable = options.findBrowserExecutable
    ? options.findBrowserExecutable()
    : defaultFindBrowserExecutable(platform, env);
  const browser: ComputerCapabilityState = browserExecutable
    ? "ready"
    : "missing_binary";
  diagnostics.push(
    browser === "ready" ? "browser_ready" : "browser_missing_binary",
  );

  if (platform !== "win32") {
    diagnostics.push("non_windows_os");
    return {
      machineId,
      os: platform,
      browser,
      browserExecutable,
      windowsChildSession: "unsupported_os",
      windowsHiddenDesktop: "unsupported_os",
      diagnostics,
    };
  }

  const serviceSession = options.isServiceSession
    ? options.isServiceSession()
    : defaultIsServiceSession(env);
  const edition = options.queryRegistryEdition
    ? options.queryRegistryEdition()
    : defaultQueryRegistryEdition();

  if (serviceSession) {
    diagnostics.push("windows_service_session_0");
    return {
      machineId,
      os: platform,
      edition,
      browser,
      browserExecutable,
      windowsChildSession: "service_session",
      windowsHiddenDesktop: "service_session",
      diagnostics,
    };
  }

  let windowsChildSession: ComputerCapabilityState;
  if (isWindowsHomeEdition(edition)) {
    windowsChildSession = "unsupported_edition";
    diagnostics.push("windows_home_edition_no_child_session");
  } else {
    const childEnabled = options.queryChildSessionsEnabled
      ? options.queryChildSessionsEnabled()
      : defaultQueryChildSessionsEnabled();
    if (childEnabled === true) {
      windowsChildSession = "ready";
      diagnostics.push("windows_child_session_ready");
    } else {
      windowsChildSession = "disabled";
      diagnostics.push("windows_child_session_disabled");
    }
  }

  const windowsHiddenDesktop: ComputerCapabilityState = "ready";
  diagnostics.push("windows_hidden_desktop_ready");

  return {
    machineId,
    os: platform,
    edition,
    browser,
    browserExecutable,
    windowsChildSession,
    windowsHiddenDesktop,
    diagnostics,
  };
}
