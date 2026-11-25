import type {
  MenuItem,
  MenuMember,
  MenuState,
  MenuTask,
} from "@eta/client-contracts/composer-menu";
import type { RichNodeViewProps } from "nsh/base";
import type { EtaEditorHandle } from "../editor";
import type { TextPlugin } from "../plugin";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import { buildMenu } from "@eta/client-contracts/composer-menu";
import { computed, effect, signal, untracked, View } from "nsh";
import {
  defineExtension,
  exitSuggestion,
  insertMention,
  replaceSuggestion,
  setSuggestionOpen,
  suggestion,
} from "nsh/base";
import { uiText } from "../../../i18n";
import { EmptyState } from "../../empty-state";
import { SmoothScroll } from "../../smooth-scroll";
import { Caption, Label } from "../../text";
import { colors, row } from "../../theme";
import { control, opacity, shadow, space, weight } from "../../tokens";
import { MentionChip } from "../chip";
import { standIn } from "../view-source";

const menuWidth = 300;
const listHeight = 224;

/** What may come right before `@` or `#`: a space, or a CJK or Latin punctuation mark. */
const PREFIXES = [
  " ",
  "\n",
  "，",
  "。",
  "！",
  "？",
  "、",
  "；",
  "：",
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
];
const KEYS = ["ArrowUp", "ArrowDown", "Enter", "Tab"];

function MentionView(props: RichNodeViewProps) {
  return (
    <MentionChip
      label={String(props.node.attrs.label)}
      selected={props.selected}
      accessibilityLabel={uiText("mention", {
        name: String(props.node.attrs.label),
      })}
    />
  );
}

/** Mentions where the text is shown: `@Opus` in blue; with `onOpen`, a press opens the member. */
function mentionView(onOpen?: (id: string) => void): TextPlugin["view"] {
  return {
    extensions: [standIn(DOC_NODES.mention)],
    renderCustom: {
      [DOC_NODES.mention]: (node, view) => {
        const label = node.attributes?.label ?? "";
        const id = node.attributes?.id ?? "";
        return (
          <MentionChip
            label={label}
            variant={view.variant}
            accessibilityLabel={uiText(onOpen ? "openMember" : "mention", {
              name: label,
            })}
            onPress={onOpen && id ? () => onOpen(id) : undefined}
          />
        );
      },
    },
  };
}

/** The mentions of a text that is only shown (a sent message): `onOpen` opens the member. */
export function shownMentions(onOpen?: (id: string) => void): TextPlugin {
  return { name: "mention", view: mentionView(onOpen) };
}

/**
 * `@` opens the list of members (and the project's files), `#` the board's tasks; picking one puts
 * a mention block in (`@Opus`, sent as the text `@Opus` plus its id in `mentions`), a file's path
 * or a task's number in as text. The list follows the caret (`coordsAtPos`); ↑ ↓ move in it, ⏎ or
 * Tab pick, Escape closes it. A list with nothing in it lets ⏎ through, so it sends.
 */
