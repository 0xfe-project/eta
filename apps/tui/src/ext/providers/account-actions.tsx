import type { LlmConnection, LlmConnector } from "@eta/client-contracts";
import type { PickItem } from "../kit/pick-list";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { callErrorText, llmProblemText } from "../kit/errors";
import { PickList } from "../kit/pick-list";
import { needsSignIn, stateLabel } from "./accounts";
import { providersMessages } from "./messages";

/** Runs a host call for a view, holding whether it runs and why it failed. */
function useHostAction(): {
  working: boolean;
  /** Whether a call runs, as of now: for key handlers, which may run twice before a re-render. */
  isWorking: () => boolean;
  error: string | undefined;
  /** Starts `call` unless one runs; a second start before it ends does nothing. */
  run: (call: () => Promise<unknown>, after: () => void) => void;
} {
  const { locale } = useShell();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const workingRef = useRef(false);
  const run = (call: () => Promise<unknown>, after: () => void) => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    setError(undefined);
    void (async () => {
      try {
        await call();
        after();
      } catch (cause) {
        setError(callErrorText(cause, locale));
      }
      workingRef.current = false;
      setWorking(false);
    })();
  };
  return { working, isWorking: () => workingRef.current, error, run };
}

function StatusLines({
  working,
  error,
}: {
  working: boolean;
  error: string | undefined;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  return (
    <>
      {working && <Text color={inkColor(theme.muted)}>{t("working")}</Text>}
      {error !== undefined && (
        <Text color={inkColor(theme.error)}>{error}</Text>
      )}
    </>
  );
}

type AccountAction = "toggle" | "relogin" | "remove";

/**
 * What can be done with one account: disable or enable it, sign in again when its state needs
 * that, or remove it (asked again first). Esc goes back to the list.
 */
export function AccountMenu({
  connection,
  connector,
  onBack,
  onRelogin,
  onRemove,
}: {
  connection: LlmConnection;
  connector: LlmConnector | undefined;
  onBack: () => void;
  onRelogin: () => void;
  onRemove: () => void;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  const { wire, locale } = useShell();
  const active = useInputActive();
  const action = useHostAction();
  const disabled = connection.state === "disabled";
  useInput(
    (_input, key) => {
      if (key.escape && !action.isWorking()) onBack();
    },
    { isActive: active },
  );
  const items: (PickItem & { key: AccountAction })[] = [
    { key: "toggle", label: disabled ? t("enable") : t("disable") },
    ...(needsSignIn(connection.state)
      ? [{ key: "relogin" as const, label: t("relogin") }]
      : []),
    { key: "remove", label: t("remove") },
  ];
  const pick = (key: string) => {
    if (action.isWorking()) return;
    if (key === "relogin") onRelogin();
    else if (key === "remove") onRemove();
    else
      action.run(
        () =>
          wire.call("llm", "setEnabled", {
            id: connection.id,
            enabled: disabled,
          }),
        onBack,
      );
  };
  const muted = inkColor(theme.muted);
  const details = [
    connector?.name ?? connection.connector,
    stateLabel(t, connection.state),
  ];
  if (connection.plan !== undefined) details.push(connection.plan);
  return (
    <Box flexDirection="column">
      <Text bold>{connection.label}</Text>
      <Text color={muted}>{details.join(" · ")}</Text>
      {connection.error !== undefined && !disabled && (
        <Text color={muted}>{llmProblemText(connection.error, locale)}</Text>
      )}
      <Box flexDirection="column" marginY={1}>
        <PickList items={items} empty="" onPick={pick} />
        <StatusLines working={action.working} error={action.error} />
      </Box>
      <Text color={muted}>{t("menuFooter")}</Text>
    </Box>
  );
}

/** Asks once more before removing an account. Enter removes it, Esc goes back. */
export function RemoveConfirm({
  connection,
  onBack,
  onRemoved,
}: {
  connection: LlmConnection;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  const { wire } = useShell();
  const active = useInputActive();
  const action = useHostAction();
  useInput(
    (_input, key) => {
      if (action.isWorking()) return;
      if (key.escape) onBack();
      else if (key.return)
        action.run(
          () => wire.call("llm", "remove", { id: connection.id }),
          onRemoved,
        );
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      <Text bold>{t("confirmRemove", { account: connection.label })}</Text>
      <Box flexDirection="column" marginY={1}>
        <Text>{t("removeNotice")}</Text>
        <StatusLines working={action.working} error={action.error} />
      </Box>
      <Text color={inkColor(theme.muted)}>{t("confirmFooter")}</Text>
    </Box>
  );
}
