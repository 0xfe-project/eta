/**
 * The `ssh` plugin: a session whose tools run on another machine.
 *
 * This is the plugin that makes "the environment is a seam" worth having. Nothing about a session
 * changes when it runs over SSH: the same read/write/edit/bash tools, the same memory block, the
 * same platform briefing — against a filesystem that happens to be across the room. What the
 * plugin does is answer the manager's `envFor` for the sessions it owns, and remember which
 * machine each one is on.
 *
 * Three rules it keeps:
 *
 * - **Trust is explicit.** A host key is confirmed by fingerprint: the plugin remembers the one it
 *   accepted for a target (per target, in memory), and refuses a host whose key has changed rather
 *   than accepting it because a prompt was not there to say no.
 * - **A target is remembered per session, not per process.** Two sessions can be on two machines,
 *   and one session's connection is not another's.
 * - **The connection is the session's.** Opening one is asynchronous and a session is created
 *   synchronously-ish; so the environment is built behind a promise that the manager awaits, and a
 *   machine that cannot be reached fails the *creation* rather than producing a session whose every
 *   tool call fails.
 *
 * The plugin also owns the targets themselves: `ssh.targets` / `ssh.save` / `ssh.delete` /
 * `ssh.connect` over the wire, so a client can manage them the way it manages providers. What it
 * deliberately does not do is put a password anywhere: authentication is OpenSSH's (an agent, a
 * key file, a configured host), and the plugin only names the target.
 */

import type { StateSnapshot } from "@eta/client-wire-proto";
import type {
  Plugin,
  PluginContext,
  SessionEnvironments,
  WireApi,
} from "@eta/plugin-sdk";
import type { SshTarget, SshTransport } from "@eta/ssh";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SshCommandTransport, SshEnvironment } from "@eta/ssh";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const SSH_ACTIONS = [
  "targets",
  "save",
  "delete",
  "connect",
  "forget",
] as const;

/** One remembered target: where to connect, and what the session using it works in. */
export interface SshTargetRecord {
  /** The name a client uses: `box`, `build-server`. */
  id: string;
  /** The host, as OpenSSH would take it. */
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** Where sessions on this machine start; defaults to the remote home. */
  cwd?: string;
  /**
   * The host key fingerprint that was accepted for this target. Present once a connection has
   * been made; a *different* one later is a changed host, and is refused.
   */
  fingerprint?: string;
  lastConnectedAt?: string;
}

/** How a session names the target it runs on. */
export interface SshSessionBinding {
  session: string;
  target: string;
}

export interface SshPluginOptions {
  /** Where targets are remembered. Conventionally `<dataDir>/ssh.json`. */
  path: string;
  /** The transport factory, injectable so a test can run "remote" commands locally. */
  transportFor?: ((target: SshTarget) => Promise<SshTransport>) | undefined;
  /** Diagnostics. */
  warn?: ((message: string) => void) | undefined;
}

/** What the manager needs from this plugin: the environment for one session. */
export interface SshEnvironments
  extends SessionEnvironments<{ env: SshEnvironment; memoryFs: undefined }> {
  for: (
    session: string,
  ) => Promise<{ env: SshEnvironment; memoryFs: undefined } | undefined>;
}

export interface SshPlugin extends Plugin {
  /** Bind a session before resolving its environment. */
  bind: (session: string, targetId: string) => void;
  environments: SshEnvironments;
}

/**
 * Build the plugin.
 *
 * The returned object is the cordis plugin *and* the two seams a host wires: `bind` (which session
 * is on which machine) and `environments` (the `envFor` the manager asks). Doing it here rather
 * than in the assembly is what makes the plugin self-contained — a host that wants remote sessions
 * mounts this plugin, hands it the session-to-target binding, and passes `environments` to the
 * manager.
 */
