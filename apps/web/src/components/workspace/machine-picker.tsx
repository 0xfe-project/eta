import type { AgentRuntimeInfo, MachineView } from "@eta/client-contracts";
import type { UseFormReturn } from "react-hook-form";
import type { AgentForm } from "./agent-form";
import { useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAgentList, useRuntimesByMachine } from "@/queries/agents";
import { useMachines } from "@/queries/projects";

function MachineRow({
  id,
  name,
  state,
  hint,
  dot,
  checked,
  disabled,
  onSelect,
}: {
  id: string;
  name: string;
  state?: string;
  hint: React.ReactNode;
  dot?: MachineView["status"];
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-2 py-1.5 has-focus-visible:ring-1 has-focus-visible:ring-ring has-focus-visible:ring-inset",
        checked && "bg-muted",
        disabled ? "cursor-not-allowed" : !checked && "hover:bg-muted/50",
      )}
    >
      <input
        type="radio"
        name="agent-machine"
        checked={checked}
        disabled={disabled}
        aria-label={name}
        aria-describedby={`${id}-state`}
        onChange={onSelect}
        className="size-2.5 appearance-none border border-input outline-none checked:border-foreground checked:bg-foreground disabled:cursor-not-allowed"
      />
      <span
        title={name}
        className={cn(
          "min-w-0 truncate text-xs",
          disabled && "text-muted-foreground",
        )}
      >
        {name}
      </span>
      <span id={`${id}-state`} className="contents">
        {state ? (
          <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0",
                dot === "online"
                  ? "bg-state-success"
                  : "bg-muted-foreground/40",
              )}
            />
            {state}
          </span>
        ) : null}
        <span className="col-span-2 col-start-2 min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
          {hint}
        </span>
      </span>
    </label>
  );
}

/**
 * The machine the agent runs on: the project's, or one it is pinned to. A list and not a select, so
 * what each machine can run shows before it is chosen. Only offered when there is more than one
 * machine to choose from, or the agent is already pinned.
 *
 * Only machines that are online are asked what they have. One that cannot be reached has nothing to
 * show and cannot be chosen, unless the form started on it: an agent pinned there keeps its machine
 * in the list, selected, and can come back to it after trying another.
 *
 * A change touches neither the runtime nor the model: a saved agent keeps both and the fields below
 * mark what the machine lacks, while the create wizard, with nothing saved, moves on by itself.
 */
export function MachinePicker({
  form,
  onChange,
}: {
  form: UseFormReturn<AgentForm>;
  onChange?: (() => void) | undefined;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "machines",
    "common",
  ] as const);
  const { machines } = useMachines();
  const { agents } = useAgentList();
  const value = useWatch({ control: form.control, name: "machineId" });
  const { defaultValues, errors } = useFormState({
    control: form.control,
    name: "machineId",
  });
  const saved = defaultValues?.machineId ?? "";
  const error = errors.machineId;
  const listed = machines.filter(
    (machine) =>
      machine.id === saved ||
      ((machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "pending" &&
        machine.status !== "revoked"),
  );
  const shown = listed.length > 1 || saved !== "";
  const runtimes = useRuntimesByMachine(
    shown ? listed.filter((machine) => machine.status === "online") : [],
  );
  if (!shown) return null;

  const choose = (next: string) => {
    form.setValue("machineId", next, { shouldDirty: true });
    form.clearErrors("machineId");
    onChange?.();
  };
  const running = (machineId: string) =>
    agents.filter(
      (agent) => agent.machineId === machineId && agent.status === "working",
    ).length;
  const state = (machine: MachineView) => {
    const status = translateText(`machines:status.${machine.status}`);
    const count = running(machine.id);
    return machine.status === "online" && count > 0
      ? `${status} · ${translateText("agents:machine.running", { count })}`
      : status;
  };
  const hint = (machine: MachineView) => {
    if (machine.status !== "online")
      return translateText("agents:machine.offlineHint");
    const answer = runtimes.get(machine.id);
    if (answer === undefined)
      return (
        <>
          <Skeleton className="my-0.5 h-3 w-32 max-w-full" />
          <span className="sr-only">
            {translateText("agents:runtime.loading")}
          </span>
        </>
      );
    if (answer === null) return translateText("agents:machine.runtimesUnknown");
    return runtimeNames(answer, translateText("agents:runtime.eta"));
  };

  return (
    <div className="space-y-1.5">
      <span id="agent-machine-label" className="block text-xs leading-none">
        {translateText("agents:machine.label")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="agent-machine-label"
        aria-describedby={error ? "agent-machine-error" : undefined}
        className="divide-y border"
      >
        <MachineRow
          id="agent-machine-follow"
          name={translateText("agents:machine.followProject")}
          hint={translateText("agents:machine.followHint")}
          checked={value === ""}
          onSelect={() => choose("")}
        />
        {listed.map((machine) => {
          const name = `${machine.name}${
            machine.kind === "primary"
              ? translateText("agents:machine.primarySuffix")
              : ""
          }`;
          return (
            <MachineRow
              key={machine.id}
              id={`agent-machine-${machine.id}`}
              name={name}
              state={state(machine)}
              dot={machine.status}
              hint={hint(machine)}
              checked={value === machine.id}
              disabled={machine.status !== "online" && machine.id !== saved}
              onSelect={() => choose(machine.id)}
            />
          );
        })}
      </div>
      {error ? (
        <p
          id="agent-machine-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {error.message}
        </p>
      ) : value === "" ? (
        <p className="text-xs text-muted-foreground">
          {translateText("agents:machine.followNote")}
        </p>
      ) : null}
    </div>
  );
}

/** What a machine can run right now: eta's own loop, and the runtimes that would start. */
function runtimeNames(runtimes: AgentRuntimeInfo[], eta: string) {
  return [
    eta,
    ...runtimes
      .filter((runtime) => runtime.status === "available")
      .map((runtime) => runtime.label),
  ].join(" · ");
}
