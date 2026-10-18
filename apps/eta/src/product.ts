import type { AssembledServer, WireService } from "@eta/server";
/**
 * The product: the stores, the engine, and the plugins that put them on the wire.
 *
 * It is made before the server (the engine's hooks are options of `assembleServer`) and mounted
 * on it afterwards: the plugins need the server's wire and its session host, which only exist
 * then. Between the two, the replies a dead process left in flight are failed, so nothing a client
 * is ever shown says `working` without something working.
 */
import type { Database } from "bun:sqlite";
import type { SessionHooks } from "./session-hooks";
import { homedir, hostname, platform } from "node:os";
import { agentsPlugin } from "./agents/plugin";
import { AgentStore } from "./agents/store";
import { Engine, RESTART_TEXT } from "./conversations/engine";
import { conversationsPlugin } from "./conversations/plugin";
import { ConversationStore } from "./conversations/store";
import { ConversationTargets } from "./conversations/targets";
import { Timeline } from "./conversations/timeline";
import { Inbox } from "./inbox/inbox";
import { inboxPlugin } from "./inbox/plugin";
import { SettingStore } from "./inbox/setting";
import { InteractionStore } from "./inbox/store";
import { machinesPlugin } from "./machines/plugin";
import { MachineStore } from "./machines/store";
import { MemoryClient } from "./memory/client";
import { memoryRunHooks, memoryTools } from "./memory/hooks";
import { memoryPlugin } from "./memory/plugin";
import { projectsPlugin } from "./projects/plugin";
import { ProjectStore } from "./projects/store";
import { combineSessionHooks } from "./session-hooks";
import { usagePlugin } from "./usage/plugin";
import { UsageStore } from "./usage/store";

export interface Product {
  readonly engine: Engine;
  /** Every feature's per-session hooks, combined into the one set the session manager takes. */
  readonly sessionHooks: Required<SessionHooks>;
  /** Mount the plugins on an assembled server; resolves when every one of them is in place. */
  mount: (server: AssembledServer) => Promise<void>;
}

/** The plugins are applied a moment after they are mounted; this is how long to wait for that. */
const MOUNT_TIMEOUT_MS = 10_000;

export function createProduct(options: {
  db: Database;
  dataDir: string;
  /** The memory sidecar's address. Without one there is no memory: no plugin, no tools, no calls. */
  memoryUrl?: string | undefined;
  warn: (message: string) => void;
}): Product {
  const { db, dataDir, warn } = options;
  const memory =
    options.memoryUrl === undefined || options.memoryUrl === ""
      ? undefined
      : new MemoryClient(options.memoryUrl);
  const agents = new AgentStore(db);
  const machines = new MachineStore(db);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const timeline = new Timeline(db);
  let wire: WireService | undefined;

  // This computer is a machine like any other, and the first thing a project can name.
  machines.ensurePrimary({ name: hostname(), home: homedir(), os: platform() });
  // Nothing is running yet, so whatever the last process left in flight cannot be, and no
  // question it asked can still be answered.
  timeline.failInterrupted(RESTART_TEXT);
  const interactions = new InteractionStore(db);
  interactions.expirePending();
  // Usage is kept for 30 days; what is older goes now, and again once a day while the host runs.
  const usage = new UsageStore(db);
  usage.prune();

  /** Say that product state moved, to whoever is looking at it. */
  const changed = (touched?: readonly string[] | "all"): void => {
    if (wire === undefined) return;
    for (const target of ["agents", "machines", "projects", "conversations"])
      wire.pushNow(target);
    const ids =
      touched === "all"
        ? conversations.list().map((c) => c.id)
        : (touched ?? []);
    for (const id of ids) wire.pushNow(`conversations.${id}`);
  };

  const targets = new ConversationTargets({
    conversations,
    projects,
    timeline,
  });
  const created = (id: string): void => targets.add(id);
  const inbox = new Inbox({
    interactions,
    settings: new SettingStore(db),
    timeline,
    changed: () => wire?.pushNow("inbox"),
    warn,
  });
  const engine = new Engine({
    db,
    agents,
    machines,
    projects,
    conversations,
    timeline,
    changed,
    warn,
    ...(memory === undefined ? {} : { runHooks: memoryRunHooks(memory) }),
  });

  // Each feature that adds tools, tool middleware or a question observer to sessions is one entry
  // here; the order is the order its tools and middleware are installed in.
  const sessionHooks = combineSessionHooks([
    {
      sessionTools: engine.sessionTools,
      askObserve: engine.askObserve,
    },
    { toolMiddleware: inbox.toolMiddleware, askObserve: inbox.askObserve },
    ...(memory === undefined
      ? []
      : [{ sessionTools: memoryTools.bind(undefined, memory) }]),
  ]);

  return {
    engine,
    sessionHooks,
    async mount(server) {
      wire = server.wire;
      const pending = new Set([
        "agents",
        "machines",
        "projects",
        "conversations",
        "inbox",
        "usage",
        ...(memory === undefined ? [] : ["memory"]),
      ]);
      let ready!: () => void;
      const everyone = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const applied = (name: string) => () => {
        pending.delete(name);
        if (pending.size === 0) ready();
      };
      const shared = { agents, machines, projects, conversations, timeline };
      server.mount(
        "agents",
        agentsPlugin(
          { ...shared, dataDir, db, engine, changed, created },
          applied("agents"),
        ),
      );
      server.mount(
        "machines",
        machinesPlugin({ machines, changed }, applied("machines")),
      );
      server.mount(
        "projects",
        projectsPlugin({ ...shared, changed }, applied("projects")),
      );
      server.mount(
        "conversations",
        conversationsPlugin(
          { ...shared, engine, targets, changed, created },
          applied("conversations"),
        ),
      );
      server.mount("inbox", inboxPlugin({ inbox }, applied("inbox")));
      server.mount("usage", usagePlugin({ usage, warn }, applied("usage")));
      if (memory !== undefined)
        server.mount(
          "memory",
          memoryPlugin({ client: memory }, applied("memory")),
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the product plugins did not start: ${[...pending].join(", ")}`,
              ),
            ),
          MOUNT_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([everyone, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