export function mention(options: {
  /** The members `@` offers; none: `@` offers files only. */
  members?: () => MenuMember[];
  files?: () => readonly string[];
  /** Asked for the project's files when `@` opens. */
  onFiles?: () => void;
  tasks?: () => readonly MenuTask[];
  groupId?: string;
  describe?: (item: MenuItem) => string;
  /** Laid out to the full width of the box (tablet) rather than under the caret. */
  wide?: () => boolean;
  /** Where the text is shown: a press on a mention opens its member, by id. */
  onOpen?: (id: string) => void;
}): TextPlugin {
  const menu = signal<
    (MenuState & { key: "mention" | "task"; from: number; to: number }) | null
  >(null);
  const index = signal(0);
  const anchor = signal(0);
  /** An `@` or `#` being typed that nothing matches: the list says so, and ⏎ still sends. */
  const missed = signal<{ key: "mention" | "task"; query: string } | null>(
    null,
  );
  let editor: EtaEditorHandle | undefined;
  const lastKeys = { mention: 0, task: 0 };
  const choices = () => menu()?.items ?? [];
  const selected = () => Math.min(index(), Math.max(0, choices().length - 1));
  function pick(item: MenuItem) {
    const current = menu();
    if (!editor || !current) return;
    const range = { from: current.from, to: current.to };
    if (item.kind === "member")
      editor.session.run(
        insertMention(range, item.memberId, item.label, DOC_NODES.mention),
      );
    else editor.session.run(replaceSuggestion(item.value, current.key));
    menu.set(null);
    editor.focus();
  }
  function read() {
    if (!editor) return;
    for (const key of ["mention", "task"] as const) {
      const state = editor.session.suggestion(key);
      if (!state?.active) continue;
      if (key === "mention") options.onFiles?.();
      const built = buildMenu({
        text: `${key === "mention" ? "@" : "#"}${state.query ?? ""}`,
        members: key === "mention" ? (options.members?.() ?? []) : [],
        files: key === "mention" ? (options.files?.() ?? []) : [],
        tasks: key === "task" ? (options.tasks?.() ?? []) : [],
        groupId: options.groupId,
        dismissed: false,
      });
      // The list says whether it has rows, so an empty one lets ⏎ send.
      if (state.open !== !!built)
        editor.session.run(setSuggestionOpen(!!built, key));
      const previous = menu();
      if (!built) {
        menu.set(null);
        missed.set({ key, query: state.query ?? "" });
        const at = editor.session.coordsAtPos(state.range.from) as {
          x: number;
        } | null;
        anchor.set(at?.x ?? 0);
        return;
      }
      missed.set(null);
      if (previous?.query !== built.query || previous.key !== key) index.set(0);
      menu.set({ ...built, key, from: state.range.from, to: state.range.to });
      const coords = editor.session.coordsAtPos(state.range.from) as {
        x: number;
      } | null;
      anchor.set(coords?.x ?? 0);
      if (state.keyCount !== lastKeys[key]) {
        lastKeys[key] = state.keyCount;
        const count = built.items.length;
        if (state.lastKey === "ArrowUp")
          index.set((selected() - 1 + count) % count);
        else if (state.lastKey === "ArrowDown")
          index.set((selected() + 1) % count);
        else if (state.lastKey === "Enter" || state.lastKey === "Tab") {
          const item = built.items[selected()];
          if (item) pick(item);
        }
      }
      return;
    }
    menu.set(null);
    missed.set(null);
  }
  return {
    name: "mention",
    view: mentionView(options.onOpen),
    editor: {
      extensions: [
        defineExtension({
          name: DOC_NODES.mention,
          node: {
            group: "inline",
            inline: true,
            atom: true,
            selectable: false,
            attrs: { id: { default: "" }, label: { default: "" } },
            renderText: "@{label}",
            parseDOM: [
              {
                tag: "span[data-eta=mention]",
                getAttrs: { id: "data-id", label: "data-label" },
              },
            ],
            toDOM: [
              "span",
              {
                "data-eta": "mention",
                "data-id": { attr: "id" },
                "data-label": { attr: "label" },
              },
            ],
          },
          addNodeView: () => MentionView,
        }),
        defineExtension({
          name: "mentionSuggestion",
          // Before the send key, so ⏎ picks while the list is open.
          priority: 1100,
          addProseMirrorPlugins: () => [
            suggestion({
              key: "mention",
              char: "@",
              allowedPrefixes: PREFIXES,
              captureKeys: KEYS,
            }),
            ...(options.tasks
              ? [
                  suggestion({
                    key: "task",
                    char: "#",
                    allowedPrefixes: PREFIXES,
                    captureKeys: KEYS,
                  }),
                ]
              : []),
          ],
        }),
      ],
      setup(handle) {
        editor = handle;
        const stop = handle.session.on("transaction", read);
        // Rows that arrive later (the project's files) refresh an open list.
        effect(() => {
          options.files?.();
          options.members?.();
          untracked(() => {
            if (menu()) read();
          });
        });
        return stop;
      },
      overlay: () => (
        <SuggestionList
          menu={menu}
          missed={missed}
          selected={selected}
          anchor={() =>
            // Under the `@`, kept inside the box.
            Math.max(-1, Math.min(anchor() - 12, (editor?.width() ?? 0) - 300))
          }
          wide={options.wide}
          describe={options.describe}
          onHover={(i) => index.set(i)}
          onPick={pick}
          onDismiss={() => {
            const current = menu()?.key ?? missed()?.key;
            if (current && editor) editor.session.run(exitSuggestion(current));
            missed.set(null);
          }}
        />
      ),
    },
  };
}

