import type { LayerHandle, SlashCommand } from "../../extensions/types";
import { Box, Text, useInput } from "ink";
import { useInputActive, useTheme } from "../../extensions/react";
import { commandUsage } from "../../extensions/usage";
import { localize } from "../../i18n/messages";
import { useLocale, useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { helpMessages } from "./messages";

function useCloseOnEscape(handle: LayerHandle) {
  const active = useInputActive();
  useInput(
    (_, key) => {
      if (key.escape) handle.close();
    },
    { isActive: active },
  );
}

export function CommandList({
  commands,
  handle,
}: {
  commands: readonly SlashCommand[];
  handle: LayerHandle;
}) {
  const t = useMessages(helpMessages);
  const theme = useTheme();
  const locale = useLocale();
  useCloseOnEscape(handle);
  const width = Math.max(...commands.map((c) => commandUsage(c).length));
  return (
    <LayerFrame title={t("title")} footer={t("close")}>
      {commands.map((command) => (
        <Text key={command.name} wrap="truncate-end">
          <Text color={inkColor(theme.accent)}>
            {commandUsage(command).padEnd(width + 2)}
          </Text>
          {localize(command.summary, locale)}
        </Text>
      ))}
    </LayerFrame>
  );
}

export function CommandDetail({
  command,
  handle,
}: {
  command: SlashCommand;
  handle: LayerHandle;
}) {
  const t = useMessages(helpMessages);
  const theme = useTheme();
  const locale = useLocale();
  useCloseOnEscape(handle);
  return (
    <LayerFrame title={commandUsage(command)} footer={t("close")}>
      <Text>{localize(command.summary, locale)}</Text>
      {command.args.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t("arguments")}</Text>
          {command.args.map((arg) => (
            <Text key={arg.name}>
              <Text color={inkColor(theme.accent)}>{`  ${arg.name}`}</Text>
              <Text
                color={inkColor(theme.muted)}
              >{` (${arg.required ? t("required") : t("optional")}) `}</Text>
              {localize(arg.summary, locale)}
            </Text>
          ))}
        </Box>
      )}
      {command.examples.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t("examples")}</Text>
          {command.examples.map((example) => (
            <Text key={example.input}>
              <Text color={inkColor(theme.accent)}>{`  ${example.input}`}</Text>
              {`  ${localize(example.summary, locale)}`}
            </Text>
          ))}
        </Box>
      )}
    </LayerFrame>
  );
}
