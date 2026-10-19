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
 *
 * A mirror that warms again is shown the daemon's event ring from its start. Events carry the
 * time they happened (strictly increasing per target), and the mirror republishes only what is
 * later than the last one it republished, so a browser does not see the same event twice.
 *
 * The other thing mirrored is the daemon's list of sessions, followed for as long as its link is
 * up, so that the primary's global `sessions` list has the daemons' sessions in it too.
 */
import type { SidebarSession } from "@eta/client-contracts";
import type { StatePatch, StateSnapshot } from "@eta/client-wire-proto";
import type { WireService } from "@eta/server";
import type { MachineHub, MachineLink } from "./hub";

interface Mirror {
  readonly machineId: string;
  readonly target: string;
  snapshot: StateSnapshot | undefined;
  off: () => void;
  warm: boolean;
  /** The time of the newest event republished; what the daemon replays up to it was heard. */
  lastAt: number;
}

/** A daemon's own session list as last sent, and whether the daemon is reachable. */
interface Followed {
  snapshot: StateSnapshot | undefined;
  online: boolean;
}

export class SessionMirrors {
  readonly #hub: MachineHub;
  readonly #nameOf: (machineId: string) => string | undefined;
  readonly #mirrors = new Map<string, Mirror>();
  readonly #followed = new Map<string, Followed>();
  #wire: WireService | undefined;
  #stops: (() => void)[] = [];

  constructor(
    hub: MachineHub,
    nameOf: (machineId: string) => string | undefined = () => undefined,
  ) {
    this.#hub = hub;
    this.#nameOf = nameOf;
  }

  /**
   * The daemons' sessions, as rows of the primary's session list. A daemon that is out of reach
   * keeps its last rows, marked `offline`: the sessions are still there, only unreachable.
   */
  rows(): SidebarSession[] {
    const rows: SidebarSession[] = [];
    for (const [machineId, followed] of this.#followed) {
      const list = followed.snapshot?.sections.list;
      if (!Array.isArray(list)) continue;
      const machine = this.#nameOf(machineId);
      for (const row of list as SidebarSession[]) {
        rows.push({
          ...row,
          ...(machine === undefined ? {} : { machine }),
          badges: followed.online
            ? row.badges
            : [...row.badges.filter((badge) => badge !== "running"), "offline"],
        });
      }
    }
    return rows;
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
        this.#follow(link);
        for (const mirror of this.#mirrors.values()) {
          if (mirror.machineId === link.machineId && this.#watched(mirror))
            this.#warm(mirror, link);
        }
      }),
      this.#hub.onLost((machineId) => {
        const followed = this.#followed.get(machineId);
        if (followed !== undefined) {
          followed.online = false;
          wire.push("sessions");
        }
        for (const mirror of this.#mirrors.values())
          if (mirror.machineId === machineId) mirror.warm = false;
      }),
    );
  }

  detach(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const mirror of this.#mirrors.values()) mirror.off();
    this.#mirrors.clear();
    this.#followed.clear();
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
      lastAt: 0,
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
      event: (name, data, at) => {
        // The daemon replays its ring to a new subscriber, and most of it was heard before.
        if (at !== undefined) {
          if (at <= mirror.lastAt) return;
          mirror.lastAt = at;
        }
        wire.event(mirror.target, name, data);
      },
    });
  }

  /** Follow the daemon's own session list for as long as its link is up. */
  #follow(link: MachineLink): void {
    const wire = this.#wire;
    if (wire === undefined) return;
    const followed = this.#followed.get(link.machineId) ?? {
      snapshot: undefined,
      online: true,
    };
    followed.online = true;
    this.#followed.set(link.machineId, followed);
    link.pipe.subscribe("sessions", {
      state: (frame) => {
        followed.snapshot =
          frame.snapshot ?? merge(followed.snapshot, frame.patch);
        wire.push("sessions");
      },
      event: () => undefined,
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
