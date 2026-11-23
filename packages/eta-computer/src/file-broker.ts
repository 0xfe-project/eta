import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const FILE_BROKER_DECISIONS = ["allow", "ask", "deny"] as const;
export type FileBrokerDecision = (typeof FILE_BROKER_DECISIONS)[number];

export const FILE_BROKER_MODES = ["read", "write"] as const;
export type FileBrokerMode = (typeof FILE_BROKER_MODES)[number];

export const FILE_BROKER_PLATFORMS = ["win32", "posix"] as const;
export type FileBrokerPlatform = (typeof FILE_BROKER_PLATFORMS)[number];

export const FILE_BROKER_ERROR_CODES = [
  "file_broker_invalid_path",
  "file_broker_denied",
  "file_broker_rejected_by_user",
] as const;
export type FileBrokerErrorCode = (typeof FILE_BROKER_ERROR_CODES)[number];

/**
 * Built-in sensitive filename / directory segment names that are hard-blocked (`deny`)
 * regardless of allowlist configuration or user approval callbacks.
 */
export const DEFAULT_SENSITIVE_SEGMENTS = [
  "secret.key",
  "access-token",
  "identity.json",
  "plugin_config",
  "credential",
  ".ssh",
  ".gnupg",
] as const;

/**
 * Built-in sensitive relative subpath patterns (matched case-insensitively on `/` normalized paths).
 */
export const DEFAULT_SENSITIVE_SUBPATHS = [
  ".eta/llm/auths",
  ".eta/secret.key",
  ".eta/access-token",
  ".eta/identity.json",
  ".eta/plugin_config",
  ".eta/credential",
] as const;

/**
 * Windows reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`,
 * including ISO-8859-1 superscript digits `¹²³`), matched case-insensitively with or without extensions.
 */
const WINDOWS_RESERVED_DEVICE_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])$/i;

const WINDOWS_INVALID_CHARS_PATTERN = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex -- intentionally rejects ASCII control chars 0x00..0x1f in file paths
const CONTROL_CHARS_PATTERN = /[\x00-\x1F]/;
const MAX_SYMLINK_DEPTH = 32;

export class FileBrokerError extends Error {
  readonly code: FileBrokerErrorCode;
  readonly targetPath?: string | undefined;

  constructor(
    code: FileBrokerErrorCode,
    message: string,
    targetPath?: string | undefined,
  ) {
    super(`${code}: ${message}`);
    this.name = "FileBrokerError";
    this.code = code;
    this.targetPath = targetPath;
  }
}

export interface FileBrokerApprovalRequest {
  paths: string[];
  mode: FileBrokerMode;
  reason: string;
}

export type FileBrokerApprovalCallback = (
  request: FileBrokerApprovalRequest,
) => Promise<boolean> | boolean;

export interface FileBrokerPolicyOptions {
  projectDir?: string | undefined;
  worktreeDir?: string | undefined;
  uploadsDir?: string | undefined;
  stagingDir?: string | undefined;
  allowedDirs?: readonly string[] | undefined;
  deniedPaths?: readonly string[] | undefined;
  etaHomeDir?: string | undefined;
  homeDir?: string | undefined;
  platform?: FileBrokerPlatform | undefined;
  askApproval?: FileBrokerApprovalCallback | undefined;
}

export interface FileBrokerEvaluation {
  decision: FileBrokerDecision;
  resolvedPath: string;
  reason: string;
  matchedRule?: string | undefined;
}

export interface FileBrokerAuthorizationResult {
  allowed: string[];
  asked: boolean;
}

/**
 * Check whether a filename or path segment is a Windows reserved device name
 * (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, with or without extensions).
 */
export function isWindowsReservedDeviceName(segment: string): boolean {
  const trimmed = segment.trim().replace(/[. ]+$/g, "");
  if (trimmed.length === 0) return false;
  const stem = trimmed.split(/[.:]/)[0]?.trim() ?? "";
  return WINDOWS_RESERVED_DEVICE_PATTERN.test(stem);
}

