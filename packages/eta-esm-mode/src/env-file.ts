import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface CapabilityMeta {
  desc?: string;
  args?: Record<string, string>;
}

export interface Capability {
  name: string;
  /** The function expression, exactly as it was written. */
  source: string;
  meta: CapabilityMeta;
}

const GENERATED =
  "// eta:generated — maintained by eta; hand edits here are overwritten on the next write.\nimport eta from 'eta';\n";
const HAND = "// eta:by hand — everything below is kept as written.";
const BLOCK = /^\/\/ eta:capability (\S+)\n([\s\S]*?)^\/\/ eta:end$/gm;

/**
 * `env.js` as a document: a generated half and a hand-written half.
 *
 * The generated half holds one block per ability, each block nothing but an
 * `eta.define` call carrying the function's source and its description. That
 * layout means persisting an ability is not a dump — the source is the thing,
 * it sits in the file, and waking up is evaluating the file. The hand-written
 * half is what a person or a model writes directly; it survives every write.
 *
 * The hash covers both halves and is what decides whether a resident realm is
 * stale. Modification times are not good enough: two edits inside one timestamp
 * granularity leave you debugging a function you already changed.
 */
export class EnvFile {
  readonly #path: string;
  #generated = "";
  #hand = "";
  #capabilitiesMeta = new Map<
    string,
    { source: string; meta: CapabilityMeta }
  >();

