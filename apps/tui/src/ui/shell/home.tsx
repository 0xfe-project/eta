import type { KeyBinding } from "../../config/types";
import type { SlashCommand } from "../../extensions/types";
import type { MenuEntry } from "../components/completion-menu";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { formatKeyBinding } from "../../config/keys";
import { runCommandLine } from "../../extensions/command-line";
import {
  useAction,
  useConfig,
  useInputActive,
  useRegistry,
  useShell,
  useTheme,
} from "../../extensions/react";
import { localize } from "../../i18n/messages";
import { useLocale, useMessages } from "../../i18n/react";
import { CompletionMenu } from "../components/completion-menu";
import { LineInput } from "../components/line-input";
import { MENU_ROWS } from "../components/menu-window";
import { typedRanges } from "../components/typed-ranges";
import { SplashLine, SplashLogo } from "../splash";
import { SPLASH_LOGO_ROWS, splashLogoFits } from "../splash-size";
import { inkColor } from "../theme";
import { shellMessages } from "./messages";

const PROMPT = "› ";
/** The status line and the tab bar: the rows of the screen outside the main area. */
const SHELL_ROWS = 2;
/** The input line and the rules above and below it. */
const INPUT_ROWS = 3;
/** The logo and the blank line under it. */
const LOGO_HEADER_ROWS = SPLASH_LOGO_ROWS + 1;
const LINE_HEADER_ROWS = 1;
/** Columns between the widest hint name and the hint texts. */
const HINT_GAP = 2;
const ARROW_KEYS: Record<string, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};

/** The completion prefix while a command name is being typed: after `/`, before any space. */
function namePrefix(input: string): string | undefined {
  if (!input.startsWith("/") || /\s/.test(input)) return undefined;
  return input.slice(1);
}

/** A key as the hints show it: `formatKeyBinding`, with the arrow keys drawn as arrows. */
function hintKey(binding: KeyBinding): string {
  return formatKeyBinding({
    ...binding,
    key: ARROW_KEYS[binding.key] ?? binding.key,
  });
}

type Header = "logo" | "line" | "none";

type HomeLayout =
  | { header: Header; below: "hints" | "nothing" }
  | {
      header: Header;
      below: "menu";
      /** How many rows the completion menu may draw. */
      menuRows: number;
    };

const HEADER_ROWS: Record<Header, number> = {
  logo: LOGO_HEADER_ROWS,
  line: LINE_HEADER_ROWS,
  none: 0,
};

/**
 * What the main area of `mainRows` rows holds. The input always shows. An open menu always shows
 * too: a header goes before the menu gives up any of its `menuRows` rows, and the menu draws in
 * what the input leaves, at least one row. Without a menu, the hints (`hintRows`) go before the
 * logo does; a header that does not fit beside the input is left out.
 */
function homeLayout({
  columns,
  mainRows,
  hintRows,
  menuRows,
}: {
  columns: number;
  mainRows: number;
  hintRows: number;
  /** Rows the open menu wants; undefined while it is closed. */
  menuRows: number | undefined;
}): HomeLayout {
  const fits = (header: Header, belowRows: number) =>
    HEADER_ROWS[header] + INPUT_ROWS + belowRows <= mainRows;
  const headerBeside = (belowRows: number): Header =>
    splashLogoFits(columns) && fits("logo", belowRows)
      ? "logo"
      : fits("line", belowRows)
        ? "line"
        : "none";
  if (menuRows !== undefined) {
    const header = headerBeside(menuRows);
    const left = mainRows - HEADER_ROWS[header] - INPUT_ROWS;
    return {
      header,
      below: "menu",
      menuRows: Math.max(1, Math.min(menuRows, left)),
    };
  }
  const header = headerBeside(0);
  return { header, below: fits(header, hintRows) ? "hints" : "nothing" };
}

interface Hint {
  name: string;
  text: string;
}

/** `/new`, `/help` when registered, and the first key bound to `panel.open` when a pinned entry can take it. */
function useHints(): Hint[] {
  const registry = useRegistry();
  const config = useConfig();
  const t = useMessages(shellMessages);
  const commandHints: [string, string][] = [
    ["new", t("hintNew")],
    ["help", t("hintHelp")],
  ];
  const hints = commandHints.flatMap(([name, text]) =>
    registry.command(name) ? [{ name: `/${name}`, text }] : [],
  );
  const panelKey = config.keybindings["panel.open"][0];
  if (panelKey !== undefined && registry.pinnedTabs.length > 0)
    hints.push({ name: hintKey(panelKey), text: t("hintPending") });
  return hints;
}

