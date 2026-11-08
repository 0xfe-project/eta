import { Box, Text } from "ink";
import { useState } from "react";
import { runCommandLine } from "../../extensions/command-line";
import {
  useAction,
  useRegistry,
  useShell,
  useTheme,
} from "../../extensions/react";
import { localize } from "../../i18n/messages";
import { useLocale, useMessages } from "../../i18n/react";
import { LineInput } from "../components/line-input";
import { Splash } from "../splash";
import { inkColor } from "../theme";
import { shellMessages } from "./messages";

const MAX_COMPLETIONS = 8;
const PROMPT = "› ";
/** The status area, the tab bar and the input line. */
const SHELL_ROWS = 3;
/** Commands the home screen suggests, when they are registered. */
const HINTED_COMMANDS = ["help", "new"];

/** The completion prefix while a command name is being typed: after `/`, before any space. */
function namePrefix(input: string): string | undefined {
  if (!input.startsWith("/") || /\s/.test(input)) return undefined;
  return input.slice(1);
}

function CommandInput() {
  const ctx = useShell();
  const registry = useRegistry();
  const theme = useTheme();
  const locale = useLocale();
  const t = useMessages(shellMessages);
  const [value, setValue] = useState("");
  const prefix = namePrefix(value);
  const matches =
    prefix === undefined
      ? []
      : registry.complete(prefix).slice(0, MAX_COMPLETIONS);
  // Left opens the rightmost pinned tab's panel, but only while there is nothing typed to edit;
  // useAction already stays off while this input does not receive keys.
  useAction("panel.open", () => ctx.selectPinnedTab(), {
    isActive: value === "",
  });
  const submit = (line: string) => {
    setValue("");
    if (line.trim() === "") return;
    if (line.startsWith("/")) void runCommandLine(line, registry, ctx);
    else ctx.notify(t("noConversation"));
  };
  return (
    <Box flexDirection="column" flexShrink={0}>
      {matches.map((command) => (
        <Text key={command.name} wrap="truncate-end">
          <Text color={inkColor(theme.accent)}>{`/${command.name}`}</Text>
          <Text
            color={inkColor(theme.muted)}
          >{`  ${localize(command.summary, locale)}`}</Text>
        </Text>
      ))}
      <Box>
        <Text color={inkColor(theme.accent)}>{PROMPT}</Text>
        <LineInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onEscape={() => setValue("")}
          onTab={() => {
            const first = matches[0];
            if (first) setValue(`/${first.name} `);
          }}
        />
      </Box>
    </Box>
  );
}

/** What the main area shows with no tab in front: the splash and the command input. */
export function Home({
  url,
  temporary,
  version,
}: {
  url: string;
  temporary: boolean;
  version: string;
}) {
  const registry = useRegistry();
  const theme = useTheme();
  const locale = useLocale();
  const t = useMessages(shellMessages);
  const hints = HINTED_COMMANDS.flatMap((name) => {
    const command = registry.command(name);
    return command ? [command] : [];
  });
  const hostLine = temporary
    ? t("hostLineTemporary", { url })
    : t("hostLine", { url });
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        flexGrow={1}
        justifyContent="center"
        alignItems="center"
        overflow="hidden"
      >
        <Splash
          version={version}
          detail={<Text color={inkColor(theme.muted)}>{hostLine}</Text>}
          compactDetail={url}
          reservedRows={SHELL_ROWS}
          belowRows={hints.length}
          below={hints.map((command) => (
            <Text key={command.name}>
              <Text color={inkColor(theme.accent)}>
                {`/${command.name}`.padEnd(8)}
              </Text>
              <Text color={inkColor(theme.muted)}>
                {localize(command.summary, locale)}
              </Text>
            </Text>
          ))}
        />
      </Box>
      <CommandInput />
    </Box>
  );
}
