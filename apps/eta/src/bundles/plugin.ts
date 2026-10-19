/**
 * The `bundles` plugin: the settings page's view of bundles, and the calls that change them.
 *
 * One section, `list`, made from the registry, the sealed values (only whether each is set, and
 * the value itself of a field that is not a secret) and the readiness of each machine. Writes are
 * `configure` (values; `null` clears), `add` / `refresh` / `remove` for bundles from git, and
 * `recheck`. A secret goes in and is never read back, by this plugin or any other.
 */
import type { BundleView } from "@eta/client-contracts";
import type { MachineHub } from "../machines/hub";
import type { MachineStore } from "../machines/store";
import type { BundleEntry, BundleRegistry } from "./registry";
import type { BundleRows } from "./rows";
import type { BundleServices } from "./service";
import { BundleError, checkValue, isConfigured } from "@eta/daemon";
import { Args, productPlugin, publish } from "../wire";

export interface BundlesDeps {
  registry: BundleRegistry;
  rows: BundleRows;
  services: BundleServices;
  readiness: Readiness;
}

/** Which of the commands bundles require each machine has, as last looked at. */
export class Readiness {
  readonly #machines: MachineStore;
  readonly #hub: MachineHub;
  readonly #registry: BundleRegistry;
  readonly #has: (command: string) => boolean;
  readonly #changed: () => void;
  readonly #warn: (message: string) => void;
  /** What a daemon has, by machine, of the commands asked about. */
  readonly #found = new Map<string, Set<string>>();
  #running: Promise<void> | undefined;
  #again = false;

  constructor(options: {
    machines: MachineStore;
    hub: MachineHub;
    registry: BundleRegistry;
    has: (command: string) => boolean;
    changed: () => void;
    warn: (message: string) => void;
  }) {
    this.#machines = options.machines;
    this.#hub = options.hub;
    this.#registry = options.registry;
    this.#has = options.has;
    this.#changed = options.changed;
    this.#warn = options.warn;
  }

  /** Every command some bundle requires. */
  #commands(): string[] {
    return [
      ...new Set(
        this.#registry
          .entries()
          .flatMap((entry) => entry.bundle?.manifest.requires ?? []),
      ),
    ].sort();
  }

  /** Ask every machine that can be asked. Calls that overlap are one more pass, not many. */
  check(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        const commands = this.#commands();
        await Promise.all(
          this.#machines
            .list()
            .filter((machine) => machine.kind === "daemon")
            .map(async (machine) => {
              const link = this.#hub.link(machine.id);
              if (link === undefined || commands.length === 0) return;
              try {
                const { found } = await link.machine(
                  "which",
                  { commands },
                  { timeoutMs: 10_000 },
                );
                this.#found.set(machine.id, new Set(found));
              } catch (error) {
                this.#warn(
                  `[eta] could not ask ${machine.name} for commands: ${String(error)}`,
                );
              }
            }),
        );
        this.#changed();
      } while (this.#again);
    })().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** The machines a bundle that requires these commands can be judged on. */
  statuses(requires: readonly string[]): BundleView["machines"] {
    const statuses: BundleView["machines"] = [];
    for (const machine of this.#machines.list()) {
      if (machine.kind === "ssh" || machine.status === "revoked") continue;
      if (machine.kind === "primary") {
        const missing = requires.filter((command) => !this.#has(command));
        statuses.push({
          machineId: machine.id,
          name: machine.name,
          ready: missing.length === 0,
          missing,
          checked: true,
        });
        continue;
      }
      const found = this.#found.get(machine.id);
      const online = machine.status === "online" && found !== undefined;
      const missing = online
        ? requires.filter((command) => !found.has(command))
        : [];
      statuses.push({
        machineId: machine.id,
        name: machine.name,
        ready: online && missing.length === 0,
        missing,
        checked: online,
      });
    }
    return statuses;
  }
}

function viewOf(entry: BundleEntry, deps: BundlesDeps): BundleView {
  const { bundle } = entry;
  const saved = deps.rows.config(entry.name);
  const manifest = bundle?.manifest;
  const requires = manifest?.requires ?? [];
  const fields = (manifest?.config ?? []).map((field) => {
    const value = saved[field.name] ?? "";
    return {
      name: field.name,
      title: field.title,
      description: field.description,
      secret: field.secret,
      required: field.required,
      maxLength: field.maxLength,
      set: value !== "",
      // A secret has no value to show; the others are shown so they can be edited.
      value: field.secret || value === "" ? null : value,
    };
  });
  return {
    name: entry.name,
    description: manifest?.description ?? "",
    source: entry.source,
    sha: entry.sha,
    requires,
    skills: bundle?.skills ?? [],
    mcpServers: Object.keys(bundle?.mcp ?? {}),
    hooks: bundle?.hooks !== undefined,
    fields,
    configured: manifest === undefined ? false : isConfigured(manifest, saved),
    service:
      manifest?.service === undefined
        ? null
        : (deps.services.state(entry.name) ?? {
            state: "stopped",
            message: null,
          }),
    machines: bundle === undefined ? [] : deps.readiness.statuses(requires),
    problem: entry.problem,
  };
}

export function bundlesPlugin(
  deps: BundlesDeps & { changed: () => void },
  applied: () => void,
) {
  const { registry, rows } = deps;

  const configure = (name: string, values: Record<string, unknown>): void => {
    const entry = registry.get(name);
    if (entry?.bundle === undefined) throw new Error(`no bundle ${name}`);
    const fields = entry.bundle.manifest.config;
    const next = { ...rows.config(name) };
    const bad: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find((item) => item.name === key);
      if (field === undefined) {
        bad.push(key);
        continue;
      }
      if (value === null || value === "") {
        delete next[key];
        continue;
      }
      if (typeof value !== "string") {
        bad.push(key);
        continue;
      }
      try {
        checkValue(field, value);
      } catch (error) {
        // The message names the field and the rule, never the value.
        if (!(error instanceof BundleError)) throw error;
        bad.push(key);
        continue;
      }
      next[key] = value;
    }
    if (bad.length > 0) throw new Error(`not accepted: ${bad.join(", ")}`);
    rows.setConfig(name, next);
  };

  return productPlugin(
    "bundles",
    ({ wire }) => {
      const offs = [
        publish(wire, "bundles", {
          list: () => registry.entries().map((entry) => viewOf(entry, deps)),
        }),

        wire.handle("bundles", "configure", async (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const raw = (call.args as { values?: unknown }).values;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new TypeError("bundles.configure needs values");
          configure(name, raw as Record<string, unknown>);
          deps.changed();
          await deps.services.sync();
          return { result: { name } };
        }),

        wire.handle("bundles", "add", async (call) => {
          const args = new Args(call);
          const name = await registry.add({
            repo: args.string("repo"),
            rev: args.optionalString("rev") ?? "HEAD",
            path: args.optionalString("path") ?? "",
          });
          void deps.readiness.check();
          void deps.services.sync();
          return { result: { name } };
        }),

        wire.handle("bundles", "remove", async (call) => {
          const name = new Args(call).string("name");
          await registry.removeSource(name);
          void deps.services.sync();
          return { result: { name } };
        }),

        wire.handle("bundles", "refresh", async (call) => {
          const names = await registry.refresh(
            new Args(call).optionalString("name"),
          );
          void deps.readiness.check();
          void deps.services.sync();
          return { result: { names } };
        }),

        wire.handle("bundles", "recheck", async () => {
          await deps.readiness.check();
          await deps.services.sync();
          return { result: {} };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