function Hints({ hints }: { hints: readonly Hint[] }) {
  const theme = useTheme();
  const nameColumns =
    Math.max(0, ...hints.map((hint) => stringWidth(hint.name))) + HINT_GAP;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {hints.map((hint) => (
        <Box key={hint.name}>
          <Box width={nameColumns} flexShrink={0}>
            <Text color={inkColor(theme.accent)}>{hint.name}</Text>
          </Box>
          <Text color={inkColor(theme.muted)} wrap="truncate-end">
            {hint.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function CommandMenu({
  matches,
  typed,
  selected,
  rows,
}: {
  matches: readonly SlashCommand[];
  typed: string;
  selected: number;
  rows: number;
}) {
  const locale = useLocale();
  const entries: MenuEntry[] = matches.map((command) => {
    const name = `/${command.name}`;
    return {
      key: command.name,
      name,
      bold: typedRanges(name, typed),
      detail: localize(command.summary, locale),
    };
  });
  return <CompletionMenu entries={entries} selected={selected} rows={rows} />;
}

/** The command input between its two rules. */
function CommandInput({
  value,
  onChange,
  onSubmit,
  onTab,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (line: string) => void;
  onTab: () => void;
}) {
  const theme = useTheme();
  return (
    <Box
      flexShrink={0}
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={inkColor(theme.border)}
    >
      <Text color={inkColor(theme.accent)}>{PROMPT}</Text>
      <LineInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onEscape={() => onChange("")}
        onTab={onTab}
      />
    </Box>
  );
}

/**
 * What the main area shows with no tab in front, from the top: the splash, the command input
 * between two rules, and under it the hints, or the completion menu while a command name is
 * typed. The space left stays empty under them.
 */
export function Home({
  url,
  temporary,
  version,
}: {
  url: string;
  temporary: boolean;
  version: string;
}) {
  const ctx = useShell();
  const registry = useRegistry();
  const theme = useTheme();
  const t = useMessages(shellMessages);
  const { columns, rows } = useWindowSize();
  const hints = useHints();
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);

  const prefix = namePrefix(value);
  const matches = prefix === undefined ? [] : registry.complete(prefix);
  const shownSelected = Math.min(selected, Math.max(0, matches.length - 1));
  const menuOpen = matches.length > 0;

  const change = (next: string) => {
    setValue(next);
    setSelected(0);
  };
  const submit = (line: string) => {
    change("");
    if (line.trim() === "") return;
    if (line.startsWith("/")) void runCommandLine(line, registry, ctx);
    else ctx.notify(t("noConversation"));
  };
  const completeSelected = () => {
    const command = matches[shownSelected];
    if (command) change(`/${command.name} `);
  };

  // Left opens the rightmost pinned tab's panel, but only while there is nothing typed to edit;
  // useAction already stays off while this input does not receive keys.
  useAction("panel.open", () => ctx.selectPinnedTab(), {
    isActive: value === "",
  });
  const receiving = useInputActive();
  useInput(
    (_input, key) => {
      const step = key.upArrow ? -1 : key.downArrow ? 1 : 0;
      if (step === 0) return;
      setSelected((shownSelected + step + matches.length) % matches.length);
    },
    { isActive: receiving && menuOpen },
  );

  const layout = homeLayout({
    columns,
    mainRows: rows - SHELL_ROWS,
    hintRows: hints.length,
    menuRows: menuOpen ? Math.min(MENU_ROWS, matches.length) : undefined,
  });
  const hostLine = temporary
    ? t("hostLineTemporary", { url })
    : t("hostLine", { url });
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {layout.header === "logo" && (
        <Box marginBottom={1} flexShrink={0}>
          <SplashLogo
            version={version}
            detail={<Text color={inkColor(theme.muted)}>{hostLine}</Text>}
          />
        </Box>
      )}
      {layout.header === "line" && (
        <SplashLine version={version} detail={url} />
      )}
      <CommandInput
        value={value}
        onChange={change}
        onSubmit={submit}
        onTab={completeSelected}
      />
      {layout.below === "menu" && (
        <CommandMenu
          matches={matches}
          typed={prefix ?? ""}
          selected={shownSelected}
          rows={layout.menuRows}
        />
      )}
      {layout.below === "hints" && <Hints hints={hints} />}
    </Box>
  );
}
