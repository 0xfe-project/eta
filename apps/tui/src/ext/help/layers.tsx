import type { ActionName } from "../../config/types";
import type { LayerHandle, SlashCommand } from "../../extensions/types";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import { formatKeyBinding } from "../../config/keys";
import { useConfig, useInputActive, useTheme } from "../../extensions/react";
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

type HelpKey = keyof (typeof helpMessages)["en"];

/** The kinds of keys a conversation has, one line each, with the actions that make it up. */
const CONVERSATION_KEYS: [HelpKey, ActionName[]][] = [
  [
    "keysScroll",
    [
      "transcript.pageUp",
      "transcript.pageDown",
      "transcript.lineUp",
      "transcript.lineDown",
      "transcript.top",
      "transcript.bottom",
    ],
  ],
  ["keysSearch", ["transcript.search"]],
  ["keysSelect", ["transcript.select"]],
  ["keysExpandAll", ["transcript.expandAll"]],
  ["keysToggleTurn", ["transcript.toggleTurn"]],
  ["keysNewline", ["message.newline"]],
  ["keysSteer", ["message.steer"]],
  ["keysStop", ["reply.stop"]],
];

/**
 * The conversation's keys as the settings bind them: each action's first key. Then how the mouse
 * works, which depends on whether the settings have the terminal report it.
 */
function ConversationKeys() {
  const t = useMessages(helpMessages);
  const theme = useTheme();
  const { keybindings, mouse } = useConfig();
  const rows = CONVERSATION_KEYS.map(([label, actions]) => ({
    label: t(label),
    keys: actions.flatMap((action) => {
      const first = keybindings[action][0];
      return first === undefined ? [] : [formatKeyBinding(first)];
    }),
  }));
  const width = Math.max(...rows.map((row) => stringWidth(row.label)));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{t("keys")}</Text>
      {rows.map((row) => (
        <Text key={row.label} wrap="truncate-end">
          {row.label + " ".repeat(width - stringWidth(row.label) + 2)}
          <Text color={inkColor(theme.accent)}>{row.keys.join(" ")}</Text>
        </Text>
      ))}
      <Text color={inkColor(theme.muted)}>
        {mouse ? t("mouseOn") : t("mouseOff")}
      </Text>
    </Box>
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
      <ConversationKeys />
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
