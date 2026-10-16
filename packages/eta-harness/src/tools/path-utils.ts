import type { EnvCallOptions, ExecutionEnv } from "@eta/execution";
/**
 * How a tool turns what a model typed into a path (port of eta-agent's
 * `tools/path-utils.ts`).
 *
 * Two things a model gets wrong often enough to be worth absorbing: unicode
 * spaces (a copy-paste from a web page carries U+00A0 and friends), and a
 * leading `@` (how some agents spell a file reference). Reading also tries the
 * locale-specific spellings of a path before giving up — a file that exists is
 * a file the model asked for.
 */
import { getOrThrow } from "@eta/execution";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

export async function resolveToolPath(
  env: ExecutionEnv,
  path: string,
  options?: EnvCallOptions,
): Promise<string> {
  return getOrThrow(await env.absolutePath(normalizeToolPath(path), options));
}

export async function resolveReadToolPath(
  env: ExecutionEnv,
  path: string,
  options?: EnvCallOptions,
): Promise<string> {
  const resolved = await resolveToolPath(env, path, options);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];

  for (const variant of new Set(variants)) {
    if (getOrThrow(await env.exists(variant, options))) return variant;
  }
  return resolved;
}