interface NormalizedRoot {
  label: string;
  resolvedPath: string;
  compareKey: string;
}

/**
 * Three-tier file path policy (`allow | ask | deny`) for silent file pickers and downloads.
 *
 * - **`deny`**: Hard blocks ETA secret files (`secret.key`, `access-token`, `identity.json`,
 *   `plugin_config`, `credential`, `.eta/llm/auths`), `.ssh`, `.gnupg`, and configured `deniedPaths`.
 * - **`allow`**: Silently allows paths strictly inside `projectDir`, `worktreeDir`, `uploadsDir`,
 *   `stagingDir`, or extra `allowedDirs` after resolving symlinks and nearest existing ancestors.
 * - **`ask`**: Requires explicit user approval via `askApproval` for any other valid host path.
 */
export class FileBrokerPolicy {
  readonly platform: FileBrokerPlatform;
  readonly homeDir: string;
  readonly etaHomeDir: string;

  private readonly allowedRoots: readonly NormalizedRoot[];
  private readonly deniedRoots: readonly NormalizedRoot[];
  private readonly askApproval: FileBrokerApprovalCallback | undefined;
  private readonly defaultBaseDir: string;

  constructor(options: FileBrokerPolicyOptions = {}) {
    this.platform =
      options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    this.askApproval = options.askApproval;

    const rawHome = options.homeDir ?? os.homedir();
    this.homeDir = this.normalizeTrustedDirectory(rawHome);

    const rawEtaHome =
      options.etaHomeDir ?? this.joinPlatform(this.homeDir, ".eta");
    this.etaHomeDir = this.normalizeTrustedDirectory(rawEtaHome);

    const rawAllowed: Array<{ label: string; dir: string }> = [];
    if (options.projectDir) {
      rawAllowed.push({ label: "projectDir", dir: options.projectDir });
    }
    if (options.worktreeDir) {
      rawAllowed.push({ label: "worktreeDir", dir: options.worktreeDir });
    }
    if (options.uploadsDir) {
      rawAllowed.push({ label: "uploadsDir", dir: options.uploadsDir });
    }
    if (options.stagingDir) {
      rawAllowed.push({ label: "stagingDir", dir: options.stagingDir });
    }
    if (options.allowedDirs) {
      for (const dir of options.allowedDirs) {
        if (dir && dir.trim().length > 0) {
          rawAllowed.push({ label: "allowedDirs", dir });
        }
      }
    }

    this.defaultBaseDir =
      rawAllowed[0] !== undefined
        ? this.normalizeTrustedDirectory(rawAllowed[0].dir)
        : this.normalizeTrustedDirectory(process.cwd());

    this.allowedRoots = rawAllowed.map(({ label, dir }) => {
      const resolvedPath = this.normalizeTrustedDirectory(dir);
      return {
        label,
        resolvedPath,
        compareKey: this.toCompareKey(resolvedPath),
      };
    });

    const rawDenied: Array<{ label: string; dir: string }> = [
      {
        label: ".eta/secret.key",
        dir: this.joinPlatform(this.etaHomeDir, "secret.key"),
      },
      {
        label: ".eta/access-token",
        dir: this.joinPlatform(this.etaHomeDir, "access-token"),
      },
      {
        label: ".eta/identity.json",
        dir: this.joinPlatform(this.etaHomeDir, "identity.json"),
      },
      {
        label: ".eta/plugin_config",
        dir: this.joinPlatform(this.etaHomeDir, "plugin_config"),
      },
      {
        label: ".eta/credential",
        dir: this.joinPlatform(this.etaHomeDir, "credential"),
      },
      {
        label: ".eta/llm/auths",
        dir: this.joinPlatform(this.etaHomeDir, "llm", "auths"),
      },
      {
        label: ".ssh",
        dir: this.joinPlatform(this.homeDir, ".ssh"),
      },
      {
        label: ".gnupg",
        dir: this.joinPlatform(this.homeDir, ".gnupg"),
      },
    ];

    if (options.deniedPaths) {
      for (const denied of options.deniedPaths) {
        if (denied && denied.trim().length > 0) {
          rawDenied.push({ label: "deniedPaths", dir: denied });
        }
      }
    }

    this.deniedRoots = rawDenied.map(({ label, dir }) => {
      const resolvedPath = this.normalizeTrustedDirectory(dir);
      return {
        label,
        resolvedPath,
        compareKey: this.toCompareKey(resolvedPath),
      };
    });
  }

