/**
 * The `places` plugin: choosing a directory on a machine, for the web, the phone and the terminal
 * alike.
 *
 * Every action names a machine and is answered there (`MachinePlaces`); the host adds what only
 * it knows: which directories are projects, which were used lately, and where the last clone on
 * the machine went. `places` is a target of its own: `recent` (used lately and the projects, by
 * machine) and `clones` (the ones running and the ones that just ended).
 */
import type {
  CloneView,
  PlaceCapabilities,
  PlaceEntry,
  PlaceRef,
  RecentPlace,
} from "@eta/client-contracts";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { MachinePlaces } from "./on-machine";
import type { PlaceStore } from "./store";
import { repoName } from "@eta/client-contracts";
import { PlaceError } from "@eta/places";
import { Args, productPlugin, publish } from "../wire";
import { RECENT_PER_MACHINE } from "./store";

/**
 * Where a clone goes the first time on a machine: its `~/Developer`, or its home when there is
 * none. After that, wherever the last clone on that machine went.
 */
const DEFAULT_CLONE_PARENT = "~/Developer";

/** How long an ended clone stays in `clones`, for a client that looks a moment later. */
const ENDED_KEPT_MS = 10 * 60 * 1000;

export interface PlacesDeps {
  machines: MachineStore;
  projects: ProjectStore;
  places: PlaceStore;
  onMachine: MachinePlaces;
  changed: () => void;
  now?: () => number;
}

interface Running {
  view: CloneView;
  stop: AbortController;
}

