import type {
  AgentResults,
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  MachineView,
} from "@eta/client-contracts";
import { effect, signal } from "nsh";
import { follow, useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { askRuntimes, RUNTIMES_TIMEOUT_MS } from "./status";

/** The primary and every daemon: the primary first, then by name. */
function runtimeMachines(machines: readonly MachineView[]) {
  return machines
    .filter(
      (machine) => machine.kind === "primary" || machine.kind === "daemon",
    )
    .sort(
      (a, b) =>
        Number(b.kind === "primary") - Number(a.kind === "primary") ||
        a.name.localeCompare(b.name),
    );
}

/** A machine that can be asked: the primary always, a daemon while it is online. */
export const reachable = (machine: MachineView) =>
  machine.kind === "primary" || machine.status === "online";

/** What the host is asked for: the primary is the host itself, named by nothing. */
const askedId = (machine: MachineView) =>
  machine.kind === "primary" ? undefined : machine.id;

type Account =
  | { state: "loading" }
  | { state: "ready"; account: AgentRuntimeAccount }
  | { state: "error"; message: string };

const messageOf = (error: unknown) => problemText(error);

/**
 * Every machine's runtimes, from the list the agent editor reads (`agents.runtimes`, one call per
 * machine). A machine is asked once it can be: when settings opens, or when it comes back online.
 */
export function createRuntimeListing() {
  const host = useHost();
  follow(() => "machines");
  /** By machine: undefined while it answers, null when it could not be asked. */
  const lists = signal<Record<string, AgentRuntimeInfo[] | null>>({});
  const probing = signal<Record<string, boolean>>({});
  const errors = signal<Record<string, string | undefined>>({});
  const accounts = signal<Record<string, Account>>({});
  const asked = new Set<string>();
  const machines = () =>
    runtimeMachines(host.list<MachineView>("machines") ?? []);

  function set<T>(
    store: { (): Record<string, T>; set: (next: Record<string, T>) => void },
    id: string,
    value: T,
  ) {
    store.set({ ...store(), [id]: value });
  }
  async function ask(machine: MachineView, fresh: boolean) {
    try {
      set(lists, machine.id, await askRuntimes(host, askedId(machine), fresh));
      if (fresh) set(errors, machine.id, undefined);
    } catch (error) {
      if (fresh) set(errors, machine.id, messageOf(error));
      else set(lists, machine.id, null);
    }
  }
  effect(() => {
    if (!host.can("agents.runtimes")) return;
    for (const machine of machines()) {
      if (!reachable(machine)) {
        asked.delete(machine.id);
        continue;
      }
      if (asked.has(machine.id)) continue;
      asked.add(machine.id);
      void ask(machine, false);
    }
  });

  /** Ask a machine's runtimes again, past the host's cache. */
  async function refresh(machine: MachineView) {
    if (probing()[machine.id]) return;
    set(probing, machine.id, true);
    await ask(machine, true);
    set(probing, machine.id, false);
  }

  const accountKey = (machine: MachineView, runtime: string) =>
    `${machine.id}\n${runtime}`;
  /** A built-in runtime's sign-in and plan usage, asked the first time its row opens. */
  function loadAccount(machine: MachineView, runtime: string) {
    const key = accountKey(machine, runtime);
    if (accounts()[key]) return;
    set<Account>(accounts, key, { state: "loading" });
    const machineId = askedId(machine);
    void host
      .call<AgentResults["runtimeAccount"]>(
        "agents",
        "runtimeAccount",
        machineId === undefined ? { runtime } : { runtime, machineId },
        { timeoutMs: RUNTIMES_TIMEOUT_MS },
      )
      .then(
        (result) =>
          set<Account>(accounts, key, {
            state: "ready",
            account: result.account,
          }),
        (error: unknown) =>
          set<Account>(accounts, key, {
            state: "error",
            message: messageOf(error),
          }),
      );
  }

  /** How many runtimes the machines asked so far can run an agent on. */
  const available = () =>
    Object.values(lists())
      .flatMap((list) => list ?? [])
      .filter((item) => item.status === "available").length;

  return {
    machines,
    runtimes: (machine: MachineView) =>
      machine.id in lists() ? lists()[machine.id] : undefined,
    probing: (machine: MachineView) => probing()[machine.id] ?? false,
    error: (machine: MachineView) => errors()[machine.id],
    refresh,
    loadAccount,
    account: (machine: MachineView, runtime: string) =>
      accounts()[accountKey(machine, runtime)],
    available,
  };
}

export type RuntimeListing = ReturnType<typeof createRuntimeListing>;