function SuggestionList(props: {
  menu: () => (MenuState & { key: string }) | null;
  missed: () => { key: "mention" | "task"; query: string } | null;
  selected: () => number;
  anchor: () => number;
  wide?: () => boolean;
  describe?: (item: MenuItem) => string;
  onHover: (index: number) => void;
  onPick: (item: MenuItem) => void;
  onDismiss: () => void;
}) {
  const c = colors();
  const open = computed(
    () => (props.menu()?.items.length ?? 0) > 0 || props.missed() !== null,
  );
  const missedText = () => {
    const missed = props.missed();
    if (!missed) return "";
    const query = missed.query.trim();
    if (missed.key === "task")
      return query
        ? uiText("noTaskSuggestionsMatch", { query })
        : uiText("noTaskSuggestions");
    return query ? uiText("noMentionsMatch", { query }) : uiText("noMentions");
  };
  const wide = () => props.wide?.() ?? false;
  return (
    <If when={open()}>
      <View
        role="listbox"
        accessibilityLabel={uiText("mentionAnAgent")}
        style={{
          position: "absolute",
          bottom: "100%",
          left: wide() ? -1 : props.anchor(),
          right: wide() ? -1 : undefined,
          // design-value: over the composer's own layers (its text, the send row), not the app's
          zIndex: 3,
          width: wide() ? undefined : menuWidth,
          maxWidth: wide() ? undefined : "100%",
          borderWidth: 1,
          borderColor: c().strong,
          backgroundColor: c().canvas,
          boxShadow: wide() ? undefined : [shadow.popover],
        }}
      >
        <Caption
          text={uiText(
            props.menu()?.kind === "hash" || props.missed()?.key === "task"
              ? "taskSuggestions"
              : "mentions",
          )}
          style={{
            paddingHorizontal: space[12],
            paddingTop: space[8],
            paddingBottom: space[4],
          }}
        />
        <SmoothScroll style={{ maxHeight: listHeight, flexShrink: 1 }}>
          <Each
            of={props.menu()?.items ?? []}
            key={(entry) => entry.kind + entry.value}
          >
            {(entry, i) => (
              <View
                role="option"
                accessibilityLabel={
                  entry().kind === "member"
                    ? uiText("mention", { name: entry().label })
                    : entry().value.trim()
                }
                accessibilityState={{ selected: props.selected() === i() }}
                onMouseEnter={() => props.onHover(i())}
                onPress={() => props.onPick(entry())}
                hoverStyle={
                  props.selected() === i()
                    ? undefined
                    : { backgroundColor: c().selected }
                }
                style={{
                  ...row,
                  height: control.md,
                  paddingHorizontal: space[12],
                  gap: space[8],
                  cursor: "pointer",
                  backgroundColor:
                    props.selected() === i() ? c().ink : "transparent",
                }}
              >
                <Label
                  variant="small"
                  weight={weight.strong}
                  lines={1}
                  tone={props.selected() === i() ? "canvas" : "ink"}
                >
                  {entry().value.trim()}
                </Label>
                <Label
                  variant="small"
                  lines={1}
                  tone={props.selected() === i() ? "canvas" : "muted"}
                  style={{
                    opacity: props.selected() === i() ? opacity.muted : 1,
                  }}
                >
                  {props.describe?.(entry()) ?? ""}
                </Label>
              </View>
            )}
          </Each>
        </SmoothScroll>
        <If when={!props.menu() && props.missed()}>
          <EmptyState
            size="menu"
            status="empty"
            loading={null}
            error={null}
            empty={{ title: missedText() }}
            announce
            style={{ paddingHorizontal: space[12] }}
          />
        </If>
      </View>
    </If>
  );
}
