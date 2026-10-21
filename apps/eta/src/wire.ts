/**
 * What the product's plugins share about the wire: reading a call's arguments, publishing a
 * target's state, and the shape of a plugin that needs the pipe and the session host.
 */
import type { CallFrame } from "@eta/client-wire-proto";
import type { SessionsService, WireService } from "@eta/server";

/** What a cordis plugin is applied on, with the two services every product plugin injects. */
export interface PluginContext {
  wire: WireService;
  sessions: SessionsService;
  effect: (execute: () => () => void | Promise<void>) => unknown;
}

/**
 * A product plugin in the shape the loader understands. `setup` registers the plugin's targets
 * and actions and returns what takes them back; everything it registered goes when the plugin
 * does, like any other. `applied` is told once the registrations are in, because a plugin is
 * applied a moment after it is mounted and the host wants to know when it is whole.
 */
export function productPlugin(
  name: string,
  setup: (ctx: PluginContext) => () => void | Promise<void>,
  applied: () => void,
) {
  return {
    name,
    inject: ["wire", "sessions"],
    apply(ctx: unknown): unknown {
      const context = ctx as PluginContext;
      return context.effect(() => {
        const dispose = setup(context);
        applied();
        return dispose;
      });
    },
  };
}

/**
 * A target whose sections are plain reads of the database.
 *
 * A section's revision is the hash of what it reads, so it can never disagree with the data: a
 * write only has to say that the target moved (`wire.pushNow`), and the pipe sends the sections
 * whose content really changed and nothing when none did. There is no version to bump and so none
 * to forget.
 */
export function publish(
  wire: WireService,
  target: string,
  sections: Record<string, () => unknown>,
  options: { eager?: boolean } = {},
): () => void {
  return wire.stateOf(target, {
    ...(options.eager === true ? { eager: true } : {}),
    project: () => {
      const values: Record<string, unknown> = {};
      const revisions: Record<string, string> = {};
      for (const [name, read] of Object.entries(sections)) {
        const value = read();
        values[name] = value;
        revisions[name] = Bun.hash(JSON.stringify(value)).toString(36);
      }
      return { sections: values, revisions };
    },
  });
}

/**
 * A call's arguments, read with the complaints a client can act on. The wire carries untrusted
 * JSON, so nothing is assumed: a missing or mistyped field is an error naming the call and the
 * field.
 */
export class Args {
  readonly #values: Record<string, unknown>;
  readonly #call: string;

  constructor(call: CallFrame) {
    this.#call = `${call.target}.${call.action}`;
    const raw = call.args ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${this.#call} takes an object`);
    }
    this.#values = raw as Record<string, unknown>;
  }

  /** A string that is there and not blank. */
  string(key: string): string {
    const value = this.optionalString(key);
    if (value === undefined || value.trim() === "")
      throw new Error(`${this.#call} needs ${key}`);
    return value;
  }

  /** A string if one was sent; `undefined` when the field is absent. */
  optionalString(key: string): string | undefined {
    const value = this.#values[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string")
      throw new TypeError(`${this.#call}: ${key} must be a string`);
    return value;
  }

  /** A string, or `null` to clear it, or `undefined` for "leave it". */
  nullableString(key: string): string | null | undefined {
    return this.#values[key] === null ? null : this.optionalString(key);
  }

  optionalBoolean(key: string): boolean | undefined {
    const value = this.#values[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean")
      throw new TypeError(`${this.#call}: ${key} must be true or false`);
    return value;
  }

  optionalInteger(key: string): number | undefined {
    const value = this.#values[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value))
      throw new TypeError(`${this.#call}: ${key} must be an integer`);
    return value;
  }

  integer(key: string): number {
    const value = this.optionalInteger(key);
    if (value === undefined) throw new Error(`${this.#call} needs ${key}`);
    return value;
  }

  /** A list of strings; absent is empty. */
  strings(key: string): string[] {
    const value = this.#values[key];
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    )
      throw new TypeError(`${this.#call}: ${key} must be a list of strings`);
    return value as string[];
  }

  /** A list of `[start, end]` integer pairs; absent is empty. */
  integerPairs(key: string): [number, number][] {
    const value = this.#values[key];
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      !value.every(
        (item) =>
          Array.isArray(item) &&
          item.length === 2 &&
          item.every((n) => typeof n === "number" && Number.isInteger(n)),
      )
    )
      throw new TypeError(
        `${this.#call}: ${key} must be a list of [start, end] integer pairs`,
      );
    return value as [number, number][];
  }
}
