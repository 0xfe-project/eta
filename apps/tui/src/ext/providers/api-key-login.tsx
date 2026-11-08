import type { LlmConnector, LlmLogin } from "@eta/client-contracts";
import { Box, Text } from "ink";
import { useState } from "react";
import { useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { callErrorText, llmProblemText } from "../kit/errors";
import { TextPrompt } from "../kit/text-prompt";
import { keyPage } from "./accounts";
import { providersMessages } from "./messages";

/**
 * The host gives the provider 30 seconds to answer a key check and then writes the key into the
 * gateway (`apps/eta/src/llm/gemini.ts`); the wire's default limit is also 30 seconds and would
 * give up on a slow check that still succeeds.
 */
const SUBMIT_TIMEOUT_MS = 60_000;

/**
 * An API key, typed masked and checked with the provider before the gateway keeps it. A refused
 * key shows its reason under the input, which keeps the key for correcting. Esc goes back.
 */
export function ApiKeyLogin({
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
  const { wire, locale } = useShell();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const page = keyPage(connector.id);

  // Every key is a login of its own: the gateway checks the key as the login's input.
  const check = async (apiKey: string) => {
    setChecking(true);
    setError(undefined);
    try {
      const { login } = await wire.call<{ login: LlmLogin }>(
        "llm",
        "loginStart",
        { connector: connector.id },
      );
      const { login: done } = await wire.call<{ login: LlmLogin }>(
        "llm",
        "loginSubmit",
        { id: login.id, apiKey },
        { timeoutMs: SUBMIT_TIMEOUT_MS },
      );
      if (done.status === "succeeded") {
        onConnected();
        return;
      }
      setError(
        done.error === undefined
          ? t("loginFailed")
          : llmProblemText(done.error, locale),
      );
    } catch (cause) {
      setError(callErrorText(cause, locale));
    }
    setChecking(false);
  };

  return (
    <Box flexDirection="column">
      <TextPrompt
        label={t("keyLabel", { name: connector.name })}
        masked
        help={page === undefined ? t("keyHelp") : t("keyHelpAt", { url: page })}
        error={error}
        busy={checking ? t("keyChecking") : undefined}
        onSubmit={(value) => void check(value)}
        onCancel={onBack}
      />
      <Box marginTop={1}>
        <Text color={inkColor(theme.muted)}>{t("keyFooter")}</Text>
      </Box>
    </Box>
  );
}
