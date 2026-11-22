import type {
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  MachineView,
} from "@eta/client-contracts";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatLocale } from "@/lib/i18n";
import { tokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import {
  useRefreshRuntimes,
  useRuntimeAccount,
  useRuntimesByMachine,
} from "@/queries/agents";
import { useMachines } from "@/queries/projects";
import { useProviderUsage } from "@/queries/usage";
import { wireErrorMessage } from "@/queries/wire";
import { LOGIN_COMMANDS, runtimeReason } from "./runtime-status";

// The runtimes page: what each machine has to run an agent on, from the same list the agent editor
// reads (`agents.runtimes`, one query per machine). Read only: signing a runtime in, upgrading or
// installing it is the runtime's own, done in a terminal on its machine. A custom runtime (an ACP
// agent) is configured in settings, where each row's Edit leads.

/** The primary and every daemon not revoked: the primary first, then by name. */
function runtimeMachines(machines: readonly MachineView[]): MachineView[] {
  return machines
    .filter(
      (machine) =>
        (machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "revoked",
    )
    .sort(
      (a, b) =>
        Number(b.kind === "primary") - Number(a.kind === "primary") ||
        a.name.localeCompare(b.name),
    );
}

/** A machine that can be asked: the primary always, a daemon while it is online. */
const reachable = (machine: MachineView) =>
  machine.kind === "primary" || machine.status === "online";

/** What the host is asked for: the primary is the host itself, named by nothing. */
const askedId = (machine: MachineView) =>
  machine.kind === "primary" ? undefined : machine.id;

function RuntimeStatus({ runtime }: { runtime: AgentRuntimeInfo }) {
  const { t: translateText } = useTranslation(["runtimes"] as const);
  const reason = runtimeReason(runtime);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap",
        reason === undefined && "text-muted-foreground",
        (reason === "unauthenticated" || reason === "missing") &&
          "text-state-warning-ink",
        (reason === "timeout" || reason === "failed") && "text-state-error-ink",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0",
          reason === undefined && "bg-state-success",
          (reason === "unauthenticated" || reason === "missing") &&
            "bg-state-warning",
          (reason === "timeout" || reason === "failed") && "bg-state-error",
        )}
      />
      {translateText(`status.${reason ?? "available"}`)}
    </span>
  );
}

