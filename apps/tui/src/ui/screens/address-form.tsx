import type { ConnectionController } from "../../connection/types";
import { Box, Text } from "ink";
import { useState } from "react";
import { useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LineInput } from "../components/line-input";
import { inkColor } from "../theme";
import { screenMessages } from "./messages";

type Field = "address" | "token";

/**
 * Asks for a host address and, when the host wants one, a token; checks them with the controller
 * and connects when the check passes. Starts with only the address unless `withToken`.
 */
export function AddressForm({
  controller,
  initialUrl,
  withToken = false,
  startAt = "address",
  onBack,
}: {
  controller: ConnectionController;
  initialUrl: string;
  withToken?: boolean;
  startAt?: Field;
  onBack?: () => void;
}) {
  const t = useMessages(screenMessages);
  const theme = useTheme();
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(withToken);
  const [focus, setFocus] = useState<Field>(startAt);
  const [error, setError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (checking) return;
    setChecking(true);
    setError(undefined);
    const given = showToken && token !== "" ? token : undefined;
    const check = await controller.checkAddress(url, given);
    setChecking(false);
    switch (check.result) {
      case "ok":
        await controller.connectResident(
          given === undefined
            ? { url: check.url }
            : { url: check.url, token: given },
        );
        return;
      case "needs-token":
        setUrl(check.url);
        if (showToken) setError(t("needsToken"));
        setShowToken(true);
        setFocus("token");
        return;
      case "bad-token":
        setUrl(check.url);
        setError(t("badToken"));
        setShowToken(true);
        setFocus("token");
        return;
      case "unreachable":
        setError(t("unreachableAddress", { url: check.url }));
        setFocus("address");
        return;
      case "invalid":
        setError(t("invalidAddress"));
        setFocus("address");
    }
  };
  const switchField = () => {
    if (showToken) setFocus((f) => (f === "address" ? "token" : "address"));
  };
  const field = (
    name: Field,
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <Box>
      <Text
        color={focus === name ? inkColor(theme.accent) : inkColor(theme.muted)}
      >
        {label}
        {": "}
      </Text>
      <LineInput
        value={value}
        onChange={onChange}
        masked={name === "token"}
        focused={focus === name && !checking}
        onSubmit={() => void submit()}
        onEscape={onBack}
        onTab={switchField}
      />
    </Box>
  );
  return (
    <Box flexDirection="column">
      {field("address", t("addressLabel"), url, setUrl)}
      {showToken && field("token", t("tokenLabel"), token, setToken)}
      <Box marginTop={1}>
        {checking ? (
          <Text color={inkColor(theme.muted)}>{t("checking", { url })}</Text>
        ) : error !== undefined ? (
          <Text color={inkColor(theme.error)}>{error}</Text>
        ) : (
          <Text color={inkColor(theme.muted)}>
            {onBack ? t("addressHelp") : t("addressHelpNoBack")}
          </Text>
        )}
      </Box>
    </Box>
  );
}
