import type { VersionWarning } from "../../connection/types";
import type { Notice } from "./session";
import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../theme";
import { shellMessages } from "./messages";

const SEPARATOR = "  ";

/**
 * One line, cut at the right edge: the quit question or the latest notice, the address, the
 * temporary host warning and the version warning. The short-lived line comes first so a narrow
 * terminal still shows it.
 */
export function StatusBar({
  url,
  temporary,
  versionWarning,
  notice,
  quitHint,
}: {
  url: string;
  temporary: boolean;
  versionWarning: VersionWarning | undefined;
  notice: Notice | undefined;
  quitHint: string | undefined;
}) {
  const t = useMessages(shellMessages);
  const theme = useTheme();
  const toneColor = {
    info: inkColor(theme.text),
    warning: inkColor(theme.warning),
    error: inkColor(theme.error),
  };
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        {quitHint !== undefined ? (
          <Text color={inkColor(theme.warning)}>
            {quitHint}
            {SEPARATOR}
          </Text>
        ) : (
          notice !== undefined && (
            <Text color={toneColor[notice.tone]}>
              {notice.text}
              {SEPARATOR}
            </Text>
          )
        )}
        <Text color={inkColor(theme.muted)}>{t("connected", { url })}</Text>
        {temporary && (
          <>
            {SEPARATOR}
            <Text color={inkColor(theme.warning)}>{t("temporaryWarning")}</Text>
          </>
        )}
        {versionWarning !== undefined && (
          <>
            {SEPARATOR}
            <Text color={inkColor(theme.warning)}>
              {t("versionWarning", {
                host: versionWarning.host,
                tui: versionWarning.tui,
              })}
            </Text>
          </>
        )}
      </Text>
    </Box>
  );
}
