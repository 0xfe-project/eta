import type {
  MachineKind,
  MachineStatus,
  MachineView,
} from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import type { Translate } from "../../i18n/messages";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { connectionUrl } from "../kit/connection";
import { useHostCall } from "../kit/host-call";
import { PickList } from "../kit/pick-list";
import { TextPrompt } from "../kit/text-prompt";
import { useTarget } from "../kit/wire-hooks";
import { enrollUrl } from "./address";
import { machinesMessages } from "./messages";

type MachinesText = Translate<keyof (typeof machinesMessages)["en"]>;

const KIND_KEYS = {
  primary: "kindPrimary",
  daemon: "kindDaemon",
  ssh: "kindSsh",
} as const satisfies Record<MachineKind, string>;

const STATUS_KEYS = {
  online: "statusOnline",
  offline: "statusOffline",
  pending: "statusPending",
  revoked: "statusRevoked",
} as const satisfies Record<MachineStatus, string>;

/** What `machines.enroll` answers. */
interface Enrollment {
  code: string;
  expiresAt: number;
  url: string;
  command: string;
}

type View =
  | { name: "list" }
  | { name: "machine"; id: string }
  | { name: "add"; enrollment?: Enrollment };

/** The time in the terminal's zone, to the minute: `2026-11-08 14:05`. */
function formatTime(epochMs: number): string {
  const at = new Date(epochMs);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The machines of this host: the list, one machine's actions, and adding one. */
export function MachinesLayer({ handle }: { handle: LayerHandle }) {
  const ctx = useShell();
  const machines = useTarget("machines")?.sections.list as
    | MachineView[]
    | undefined;
  const [view, setView] = useState<View>({ name: "list" });

  const enrolling = useHostCall();

  const add = () => {
    setView({ name: "add" });
    const enroll = async () => {
      const { tailnet } = await ctx.wire.call<{ tailnet: string | null }>(
        "machines",
        "addresses",
        {},
      );
      const url = enrollUrl({
        tailnet,
        connectionUrl: connectionUrl(ctx.connection),
      });
      return ctx.wire.call<Enrollment>(
        "machines",
        "enroll",
        url === undefined ? {} : { url },
      );
    };
    enrolling.run(enroll, (enrollment) =>
      setView((now) =>
        now.name === "add" ? { name: "add", enrollment } : now,
      ),
    );
  };

  const back = () => setView({ name: "list" });

  switch (view.name) {
    case "add":
      return (
        <AddMachine
          enrollment={view.enrollment}
          error={enrolling.error}
          onBack={back}
        />
      );
    case "machine":
      return (
        <MachineDetail
          machine={machines?.find((machine) => machine.id === view.id)}
          onBack={back}
        />
      );
    case "list":
      return (
        <MachineList
          machines={machines}
          onOpen={(id) => setView({ name: "machine", id })}
          onAdd={add}
          onClose={() => handle.close()}
        />
      );
  }
}

function MachineList({
  machines,
  onOpen,
  onAdd,
  onClose,
}: {
  machines: MachineView[] | undefined;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const t = useMessages(machinesMessages);
  const items = (machines ?? []).map((machine) => ({
    key: machine.id,
    label: machine.name,
    hint: [
      t(KIND_KEYS[machine.kind]),
      t(STATUS_KEYS[machine.status]),
      ...(machine.os === null ? [] : [machine.os]),
    ].join(" · "),
    ...(machine.kind === "primary" ? { tag: t("thisHost") } : {}),
  }));
  return (
    <LayerFrame title={t("title")} footer={t("listFooter")}>
      <PickList
        items={items}
        empty={machines === undefined ? t("loading") : t("empty")}
        onPick={onOpen}
        onKey={(input, key) => {
          if (key.escape) onClose();
          else if (input === "a") onAdd();
          else return false;
          return true;
        }}
      />
    </LayerFrame>
  );
}

function useEscape(onEscape: () => void): void {
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) onEscape();
    },
    { isActive: active },
  );
}

