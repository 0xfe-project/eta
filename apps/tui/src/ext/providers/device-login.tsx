import type { LlmConnector, LlmLogin } from "@eta/client-contracts";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { callErrorText, llmProblemText } from "../kit/errors";
import { remainingText } from "./accounts";
import { providersMessages } from "./messages";

/** How often a waiting login is asked about, as the web page does. */
const POLL_MS = 1_500;
const TICK_MS = 1_000;

/**
 * A device-code sign-in: starts a login, shows where to enter the code and how long it lasts,
 * and asks the host until the login ends. Enter starts a failed or expired login again; Esc
 * cancels a waiting login on the host and goes back.
 */
export function DeviceLogin({
  connector,
  onBack,
  onConnected,
}: {
  connector: LlmConnector;
  onBack: () => void;
  onConnected: () => void;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  const { wire, locale, reportFailure } = useShell();
  const active = useInputActive();
  const [attempt, setAttempt] = useState(0);
  const [login, setLogin] = useState<LlmLogin>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  /** The login a cancel would be for: the latest one while it waits. */
  const waitingRef = useRef<LlmLogin | undefined>(undefined);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  const cancelWaiting = () => {
    const waiting = waitingRef.current;
    waitingRef.current = undefined;
    if (waiting !== undefined)
      reportFailure(wire.call("llm", "loginCancel", { id: waiting.id }));
  };
  const cancelRef = useRef(cancelWaiting);
  cancelRef.current = cancelWaiting;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = () =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_MS);
      });
    const follow = async () => {
      try {
        let { login: current } = await wire.call<{ login: LlmLogin }>(
          "llm",
          "loginStart",
          { connector: connector.id },
        );
        if (stopped) {
          // Left before the code came: the login must not stay open on the host.
          if (current.status === "pending")
            reportFailure(wire.call("llm", "loginCancel", { id: current.id }));
          return;
        }
        while (current.status === "pending") {
          waitingRef.current = current;
          setLogin(current);
          await pause();
          if (stopped) return;
          ({ login: current } = await wire.call<{ login: LlmLogin }>(
            "llm",
            "loginPoll",
            { id: current.id },
          ));
          if (stopped) return;
        }
        waitingRef.current = undefined;
        setLogin(current);
        if (current.status === "succeeded") connectedRef.current();
        else
          setError(
            current.error === undefined
              ? t("loginFailed")
              : llmProblemText(current.error, locale),
          );
      } catch (cause) {
        if (stopped) return;
        waitingRef.current = undefined;
        setError(callErrorText(cause, locale));
      }
    };
    void follow();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [attempt, connector.id, wire, locale, reportFailure, t]);

  // Leaving by any way, not only Esc, cancels a login that is still waiting.
  useEffect(() => () => cancelRef.current(), []);

  const pending = login?.status === "pending" && error === undefined;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [pending]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        cancelWaiting();
        onBack();
      } else if (key.return && error !== undefined) {
        setLogin(undefined);
        setError(undefined);
        setAttempt((n) => n + 1);
      }
    },
    { isActive: active },
  );

  const muted = inkColor(theme.muted);
  return (
    <Box flexDirection="column">
      <Text bold>{t("connect", { name: connector.name })}</Text>
      <Box flexDirection="column" marginY={1}>
        {error !== undefined ? (
          <Text color={inkColor(theme.error)}>{error}</Text>
        ) : login === undefined ? (
          <Text color={muted}>{t("codeLoading")}</Text>
        ) : (
          <>
            <Text>{t("deviceInstructions")}</Text>
            {login.url !== undefined && (
              <Text>{t("deviceAddress", { url: login.url })}</Text>
            )}
            {login.userCode !== undefined && (
              <Text bold>{t("deviceCode", { code: login.userCode })}</Text>
            )}
            <Text color={muted}>
              {t("deviceExpires", {
                time: remainingText(login.expiresAt, now),
              })}
            </Text>
          </>
        )}
      </Box>
      <Text color={muted}>
        {error === undefined ? t("deviceFooter") : t("retryFooter")}
      </Text>
    </Box>
  );
}