  /**
   * Validate, normalize, and resolve symlinks (or nearest existing ancestor directory when the
   * target does not exist yet) for a candidate path.
   */
  resolvePath(rawPath: string): string {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "Path must be a non-empty string",
        rawPath,
      );
    }

    if (CONTROL_CHARS_PATTERN.test(rawPath)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "Path contains null byte or control characters",
        rawPath,
      );
    }

    // Reject Windows device / verbatim namespace prefixes (\\.\ or \\?\)
    if (/^(?:\\\\|\/\/)[.?](?:\\|\/)/.test(rawPath)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "Device namespace paths are not permitted",
        rawPath,
      );
    }

    // Reject drive-relative paths like "C:foo.txt"
    if (/^[a-z]:[^\\/]/i.test(rawPath) || /^[a-z]:$/i.test(rawPath)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "Drive-relative paths are not permitted",
        rawPath,
      );
    }

    // Inspect raw segments for traversal (`..`) and invalid segment names before normalization
    this.validateRawSegments(rawPath);

    const expanded = this.expandTilde(rawPath);
    const absoluteLogical = this.toAbsolutePlatformPath(expanded);
    const resolvedReal = this.resolveRealPathOrAncestor(absoluteLogical, 0);
    const formattedResolved = this.formatPlatformPath(resolvedReal);

    // Re-validate segments after symlink resolution in case a symlink points to CON / NUL / etc.
    this.validateResolvedSegments(formattedResolved, rawPath);

    return formattedResolved;
  }

  /**
   * Evaluate a path under the three-tier policy (`allow | ask | deny`).
   * Throws `FileBrokerError` (`file_broker_invalid_path`) if the path itself is malformed or
   * uses traversal/device tricks.
   */
  evaluate(rawPath: string): FileBrokerEvaluation {
    const expandedLogical = this.formatPlatformPath(
      this.toAbsolutePlatformPath(
        typeof rawPath === "string" &&
          rawPath.trim().length > 0 &&
          !CONTROL_CHARS_PATTERN.test(rawPath)
          ? this.expandTilde(rawPath)
          : rawPath,
      ),
    );
    const resolvedPath = this.resolvePath(rawPath);

    const logicalDeny = this.matchSensitiveRule(expandedLogical);
    if (logicalDeny !== undefined) {
      return {
        decision: "deny",
        resolvedPath,
        reason: `Access to sensitive path (${logicalDeny}) is hard-blocked`,
        matchedRule: logicalDeny,
      };
    }

    const resolvedDeny = this.matchSensitiveRule(resolvedPath);
    if (resolvedDeny !== undefined) {
      return {
        decision: "deny",
        resolvedPath,
        reason: `Access to sensitive path (${resolvedDeny}) is hard-blocked`,
        matchedRule: resolvedDeny,
      };
    }

    const compareKey = this.toCompareKey(resolvedPath);
    for (const root of this.allowedRoots) {
      if (this.isInsideRoot(compareKey, root.compareKey)) {
        return {
          decision: "allow",
          resolvedPath,
          reason: `Path is inside allowed ${root.label}`,
          matchedRule: root.label,
        };
      }
    }

    return {
      decision: "ask",
      resolvedPath,
      reason:
        "Path is outside allowed workspace directories and requires user approval",
    };
  }

  /** Return the three-tier decision (`"allow" | "ask" | "deny"`) for a single path. */
  decide(rawPath: string): FileBrokerDecision {
    return this.evaluate(rawPath).decision;
  }

  /**
   * Authorize a batch of paths for `"read"` or `"write"`.
   *
   * - Throws `FileBrokerError` (`file_broker_invalid_path`) on invalid/traversal/device filenames.
   * - Throws `FileBrokerError` (`file_broker_denied`) if any path resolves to a denied secret path.
   * - If any path evaluates to `"ask"`, calls `askApproval({ paths, mode, reason })` once; throws
   *   `FileBrokerError` (`file_broker_rejected_by_user`) if missing or resolved to `false`.
   */
  async authorizeFiles(
    paths: readonly string[],
    mode: FileBrokerMode = "read",
  ): Promise<FileBrokerAuthorizationResult> {
    if (!Array.isArray(paths)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "paths must be an array of file paths",
      );
    }

    if (paths.length === 0) {
      return { allowed: [], asked: false };
    }

    const evaluations: FileBrokerEvaluation[] = [];
    for (const rawPath of paths) {
      const evaluation = this.evaluate(rawPath);
      if (evaluation.decision === "deny") {
        throw new FileBrokerError(
          "file_broker_denied",
          evaluation.reason,
          evaluation.resolvedPath,
        );
      }
      evaluations.push(evaluation);
    }

    const askPaths = evaluations
      .filter((item) => item.decision === "ask")
      .map((item) => item.resolvedPath);

    if (askPaths.length > 0) {
      if (this.askApproval === undefined) {
        throw new FileBrokerError(
          "file_broker_rejected_by_user",
          `User approval required for ${mode} access to: ${askPaths.join(", ")}`,
          askPaths[0],
        );
      }

      const approved = await this.askApproval({
        paths: askPaths,
        mode,
        reason: `Allow ${mode} access to ${String(askPaths.length)} path(s) outside the workspace allowlist`,
      });

      if (!approved) {
        throw new FileBrokerError(
          "file_broker_rejected_by_user",
          `User rejected ${mode} access to: ${askPaths.join(", ")}`,
          askPaths[0],
        );
      }

      return {
        allowed: evaluations.map((item) => item.resolvedPath),
        asked: true,
      };
    }

    return {
      allowed: evaluations.map((item) => item.resolvedPath),
      asked: false,
    };
  }

  private validateRawSegments(rawPath: string): void {
    const withoutPrefix =
      rawPath === "~"
        ? ""
        : rawPath.startsWith("~/") || rawPath.startsWith("~\\")
          ? rawPath.slice(2)
          : rawPath;

    const rawParts = withoutPrefix.split(/[\\/]+/);
    for (let i = 0; i < rawParts.length; i += 1) {
      const part = rawParts[i] ?? "";
      if (part.length === 0) continue;

      if (part === ".." || part === ".") {
        throw new FileBrokerError(
          "file_broker_invalid_path",
          `Relative traversal segment "${part}" is not allowed`,
          rawPath,
        );
      }

      // Skip Windows drive designator at index 0 (e.g. "C:")
      if (i === 0 && /^[a-z]:$/i.test(part)) {
        continue;
      }

      this.validateSingleSegment(part, rawPath);
    }
  }

  private validateResolvedSegments(
    resolvedPath: string,
    originalInput: string,
  ): void {
    const parts = resolvedPath.split(/[\\/]+/);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      if (part.length === 0) continue;
      if (i === 0 && /^[a-z]:$/i.test(part)) {
        continue;
      }
      this.validateSingleSegment(part, originalInput);
    }
  }

  private validateSingleSegment(segment: string, originalInput: string): void {
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        `Filename segment "${segment}" cannot have trailing dots or spaces`,
        originalInput,
      );
    }

    if (isWindowsReservedDeviceName(segment)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        `Windows reserved device name "${segment}" is not permitted`,
        originalInput,
      );
    }

    if (WINDOWS_INVALID_CHARS_PATTERN.test(segment)) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        `Filename segment "${segment}" contains invalid characters`,
        originalInput,
      );
    }
  }

  private expandTilde(rawPath: string): string {
    if (rawPath === "~") {
      return this.homeDir;
    }
    if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
      const rest = rawPath.slice(2);
      return this.joinPlatform(this.homeDir, rest);
    }
    return rawPath;
  }

  private normalizeTrustedDirectory(dirPath: string): string {
    const expanded =
      dirPath === "~"
        ? os.homedir()
        : dirPath.startsWith("~/") || dirPath.startsWith("~\\")
          ? path.join(os.homedir(), dirPath.slice(2))
          : dirPath;
    const abs = this.toAbsolutePlatformPath(expanded, process.cwd());
    const real = this.resolveRealPathOrAncestor(abs, 0);
    return this.formatPlatformPath(real);
  }

  private toAbsolutePlatformPath(input: string, fallbackBase?: string): string {
    const base = fallbackBase ?? this.defaultBaseDir ?? process.cwd();
    if (this.platform === "win32") {
      const normalizedInput = input.replace(/\//g, "\\");
      if (
        path.win32.isAbsolute(normalizedInput) ||
        /^[a-z]:\\/i.test(normalizedInput)
      ) {
        return path.win32.normalize(normalizedInput);
      }
      return path.win32.resolve(base.replace(/\//g, "\\"), normalizedInput);
    }

    // POSIX mode: support both native POSIX paths (`/foo/bar`) and Windows drive paths (`C:/foo/bar`)
    const slashInput = input.replace(/\\/g, "/");
    if (/^[a-z]:\//i.test(slashInput)) {
      const drive = slashInput.slice(0, 2);
      const rest = path.posix.normalize(slashInput.slice(2));
      return `${drive}${rest}`;
    }
    if (path.posix.isAbsolute(slashInput)) {
      return path.posix.normalize(slashInput);
    }
    const slashBase = base.replace(/\\/g, "/");
    if (/^[a-z]:\//i.test(slashBase)) {
      const drive = slashBase.slice(0, 2);
      const joined = path.posix.resolve(slashBase.slice(2), slashInput);
      return `${drive}${joined}`;
    }
    return path.posix.resolve(slashBase, slashInput);
  }

  private canAccessHostFs(targetPath: string): boolean {
    if (process.platform === "win32") {
      // Only query the Windows host FS when the path is a real Windows path (drive or UNC),
      // so synthetic POSIX paths like `/workspace/project` don't get mapped to `C:\workspace`.
      return /^[a-z]:[\\/]/i.test(targetPath) || /^\\\\/.test(targetPath);
    }
    return targetPath.startsWith("/");
  }

  private resolveRealPathOrAncestor(targetPath: string, depth: number): string {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "Maximum symlink resolution depth exceeded",
        targetPath,
      );
    }

    if (!this.canAccessHostFs(targetPath)) {
      return targetPath;
    }

    const hostTarget =
      process.platform === "win32"
        ? targetPath.replace(/\//g, "\\")
        : targetPath;

    try {
      const real = fs.realpathSync(hostTarget);
      if (process.platform === "win32" && this.platform === "posix") {
        // On Windows NTFS, realpathSync canonicalizes letter casing even when no symlink was traversed.
        // If the path didn't redirect via a symlink/junction/8.3 name, preserve the caller's exact case.
        if (
          real.replace(/\\/g, "/").toLowerCase() ===
          hostTarget.replace(/\\/g, "/").toLowerCase()
        ) {
          return targetPath;
        }
      }
      return real;
    } catch {
      // Path does not exist or cannot be resolved directly; check if it is a dangling symlink
      try {
        const stat = fs.lstatSync(hostTarget);
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(hostTarget);
          const parentDir = path.dirname(hostTarget);
          const resolvedLink = path.resolve(parentDir, linkTarget);
          return this.resolveRealPathOrAncestor(resolvedLink, depth + 1);
        }
      } catch {
        // Not an existing dangling symlink; walk up to the nearest existing ancestor
      }

      const parentDir = path.dirname(hostTarget);
      const baseName = path.basename(hostTarget);
      if (parentDir === hostTarget || baseName.length === 0) {
        return targetPath;
      }

      const resolvedParent = this.resolveRealPathOrAncestor(parentDir, depth);
      if (this.platform === "win32") {
        return path.win32.join(resolvedParent.replace(/\//g, "\\"), baseName);
      }
      return `${resolvedParent.replace(/\\/g, "/").replace(/\/+$/, "")}/${baseName}`;
    }
  }

  private formatPlatformPath(input: string): string {
    if (this.platform === "win32") {
      const winNormalized = path.win32.normalize(input.replace(/\//g, "\\"));
      // Strip trailing backslash unless it is a root like "C:\"
      if (winNormalized.length > 3 && winNormalized.endsWith("\\")) {
        return winNormalized.replace(/\\+$/, "");
      }
      return winNormalized;
    }

    const slash = input.replace(/\\/g, "/");
    if (/^[a-z]:\//i.test(slash)) {
      const drive = slash.slice(0, 2);
      const rest = path.posix.normalize(slash.slice(2));
      const formatted = `${drive}${rest}`;
      return formatted.length > 3 ? formatted.replace(/\/+$/, "") : formatted;
    }
    const posixNormalized = path.posix.normalize(slash);
    if (posixNormalized.length > 1 && posixNormalized.endsWith("/")) {
      return posixNormalized.replace(/\/+$/, "");
    }
    return posixNormalized;
  }

  private joinPlatform(...parts: string[]): string {
    if (this.platform === "win32") {
      return this.formatPlatformPath(
        path.win32.join(...parts.map((p) => p.replace(/\//g, "\\"))),
      );
    }
    return this.formatPlatformPath(
      parts
        .map((p, idx) =>
          idx === 0
            ? p.replace(/\\/g, "/").replace(/\/+$/, "")
            : p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
        )
        .filter((p) => p.length > 0)
        .join("/"),
    );
  }

  private toCompareKey(formattedPath: string): string {
    const slashNormalized = formattedPath
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    return this.platform === "win32"
      ? slashNormalized.toLowerCase()
      : slashNormalized;
  }

  private isInsideRoot(
    targetCompareKey: string,
    rootCompareKey: string,
  ): boolean {
    if (targetCompareKey === rootCompareKey) {
      return true;
    }
    const prefix = rootCompareKey.endsWith("/")
      ? rootCompareKey
      : `${rootCompareKey}/`;
    return targetCompareKey.startsWith(prefix);
  }

  private matchSensitiveRule(formattedPath: string): string | undefined {
    const slashLower = formattedPath
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();

    // 1. Check explicit denied roots (canonicalized ~/.eta secrets, ~/.ssh, ~/.gnupg, and user deniedPaths)
    const compareKey = this.toCompareKey(formattedPath);
    for (const denied of this.deniedRoots) {
      if (this.isInsideRoot(compareKey, denied.compareKey)) {
        return denied.label;
      }
      // Also check case-insensitively on denied secret paths even on POSIX
      const deniedLower = denied.resolvedPath
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      if (
        slashLower === deniedLower ||
        slashLower.startsWith(`${deniedLower}/`)
      ) {
        return denied.label;
      }
    }

    // 2. Check sensitive subpaths anywhere in the path (e.g. any `.eta/llm/auths` or `.eta/secret.key`)
    for (const subpath of DEFAULT_SENSITIVE_SUBPATHS) {
      const needle = `/${subpath.toLowerCase()}`;
      if (slashLower.endsWith(needle) || slashLower.includes(`${needle}/`)) {
        return subpath;
      }
    }

    // 3. Check sensitive segment names anywhere in the path
    const segments = slashLower.split("/").filter((s) => s.length > 0);
    for (const seg of segments) {
      for (const sensitive of DEFAULT_SENSITIVE_SEGMENTS) {
        if (seg === sensitive.toLowerCase()) {
          return sensitive;
        }
      }
    }

    return undefined;
  }
}