function AddMachine({
  enrollment,
  error,
  onBack,
}: {
  enrollment: Enrollment | undefined;
  error: string | undefined;
  onBack: () => void;
}) {
  const t = useMessages(machinesMessages);
  const theme = useTheme();
  useEscape(onBack);
  const body =
    error !== undefined ? (
      <Text color={inkColor(theme.error)}>{error}</Text>
    ) : enrollment === undefined ? (
      <Text color={inkColor(theme.muted)}>{t("enrolling")}</Text>
    ) : (
      <>
        <Text>{t("code", { code: enrollment.code })}</Text>
        <Text>{t("expires", { time: formatTime(enrollment.expiresAt) })}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{t("runThis")}</Text>
          <Text color={inkColor(theme.accent)}>{enrollment.command}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text>{t("connectsTo", { url: enrollment.url })}</Text>
          <Text color={inkColor(theme.muted)}>{t("arrives")}</Text>
        </Box>
      </>
    );
  return (
    <LayerFrame title={t("title")} footer={t("addFooter")}>
      {body}
    </LayerFrame>
  );
}

type Step = "actions" | "approve" | "revoke";

function actionsFor(machine: MachineView, t: MachinesText) {
  return [
    ...(machine.status === "pending"
      ? [{ key: "approve", label: t("approve") }]
      : []),
    ...(machine.kind !== "primary" && machine.status !== "revoked"
      ? [{ key: "revoke", label: t("revoke") }]
      : []),
  ];
}

function MachineDetail({
  machine,
  onBack,
}: {
  machine: MachineView | undefined;
  onBack: () => void;
}) {
  const t = useMessages(machinesMessages);
  const theme = useTheme();
  const { wire } = useShell();
  const [step, setStep] = useState<Step>("actions");
  const { busy, error, setError, run } = useHostCall();
  const muted = inkColor(theme.muted);

  const send = (action: "approve" | "revoke", args: object) =>
    run(
      async () => wire.call("machines", action, args),
      () => setStep("actions"),
    );

  const toActions = () => {
    setError(undefined);
    setStep("actions");
  };

  if (machine === undefined)
    return (
      <LayerFrame title={t("title")} footer={t("detailFooter")}>
        <Text color={muted}>{t("gone")}</Text>
        <EscapeTo onEscape={onBack} />
      </LayerFrame>
    );

  const facts = (
    <>
      <Text>{t("kind", { kind: t(KIND_KEYS[machine.kind]) })}</Text>
      <Text>{t("status", { status: t(STATUS_KEYS[machine.status]) })}</Text>
      {machine.os !== null && <Text>{t("system", { os: machine.os })}</Text>}
      {machine.version !== null && (
        <Text>{t("version", { version: machine.version })}</Text>
      )}
      {machine.fingerprint !== null && (
        <Text color={muted}>
          {t("fingerprint", { fingerprint: machine.fingerprint })}
        </Text>
      )}
    </>
  );

  if (step === "approve")
    return (
      <LayerFrame title={machine.name} footer={t("approveFooter")}>
        {facts}
        <Box marginTop={1}>
          <TextPrompt
            label={t("fingerprintLabel")}
            onSubmit={(fingerprint) =>
              send("approve", { machineId: machine.id, fingerprint })
            }
            onCancel={toActions}
            error={error}
            busy={busy ? t("approving") : undefined}
          />
        </Box>
      </LayerFrame>
    );

  if (step === "revoke")
    return (
      <LayerFrame title={machine.name} footer={t("revokeFooter")}>
        {facts}
        <Box marginTop={1} flexDirection="column">
          <Text>{t("revokeQuestion", { name: machine.name })}</Text>
          {busy && <Text color={muted}>{t("revoking")}</Text>}
          {error !== undefined && (
            <Text color={inkColor(theme.error)}>{error}</Text>
          )}
        </Box>
        <ConfirmKeys
          onConfirm={() => send("revoke", { machineId: machine.id })}
          onCancel={toActions}
        />
      </LayerFrame>
    );

  const actions = actionsFor(machine, t);
  return (
    <LayerFrame title={machine.name} footer={t("detailFooter")}>
      {facts}
      <Box marginTop={1} flexDirection="column">
        <PickList
          items={actions}
          empty={t("nothingToDo")}
          onPick={(key) => {
            setError(undefined);
            setStep(key as Step);
          }}
          onKey={(_input, key) => {
            if (!key.escape) return false;
            onBack();
            return true;
          }}
        />
      </Box>
    </LayerFrame>
  );
}

function EscapeTo({ onEscape }: { onEscape: () => void }) {
  useEscape(onEscape);
  return null;
}

function ConfirmKeys({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.return) onConfirm();
      else if (key.escape) onCancel();
    },
    { isActive: active },
  );
  return null;
}