export function placesPlugin(deps: PlacesDeps, applied: () => void) {
  const { machines, projects, places, onMachine } = deps;
  const now = deps.now ?? Date.now;
  const clones = new Map<string, Running>();

  const machineOf = (args: Args): MachineRecord => {
    const id = args.optionalString("machineId") ?? machines.primary()?.id;
    const machine = id === undefined ? undefined : machines.get(id);
    if (machine === undefined) throw new Error("no such machine");
    return machine;
  };

  /** Which project a path on a machine is, by the machine's own idea of equal paths. */
  const projectsOn = (machine: MachineRecord) => {
    const fold = onMachine.rules(machine).flavor === "win32";
    const key = (path: string) => (fold ? path.toLowerCase() : path);
    const byPath = new Map(
      projects
        .list()
        .filter(
          (project) => project.machineId === machine.id && !project.archived,
        )
        .map((project) => [key(project.path), project.id]),
    );
    return (path: string): string | null => byPath.get(key(path)) ?? null;
  };

  const recent = (): RecentPlace[] => {
    const out: RecentPlace[] = [];
    const rows = places.recent();
    for (const machine of machines.list()) {
      const rules = onMachine.rules(machine);
      const projectAt = projectsOn(machine);
      const seen = new Set<string>();
      const mine: RecentPlace[] = [];
      const parentOf = (path: string): PlaceRef | null => {
        const parent = rules.parent(path);
        return parent === null
          ? null
          : { path: parent, display: rules.display(parent) };
      };
      for (const row of rows) {
        if (row.machineId !== machine.id || seen.has(row.path)) continue;
        seen.add(row.path);
        mine.push({
          machineId: machine.id,
          path: row.path,
          display: rules.display(row.path),
          projectId: projectAt(row.path),
          parent: parentOf(row.path),
          usedAt: row.usedAt,
        });
      }
      // The projects never used from a picker still are places to go back to.
      for (const project of projects.list()) {
        if (
          project.machineId !== machine.id ||
          project.archived ||
          project.kind !== "project" ||
          seen.has(project.path)
        )
          continue;
        seen.add(project.path);
        mine.push({
          machineId: machine.id,
          path: project.path,
          display: rules.display(project.path),
          projectId: project.id,
          parent: parentOf(project.path),
          usedAt: project.updatedAt,
        });
      }
      mine.sort((a, b) => b.usedAt - a.usedAt);
      out.push(...mine.slice(0, RECENT_PER_MACHINE * 2));
    }
    return out;
  };

  const cloneViews = (): CloneView[] => {
    const cutoff = now() - ENDED_KEPT_MS;
    for (const [id, running] of clones)
      if (running.view.endedAt !== null && running.view.endedAt < cutoff)
        clones.delete(id);
    return [...clones.values()].map((running) => running.view);
  };

  /** Where a clone on this machine goes unless told otherwise: checked to be there now. */
  const cloneParent = async (machine: MachineRecord): Promise<PlaceRef> => {
    for (const candidate of [
      places.cloneParent(machine.id),
      DEFAULT_CLONE_PARENT,
      "~",
    ]) {
      if (candidate === undefined) continue;
      const found = await onMachine
        .ask(machine, { op: "resolve", path: candidate })
        .catch(() => undefined);
      if (found?.directory === true)
        return { path: found.path, display: found.display };
    }
    throw new PlaceError("not_found");
  };

  const update = (id: string, patch: Partial<CloneView>) => {
    const running = clones.get(id);
    if (running === undefined) return;
    running.view = { ...running.view, ...patch };
    deps.changed();
  };

  return productPlugin(
    "places",
    ({ wire }) => {
      const handle = (
        action: string,
        run: (
          args: Args,
          raw: Record<string, unknown>,
        ) => Promise<unknown> | unknown,
      ) =>
        wire.handle("places", action, async (call) => ({
          result: await run(
            new Args(call),
            typeof call.args === "object" && call.args !== null
              ? (call.args as Record<string, unknown>)
              : {},
          ),
        }));

      const withProjects = <
        T extends { path: string; projectId: string | null },
      >(
        machine: MachineRecord,
        items: T[],
      ): T[] => {
        const projectAt = projectsOn(machine);
        return items.map((item) => ({
          ...item,
          projectId: projectAt(item.path),
        }));
      };

      const offs = [
        publish(wire, "places", { recent, clones: cloneViews }),

        handle("capabilities", async (args): Promise<PlaceCapabilities> => {
          const machine = machineOf(args);
          const capabilities = await onMachine.ask(machine, {
            op: "capabilities",
          });
          return { ...capabilities, cloneParent: await cloneParent(machine) };
        }),

        handle(
          "resolve",
          async (args) =>
            await onMachine.ask(machineOf(args), {
              op: "resolve",
              path: args.string("path"),
            }),
        ),

        handle("list", async (args) => {
          const machine = machineOf(args);
          const path = args.optionalString("path");
          const listing = await onMachine.ask(machine, {
            op: "list",
            ...(path === undefined ? {} : { path }),
          });
          return {
            ...listing,
            entries: withProjects<PlaceEntry>(machine, listing.entries),
          };
        }),

        handle("search", async (args) => {
          const machine = machineOf(args);
          const limit = args.optionalInteger("limit");
          const found = await onMachine.ask(machine, {
            op: "search",
            query: args.string("query"),
            ...(limit === undefined ? {} : { limit }),
          });
          return { ...found, matches: withProjects(machine, found.matches) };
        }),

        handle(
          "mkdir",
          async (args) =>
            await onMachine.ask(machineOf(args), {
              op: "mkdir",
              parent: args.string("parent"),
              name: args.string("name"),
            }),
        ),

        handle(
          "repos",
          async (args) =>
            await onMachine.ask(machineOf(args), {
              op: "repos",
              query: args.optionalString("query") ?? "",
            }),
        ),

        handle("clone", async (args) => {
          const machine = machineOf(args);
          const url = args.string("url");
          const protocol = args.optionalString("protocol");
          if (
            protocol !== undefined &&
            protocol !== "https" &&
            protocol !== "ssh"
          )
            throw new Error("protocol is https or ssh");
          const parent = await onMachine.directory(
            machine,
            args.string("parent"),
          );
          const name = (args.optionalString("name") ?? repoName(url)).trim();
          const rules = onMachine.rules(machine);
          if (!rules.validName(name)) throw new PlaceError("invalid");
          const target = rules.join(parent, name);
          const id = crypto.randomUUID();
          const stop = new AbortController();
          const view: CloneView = {
            id,
            machineId: machine.id,
            repo: url,
            target: { path: target, display: rules.display(target) },
            status: "running",
            progress: null,
            failure: null,
            startedAt: now(),
            endedAt: null,
          };
          clones.set(id, { view, stop });
          deps.changed();
          void onMachine
            .ask(
              machine,
              {
                op: "clone",
                url,
                ...(protocol === undefined ? {} : { protocol }),
                target,
              },
              {
                signal: stop.signal,
                onEvent: (event) => {
                  const progress = event as CloneView["progress"];
                  if (progress !== null && typeof progress?.phase === "string")
                    update(id, { progress });
                },
              },
            )
            .then(
              (done) => {
                places.setCloneParent(machine.id, parent);
                places.remember(machine.id, done.path);
                update(id, { status: "done", target: done, endedAt: now() });
              },
              (error: unknown) => {
                const failure =
                  error instanceof PlaceError
                    ? error.failure
                    : { code: "other" as const, detail: String(error) };
                update(id, {
                  status: failure.code === "cancelled" ? "cancelled" : "failed",
                  failure,
                  endedAt: now(),
                });
              },
            );
          return { clone: view };
        }),

        handle("cancelClone", (args) => {
          const running = clones.get(args.string("cloneId"));
          if (running === undefined || running.view.status !== "running")
            return { cancelled: false };
          running.stop.abort();
          return { cancelled: true };
        }),

        handle("remember", (args) => {
          const machine = machineOf(args);
          const resolved = onMachine
            .rules(machine)
            .resolve(args.string("path"));
          if (!resolved.ok) throw new PlaceError(resolved.failure.code);
          places.remember(machine.id, resolved.path);
          deps.changed();
          return {};
        }),

        handle("importRecent", (_args, call) => {
          const raw = call.recent;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            throw new Error(
              "places.importRecent needs recent: { machineId: paths }",
            );
          let added = 0;
          for (const [machineId, paths] of Object.entries(raw)) {
            const machine = machines.get(machineId);
            if (machine === undefined || !Array.isArray(paths)) continue;
            const rules = onMachine.rules(machine);
            const valid = paths.flatMap((path: unknown) => {
              if (typeof path !== "string") return [];
              const resolved = rules.resolve(path);
              return resolved.ok ? [resolved.path] : [];
            });
            added += places.import(machine.id, valid);
          }
          if (added > 0) deps.changed();
          return { added };
        }),
      ];
      return () => {
        for (const running of clones.values()) running.stop.abort();
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