export function sshPlugin(options: SshPluginOptions): SshPlugin {
  /** The targets as remembered, keyed by id. */
  const targets = new Map<string, SshTargetRecord>();
  /** Which session is on which target. */
  const bindings = new Map<string, string>();
  /** One connection per target, reused: a session's tools should not pay for a handshake each. */
  const connections = new Map<string, Promise<SshTransport>>();
  let loaded = false;
  let wire: WireApi | undefined;

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(options.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const record = entry as SshTargetRecord;
          if (typeof record?.id === "string" && typeof record.host === "string")
            targets.set(record.id, record);
        }
      }
    } catch {
      // A missing or unreadable file means "no targets yet"; the plugin is not the place to
      // refuse service over a file it can rewrite.
    }
  };

  const persist = async (): Promise<void> => {
    const raw = `${JSON.stringify([...targets.values()], null, "\t")}\n`;
    const temporary = `${options.path}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(dirname(options.path), { recursive: true });
      // `0o600`: the file names hosts, users and key paths. Not secrets, but not a directory
      // listing either.
      await writeFile(temporary, raw, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, options.path);
    } finally {
      await rm(temporary, { force: true });
    }
  };

  const section = (): StateSnapshot => {
    const entries = [...targets.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    return {
      sections: { targets: entries },
      revisions: {
        targets: entries
          .map(
            (entry) => `${entry.id}:${entry.host}:${entry.fingerprint ?? ""}`,
          )
          .join("|"),
      },
    };
  };

  /** The connection for one target, opened once and reused. */
  const connect = async (targetId: string): Promise<SshTransport> => {
    await load();
    const record = targets.get(targetId);
    if (record === undefined)
      throw new Error(`no such ssh target: ${targetId}`);
    const existing = connections.get(targetId);
    if (existing !== undefined) return await existing;
    const opening = (async () => {
      const target: SshTarget = {
        host: record.host,
        ...(record.user === undefined ? {} : { user: record.user }),
        ...(record.port === undefined ? {} : { port: record.port }),
        ...(record.identityFile === undefined
          ? {}
          : { identityFile: record.identityFile }),
      };
      const transport =
        options.transportFor === undefined
          ? await SshCommandTransport.connect({
              target,
              // The fingerprint accepted for this target last time. A different one is a
              // changed host, and the transport refuses it rather than trusting a prompt.
              ...(record.fingerprint === undefined
                ? {}
                : { expectedFingerprint: record.fingerprint }),
              warn: options.warn,
            })
          : await options.transportFor(target);
      // Remember what was accepted, so a later change is *detectable*.
      const accepted = (transport as { expectedFingerprint?: string })
        .expectedFingerprint;
      if (accepted !== undefined && accepted !== record.fingerprint) {
        record.fingerprint = accepted;
        record.lastConnectedAt = new Date().toISOString();
        await persist();
        wire?.pushNow("ssh");
      }
      return transport;
    })();
    connections.set(targetId, opening);
    // A failed connection must not be remembered as one: the next attempt tries again.
    opening.catch(() => connections.delete(targetId));
    return await opening;
  };

  return {
    name: "ssh",
    inject: ["wire"],
    bind(session, targetId) {
      bindings.set(session, targetId);
    },
    environments: {
      async for(session) {
        const targetId = bindings.get(session);
        if (targetId === undefined) return undefined;
        const record = targets.get(targetId);
        const transport = await connect(targetId);
        const env = new SshEnvironment({
          transport,
          // Where the session's tools start: the target's own directory, or the remote home.
          ...(record?.cwd === undefined ? {} : { cwd: record.cwd }),
          warn: options.warn,
        });
        // The environment reads and writes memory through the *remote* filesystem, because
        // that is the machine the project is on.
        return { env, memoryFs: undefined };
      },
    },
    apply(context: PluginContext): unknown {
      let active = true;
      wire = context.wire;
      void load().then(
        () => {
          if (active) context.wire.pushNow("ssh");
        },
        (error: unknown) =>
          options.warn?.(
            `[eta-ssh] could not read ${options.path}: ${String(error)}`,
          ),
      );

      return context.effect(() => {
        const registrations: (() => void)[] = [
          context.wire.stateOf("ssh", { project: section, eager: true }),
          context.wire.handle("ssh", "targets", async () => {
            await load();
            return { result: { targets: [...targets.values()] } };
          }),
          context.wire.handle("ssh", "save", async (call) => {
            await load();
            const { target } = (call.args ?? {}) as {
              target?: Partial<SshTargetRecord>;
            };
            if (target?.id === undefined || target.host === undefined) {
              throw new Error("ssh.save needs a target with an id and a host");
            }
            const previous = targets.get(target.id);
            targets.set(target.id, {
              ...previous,
              ...target,
              id: target.id,
              host: target.host,
              // A target that points somewhere else is a different host: the fingerprint
              // that was accepted for the old one must not be trusted for the new one.
              ...(previous !== undefined && previous.host !== target.host
                ? { fingerprint: undefined }
                : {}),
            });
            await persist();
            wire?.pushNow("ssh");
            return { result: { target: targets.get(target.id) } };
          }),
          context.wire.handle("ssh", "delete", async (call) => {
            await load();
            const { id } = (call.args ?? {}) as { id?: string };
            if (id === undefined) throw new Error("ssh.delete needs an id");
            await connections.get(id)?.then(
              (transport) => transport.close(),
              () => undefined,
            );
            connections.delete(id);
            const removed = targets.delete(id);
            for (const [session, targetId] of bindings)
              if (targetId === id) bindings.delete(session);
            if (removed) {
              await persist();
              wire?.pushNow("ssh");
            }
            return { result: { removed } };
          }),
          context.wire.handle("ssh", "connect", async (call) => {
            const { id } = (call.args ?? {}) as { id?: string };
            if (id === undefined) throw new Error("ssh.connect needs an id");
            // Reaching the machine is the answer: whether it worked, and which key it
            // presented. A connection that fails is an error, not a false success.
            const transport = await connect(id);
            return {
              result: {
                home: transport.home,
                fingerprint: targets.get(id)?.fingerprint ?? null,
              },
            };
          }),
          context.wire.handle("ssh", "forget", async (call) => {
            const { id } = (call.args ?? {}) as { id?: string };
            if (id === undefined) throw new Error("ssh.forget needs an id");
            // Drop the remembered fingerprint: the next connection establishes trust again.
            const record = targets.get(id);
            if (record === undefined)
              throw new Error(`no such ssh target: ${id}`);
            record.fingerprint = undefined;
            await persist();
            wire?.pushNow("ssh");
            return { result: { target: record } };
          }),
        ];
        return async () => {
          active = false;
          wire = undefined;
          for (const off of registrations.splice(0)) off();
          const pending = [...connections.values()];
          connections.clear();
          await Promise.all(
            pending.map((opening) =>
              opening.then(
                (transport) => transport.close(),
                () => undefined,
              ),
            ),
          );
        };
      });
    },
  };
}

/** Where the plugin remembers its targets. */
export function sshTargetsPath(dataDir: string): string {
  return join(dataDir, "ssh.json");
}
