/**
 * A remote session on the primary's own wire.
 *
 * A browser watches a session by subscribing to `sessions.<id>`, and it should not need to know
 * which machine the session runs on. So for each session that lives on a daemon the primary
 * registers that same target and fills it from the daemon: while somebody is subscribed here, the
 * primary is subscribed there, and the daemon's state (whole, then patches) and events are
 * republished as the primary's own.
 *
 * It is warm only while someone is looking. Whether anyone is, is read from the wire's own
 * watcher list: a mirror notices on the next frame from the daemon that nobody is left, and
 * unsubscribes there. A link that drops cools every mirror on it; one that comes back warms the
 * ones somebody is still watching.
 */
import type { StatePatch, StateSnapshot } from "@eta/client-wire-proto";
import type { WireService } from "@eta/server";
import type { MachineHub, MachineLink } from "./hub";

interface Mirror {
  readonly machineId: string;
  readonly target: string;
  snapshot: StateSnapshot | undefined;
  off: () => void;
  warm: boolean;
}

export class SessionMirrors {
  readonly #hub: MachineHub;
  readonly #mirrors = new Map<string, Mirror>();
  #wire: WireService | undefined;
  #stops: (() => void)[] = [];

  constructor(hub: MachineHub) {
    this.#hub = hub;
  }

  /** The wire is up: from here on mirrors can be registered, and a link coming up warms them. */
  attach(
    wire: WireService,
    known: () => { session: string; machineId: string }[],
  ): void {
    this.#wire = wire;
    for (const { session, machineId } of known())
      this.register(session, machineId);
    this.#stops.push(
      this.#hub.onReady((link) => {
        for (const mirror of this.#mirrors.values()) {
          if (mirror.machineId === link.machineId && this.#watched(mirror))
            this.#warm(mirror, link);
        }
      }),
      this.#hub.onLost((machineId) => {
        for (const mirror of this.#mirrors.values())
          if (mirror.machineId === machineId) mirror.warm = false;
      }),
    );
  }

  detach(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const mirror of this.#mirrors.values()) mirror.off();
    this.#mirrors.clear();
    this.#wire = undefined;
  }

  /** Put the session's target on the primary's wire. Once; asking again changes nothing. */
  register(session: string, machineId: string): void {
    const wire = this.#wire;
    if (wire === undefined || this.#mirrors.has(session)) return;
    const mirror: Mirror = {
      machineId,
      target: `sessions.${session}`,
      snapshot: undefined,
      off: () => undefined,
      warm: false,
    };
    mirror.off = wire.stateOf(mirror.target, {
      project: () => {
        // Asked when somebody subscribes (and on a resync): that is the moment to start
        // listening, and what they are owed until the daemon answers is what was last known.
        const link = this.#hub.link(machineId);
        if (link !== undefined && !mirror.warm) this.#warm(mirror, link);
        return mirror.snapshot ?? { sections: {}, revisions: {} };
      },
    });
    this.#mirrors.set(session, mirror);
  }

  #watched(mirror: Mirror): boolean {
    return (this.#wire?.state.watchersOf(mirror.target).length ?? 0) > 0;
  }

  #warm(mirror: Mirror, link: MachineLink): void {
    const wire = this.#wire;
    if (wire === undefined || mirror.warm) return;
    mirror.warm = true;
    link.pipe.subscribe(mirror.target, {
      state: (frame) => {
        mirror.snapshot = frame.snapshot ?? merge(mirror.snapshot, frame.patch);
        if (!this.#watched(mirror)) {
          // Nobody here is looking any more: stop paying for it there.
          link.pipe.unsubscribe(mirror.target);
          mirror.warm = false;
          return;
        }
        // Run traffic, paced by the wire like a local session's.
        wire.push(mirror.target);
      },
      event: (name, data) => wire.event(mirror.target, name, data),
    });
  }
}

/** A patch laid over the state it patches; what the patch's revisions do not name is gone. */
function merge(
  previous: StateSnapshot | undefined,
  patch: StatePatch | undefined,
): StateSnapshot | undefined {
  if (patch === undefined) return previous;
  const sections: Record<string, unknown> = {};
  for (const name of Object.keys(patch.revisions)) {
    sections[name] =
      name in patch.sections ? patch.sections[name] : previous?.sections[name];
  }
  return { sections, revisions: patch.revisions };
}
