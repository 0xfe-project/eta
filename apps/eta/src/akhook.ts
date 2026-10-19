/**
 * akhook on the host: the rules every session of this process lives under.
 *
 * Where rules come from, in akhook's merge order: the user's file (`<config dir>/akhook/akhook.yml`),
 * the project's `.akhook.yml` found from the session's directory upward, and then the host's own
 * layers, which neither of those can disable or replace: `AKHOOK_ADDITIONAL_CONFIG_PATH`, the
 * data directory's `akhook.yml`, and whatever the embedding passes in (an environment that ships
 * its own config). They are read again when a file changes.
 *
 * What the rules do, per session: tool-call rules and the user's approval list are one tool
 * middleware (a question is a card in the inbox either way), streaming rules watch the
 * generation, and the lifecycle rules run around each reply.
 */
import type { ConfigInput } from "@eta/plugin-akhook";
import type { RunHooks } from "./conversations/engine";
import type { SessionHooks } from "./session-hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  additionalConfigPathsFromEnv,
  AkhookSession,
  journalTriggerStore,
  lifecycleHooks,
} from "@eta/plugin-akhook";

export interface AkhookHostOptions {
  dataDir: string;
  /** The user-level file; defaults to akhook's own path. */
  userConfigPath?: string | undefined;
  /** More host layers, after the environment's and the data directory's. */
  additional?: readonly ConfigInput[] | undefined;
  /** The tools the user wants to be asked about, read at every call. */
  approvals: () => readonly string[];
  warn: (message: string) => void;
}

export class AkhookHost {
  readonly #options: AkhookHostOptions;
  readonly #sessions = new WeakMap<object, AkhookSession>();
  readonly #lifecycle: ReturnType<typeof lifecycleHooks>;

  constructor(options: AkhookHostOptions) {
    this.#options = options;
    this.#lifecycle = lifecycleHooks({
      userConfigPath: options.userConfigPath,
      additional: () => this.layers(),
      fallbackRoot: options.dataDir,
      warn: options.warn,
    });
  }

  /** The host's layers: from the environment, the data directory, and the embedding. */
  layers(): ConfigInput[] {
    const file = join(this.#options.dataDir, "akhook.yml");
    return [
      ...additionalConfigPathsFromEnv(),
      ...(existsSync(file) ? [{ path: file }] : []),
      ...(this.#options.additional ?? []),
    ];
  }

  /**
   * The same layers as text, for a machine that cannot read this one's files. A file that cannot
   * be read is left out here; the rules that depended on it simply do not travel.
   */
  layerTexts(): { name: string; text: string }[] {
    const texts: { name: string; text: string }[] = [];
    for (const layer of this.layers()) {
      if ("text" in layer) texts.push(layer);
      else {
        try {
          texts.push({
            name: layer.path,
            text: readFileSync(layer.path, "utf8"),
          });
        } catch (error) {
          this.#options.warn(
            `[eta] could not read ${layer.path} for a remote session: ${String(error)}`,
          );
        }
      }
    }
    return texts;
  }

  #session(input: Parameters<NonNullable<SessionHooks["toolMiddleware"]>>[0]) {
    let made = this.#sessions.get(input.session);
    if (made === undefined) {
      made = new AkhookSession({
        cwd: input.meta.cwd,
        ask: input.session.ask,
        approvals: (name) => this.#options.approvals().includes(name),
        userConfigPath: this.#options.userConfigPath,
        additional: () => this.layers(),
        store: journalTriggerStore(input.session),
        warn: this.#options.warn,
      });
      this.#sessions.set(input.session, made);
    }
    return made;
  }

  readonly toolMiddleware: NonNullable<SessionHooks["toolMiddleware"]> = (
    input,
  ) => [this.#session(input).middleware];

  readonly sessionAttach: NonNullable<SessionHooks["sessionAttach"]> = async (
    input,
  ) => {
    await this.#session(input).attach(input.session);
  };

  /** `prompt_submit` and `stop` rules around each reply of the engine. */
  readonly runHooks: RunHooks = {
    beforeRun: (run) =>
      this.#lifecycle.beforeRun(
        { cwd: run.cwd, sessionId: run.sessionId, turnId: run.replyId },
        run.told,
      ),
    afterRun: (run) =>
      this.#lifecycle.afterRun(
        { cwd: run.cwd, sessionId: run.sessionId, turnId: run.replyId },
        run.said,
      ),
  };
}