const percent = (ratio: number) =>
  new Intl.NumberFormat(formatLocale(), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(ratio);

const when = (iso: string) =>
  new Date(iso).toLocaleString(formatLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Who the runtime is signed in as, and how much of its plan is used: each only where it says. */
function AccountBlocks({
  runtime,
  account,
}: {
  runtime: AgentRuntimeInfo;
  account: AgentRuntimeAccount;
}) {
  const { t: translateText } = useTranslation(["runtimes"] as const);
  const { auth, usage } = account;
  const command = LOGIN_COMMANDS[runtime.id];
  return (
    <>
      {auth === undefined ? null : (
        <div data-block="auth" className="space-y-0.5">
          <h4 className="font-medium">{translateText("account.title")}</h4>
          {auth.kind === "logged_in" ? (
            <p>
              {[
                translateText("account.signedIn"),
                auth.email,
                auth.plan,
                auth.method,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : (
            <p className="text-state-warning-ink">
              {auth.kind === "logged_out"
                ? translateText("account.signedOut")
                : translateText("account.unknown")}
              {auth.detail ? ` ${auth.detail}` : ""}
            </p>
          )}
          {auth.kind !== "logged_in" && command !== undefined ? (
            <p>
              <Trans
                t={translateText}
                i18nKey="account.howToSignIn"
                values={{ command }}
                components={{ code: <code className="font-mono" /> }}
              />
            </p>
          ) : null}
        </div>
      )}
      {usage === undefined ? null : (
        <div data-block="usage" className="space-y-1">
          <h4 className="font-medium">{translateText("usage.title")}</h4>
          {usage.kind === "available" ? (
            <>
              <p>
                {[
                  usage.plan,
                  usage.email,
                  usage.rateLimited
                    ? translateText("usage.rateLimited")
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <ul className="space-y-1">
                {usage.windows.map((window) => (
                  <li key={window.label} className="space-y-0.5">
                    <div className="flex justify-between gap-2">
                      <span>{window.label}</span>
                      <span className="tabular-nums">
                        {percent(window.usedRatio)}
                        {window.resetsAt === undefined
                          ? ""
                          : ` · ${translateText("usage.resets", { time: when(window.resetsAt) })}`}
                      </span>
                    </div>
                    <div className="h-1 bg-muted" aria-hidden="true">
                      <div
                        className="h-full bg-foreground/60"
                        style={{
                          width: `${Math.min(100, window.usedRatio * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : usage.kind === "error" ? (
            <p className="break-words text-state-error-ink">{usage.detail}</p>
          ) : (
            <p>
              {translateText(
                usage.kind === "reauth_required"
                  ? "usage.reauthRequired"
                  : "usage.unsupported",
              )}
              {usage.reason ? ` (${usage.reason})` : ""}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** What opens under a runtime's row: its account where it has one, its models, and its own words. */
function RuntimeDetail({
  machine,
  runtime,
}: {
  machine: MachineView;
  runtime: AgentRuntimeInfo;
}) {
  const { t: translateText } = useTranslation(["runtimes"] as const);
  // ACP agents have no account to ask about, and a runtime that is not there has none either.
  const asksAccount =
    !runtime.id.startsWith("acp.") && runtime.status !== "missing";
  const account = useRuntimeAccount(runtime.id, askedId(machine), asksAccount);
  return (
    <div className="space-y-3 border-t px-3 py-2 text-xs text-muted-foreground">
      {!asksAccount ? null : account.isPending ? (
        <Loading rows={1} />
      ) : account.error ? (
        <p role="alert" className="break-words text-destructive">
          {wireErrorMessage(account.error)}
        </p>
      ) : (
        <AccountBlocks runtime={runtime} account={account.data} />
      )}
      <div className="space-y-0.5">
        <h4 className="font-medium">{translateText("models.title")}</h4>
        {runtime.models.length === 0 ? (
          <p>{translateText("models.none")}</p>
        ) : (
          <ul className="space-y-0.5">
            {runtime.models.map((model) => (
              <li key={model.id} className="flex flex-wrap gap-x-2">
                <span className="text-foreground">{model.name}</span>
                {model.name === model.id ? null : (
                  <span className="font-mono">{model.id}</span>
                )}
                {model.default ? (
                  <span>{translateText("models.default")}</span>
                ) : null}
                {model.efforts.length === 0 ? null : (
                  <span>
                    {translateText("models.efforts", {
                      levels: model.efforts.join(" / "),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {runtime.detail ? (
        <details>
          <summary className="cursor-default select-none">
            {translateText("actions.diagnose")}
          </summary>
          <p className="mt-1 font-mono break-words whitespace-pre-wrap">
            {runtime.detail}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function RuntimeRow({
  machine,
  runtime,
  weekTokens,
}: {
  machine: MachineView;
  runtime: AgentRuntimeInfo;
  weekTokens: number | undefined;
}) {
  const { t: translateText } = useTranslation(["runtimes"] as const);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  // The CLI's own `--version` line, which may carry its name (`codex-cli 0.167.2`): the number alone.
  const number = runtime.version?.match(/\d+\.\d[\w.+-]*/)?.[0];
  const version = number === undefined ? runtime.version : `v${number}`;
  const custom = runtime.id.startsWith("acp.");
  return (
    <li data-runtime={runtime.id}>
      <div className="flex items-center hover:bg-muted/50">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <CaretRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{runtime.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[
                custom
                  ? translateText("kind.custom")
                  : translateText("kind.builtin"),
                version,
                weekTokens === undefined
                  ? undefined
                  : translateText("weekTokens", { tokens: tokens(weekTokens) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <RuntimeStatus runtime={runtime} />
        </button>
        {custom ? (
          <Link
            to="/settings"
            search={{ section: "acp" }}
            className="shrink-0 px-3 py-2 text-xs underline-offset-2 hover:underline"
          >
            {translateText("actions.edit")}
          </Link>
        ) : null}
      </div>
      {open ? (
        <div id={detailId}>
          <RuntimeDetail machine={machine} runtime={runtime} />
        </div>
      ) : null}
    </li>
  );
}

/** One machine's runtimes, or why they cannot be shown. */
function MachineRuntimes({
  machine,
  runtimes,
}: {
  machine: MachineView;
  /** Undefined while it answers; null when it could not be asked. */
  runtimes: AgentRuntimeInfo[] | null | undefined;
}) {
  const { t: translateText } = useTranslation([
    "runtimes",
    "machines",
    "common",
  ] as const);
  const headingId = useId();
  const online = reachable(machine);
  const usage = useProviderUsage();
  const refresh = useRefreshRuntimes();
  return (
    <section
      aria-labelledby={headingId}
      data-machine={machine.id}
      className="space-y-1.5"
    >
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <h3 id={headingId} className="truncate font-medium">
          {machine.name}
        </h3>
        <span className="shrink-0 text-muted-foreground">
          {machine.kind === "primary"
            ? translateText("machines:kinds.primary")
            : translateText(`machines:status.${machine.status}`)}
        </span>
        <span className="flex-1" />
        {online ? (
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(askedId(machine))}
          >
            {refresh.isPending
              ? translateText("actions.probing")
              : translateText("actions.probe")}
          </Button>
        ) : null}
      </div>
      {refresh.error ? (
        <p role="alert" className="text-xs text-destructive">
          {wireErrorMessage(refresh.error)}
        </p>
      ) : null}
      {!online ? (
        <p
          role="status"
          className="border bg-[repeating-linear-gradient(-45deg,var(--background)_0_7px,var(--muted)_7px_8px)] px-3 py-3 text-xs text-muted-foreground"
        >
          {translateText("machine.offline", { name: machine.name })}
        </p>
      ) : runtimes === undefined ? (
        <Loading rows={2} />
      ) : runtimes === null ? (
        <p role="alert" className="border px-3 py-2 text-xs text-destructive">
          {translateText("machine.unreachable", { name: machine.name })}
        </p>
      ) : (
        <ul
          aria-label={translateText("machine.list", { name: machine.name })}
          className="divide-y border"
        >
          {runtimes.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              machine={machine}
              runtime={runtime}
              weekTokens={
                usage === undefined
                  ? undefined
                  : (usage.get(runtime.id)?.windows["7d"].total ?? 0)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function RuntimesView() {
  const { t: translateText } = useTranslation(["runtimes"] as const);
  const { machines, loaded } = useMachines();
  const listed = runtimeMachines(machines);
  // The ones that can be asked are; one that cannot keeps its group and says so.
  const asked = listed.filter(reachable);
  const byMachine = useRuntimesByMachine(asked);
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {!loaded ? (
        <Loading rows={3} />
      ) : (
        <div className="space-y-4">
          {[...asked, ...listed.filter((machine) => !reachable(machine))].map(
            (machine) => (
              <MachineRuntimes
                key={machine.id}
                machine={machine}
                runtimes={byMachine.get(machine.id)}
              />
            ),
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <Link
          to="/settings"
          search={{ section: "acp" }}
          className="text-foreground underline underline-offset-2"
        >
          {translateText("actions.addCustom")}
        </Link>{" "}
        {translateText("addCustomHint")}
      </p>
    </div>
  );
}