  constructor(path: string) {
    this.#path = path;
    this.#absorb(
      EnvFile.exists(path)
        ? readFileSync(path, "utf8")
        : `${GENERATED}\n\n${HAND}\n`,
    );
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Picks up a change made on disk by someone else.
   *
   * An agent editing its own `env.js` is the ordinary case, not an exotic one,
   * and the file is the state — holding a stale copy in memory would make the
   * one thing that decides staleness unable to see the change.
   */
  reload(): boolean {
    if (!EnvFile.exists(this.#path)) return false;
    const text = readFileSync(this.#path, "utf8");
    if (text === this.source) return false;
    this.#absorb(text);
    return true;
  }

  #absorb(text: string): void {
    const handAt = text.indexOf(HAND);
    this.#generated = handAt === -1 ? text : text.slice(0, handAt);
    this.#hand = handAt === -1 ? `${HAND}\n` : text.slice(handAt);

    // Try reading capabilities from JSON meta line (first line)
    const match = /^\/\/ @capabilities (\[.*\])\n/.exec(this.#generated);
    if (match) {
      try {
        const caps = JSON.parse(match[1]!) as Capability[];
        this.#capabilitiesMeta.clear();
        for (const cap of caps) {
          this.#capabilitiesMeta.set(cap.name, {
            source: cap.source,
            meta: cap.meta,
          });
        }
        return;
      } catch {
        // Fall through to block scan
      }
    }

    // Fallback: scan blocks (one-time migration from old format)
    this.#capabilitiesMeta.clear();
    for (const blockMatch of this.#generated.matchAll(BLOCK)) {
      const body = blockMatch[2] ?? "";
      const call = parseDefine(body);
      if (call !== undefined) {
        this.#capabilitiesMeta.set(blockMatch[1] ?? "", {
          source: call.source,
          meta: call.meta,
        });
      }
    }
    // Write meta line for future reads
    this.#syncMetaLine();
  }

  #syncMetaLine(): void {
    const caps = Array.from(this.#capabilitiesMeta.entries()).map(
      ([name, { source, meta }]) => ({
        name,
        source,
        meta,
      }),
    );
    const line = `// @capabilities ${JSON.stringify(caps)}\n`;

    // Remove old meta line if it exists
    this.#generated = this.#generated.replace(/^\/\/ @capabilities .*\n/, "");
    // Prepend new line
    this.#generated = `${line}${this.#generated}`;
  }

  static exists(path: string): boolean {
    try {
      readFileSync(path, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** Every ability in the generated half, in file order. */
  get capabilities(): Capability[] {
    return Array.from(this.#capabilitiesMeta.entries()).map(
      ([name, { source, meta }]) => ({
        name,
        source,
        meta,
      }),
    );
  }

  has(name: string): boolean {
    return this.capabilities.some((capability) => capability.name === name);
  }

  capability(name: string): Capability | undefined {
    return this.capabilities.find((capability) => capability.name === name);
  }

  /** The whole file as one source text. Waking a realm is evaluating this. */
  get source(): string {
    return `${this.#generated.trimEnd()}\n\n${this.#hand}`;
  }

  /** Content hash of the source a realm would evaluate. */
  get hash(): string {
    return createHash("sha256").update(this.source).digest("hex").slice(0, 16);
  }

  /** Adds a block. A name that is taken is an error, never a silent replace. */
  add(name: string, source: string, meta: CapabilityMeta = {}): void {
    this.#withLock(() => {
      // Reload to pick up any concurrent changes
      this.reload();

      if (this.has(name)) {
        // Check if it's the same source (idempotent case - env.js evaluation)
        const existing = this.capability(name);
        if (existing && existing.source.trim() === source.trim()) {
          // Idempotent: same capability already exists, do nothing
          return;
        }
        // Different source - this is an error
        throw new Error(
          `capability "${name}" already exists; read it before replacing`,
        );
      }

      this.#capabilitiesMeta.set(name, { source, meta });
      this.#generated = `${this.#generated.trimEnd()}\n\n${renderBlock(name, source, meta)}`;
      this.#syncMetaLine();

      // Ensure directory exists
      const dir = dirname(this.#path);
      mkdirSync(dir, { recursive: true });

      // Write to temp file then atomic rename
      const tmpPath = `${this.#path}.tmp`;
      writeFileSync(tmpPath, this.source, "utf8");
      renameSync(tmpPath, this.#path);
    });
  }

  /** Replaces a block in place. The caller has already shown the old one. */
  replace(name: string, source: string, meta: CapabilityMeta = {}): boolean {
    if (!this.#capabilitiesMeta.has(name)) return false;
    this.#capabilitiesMeta.set(name, { source, meta });
    let replaced = false;
    this.#generated = this.#generated.replace(
      BLOCK,
      (whole, blockName: string) =>
        blockName === name
          ? ((replaced = true), renderBlock(name, source, meta))
          : whole,
    );
    this.#syncMetaLine();
    if (replaced) this.save();
    return replaced;
  }

  remove(name: string): boolean {
    if (!this.#capabilitiesMeta.has(name)) return false;
    this.#capabilitiesMeta.delete(name);
    let removed = false;
    this.#generated = this.#generated.replace(
      BLOCK,
      (whole, blockName: string) =>
        blockName === name ? ((removed = true), "") : whole,
    );
    this.#syncMetaLine();
    if (removed) this.save();
    return removed;
  }

  save(): void {
    writeFileSync(this.#path, this.source, "utf8");
  }

  /**
   * Execute a function while holding an exclusive lock on this env file.
   *
   * The lock prevents concurrent modifications to shared layers (project/global).
   * For individual layers, the lock ensures consistent write ordering.
   *
   * Lock protocol:
   * 1. Create lock file with O_EXCL (fails if already exists)
   * 2. Execute the critical section
   * 3. Remove the lock file
   *
   * Retry up to 50 times (100ms each = 5 seconds total) if lock is held.
   */
  #withLock<T>(fn: () => T): T {
    const lockPath = `${this.#path}.lock`;
    const maxRetries = 50;
    const retryDelayMs = 100;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Try to create lock file exclusively
        const fd = openSync(lockPath, "wx");
        closeSync(fd);

        try {
          // Critical section
          return fn();
        } finally {
          // Always release lock
          try {
            unlinkSync(lockPath);
          } catch {
            // Lock file might have been cleaned up already, ignore
          }
        }
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Lock file exists, someone else is writing
          if (attempt === maxRetries) {
            throw new Error(
              `Failed to acquire lock for ${this.#path} after ${maxRetries * retryDelayMs}ms`,
            );
          }
          // Wait and retry
          const start = Date.now();
          while (Date.now() - start < retryDelayMs) {
            // Busy wait (could use sleep but this is simple and works)
          }
          continue;
        }
        // Other errors (permission, etc) - rethrow
        throw err;
      }
    }

    // Should never reach here
    throw new Error(`Unexpected lock acquisition failure for ${this.#path}`);
  }
}

function renderBlock(
  name: string,
  source: string,
  meta: CapabilityMeta,
): string {
  const metaText = JSON.stringify(meta);
  return `// eta:capability ${name}\neta.define(${JSON.stringify(name)}, ${source.trim()}, ${metaText});\n// eta:end\n`;
}

function parseDefine(
  body: string,
): { source: string; meta: CapabilityMeta } | undefined {
  // Greedy on the source so the split lands on the last `, {...});` rather than
  // on a `, {` inside the function body.
  const match =
    /^\s*eta\.define\(\s*"(?:[^"\\]|\\.)*"\s*,([\s\S]+?),(\{[^}]*\})\)\s*;?$/.exec(
      body.trim(),
    );
  if (match === null) return undefined;
  const source = match[1]?.trim();
  let meta: CapabilityMeta = {};
  try {
    meta = JSON.parse(match[2] ?? "{}") as CapabilityMeta;
  } catch {
    meta = {};
  }
  return { source, meta };
}
