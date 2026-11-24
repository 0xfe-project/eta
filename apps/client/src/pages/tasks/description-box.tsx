import type { MenuMember } from "@eta/client-contracts/composer-menu";
import type { ViewStyle } from "nsh";
import type { EtaEditorHandle } from "../../components/eta-editor/editor";
import { docText } from "@eta/client-contracts/composer-doc";
import { sameDoc } from "@eta/client-contracts/composer-markdown";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { signal, untracked, View } from "nsh";
import { colors, Label, row } from "../../components";
import {
  descriptionText,
  limit,
  mention,
  submitKeys,
} from "../../components/eta-editor";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** The longest description the forms take. */
const DESCRIPTION_MAX = 20_000;

/** A count with its thousands apart: 20 000. */
const grouped = (count: number) =>
  String(count).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** The description being written: its editor and what the form reads from it. */
export interface Description {
  editor: EtaEditorHandle;
  /** The description as Markdown, to keep: the text it started with when nothing was changed. */
  read: () => string;
  /** Characters written. */
  count: () => number;
  /** Over `DESCRIPTION_MAX`: the form does not take it. */
  tooLong: () => boolean;
}

/**
 * The agents `@` offers in a description, by the names it writes: `members` first (a task's own),
 * then the others.
 */
function useAgents(first?: () => readonly string[]) {
  const host = useHost();
  return (): MenuMember[] => {
    const own = new Set(first?.() ?? []);
    const agents = host.agents();
    const ordered = [
      ...agents.filter((agent) => own.has(agent.id)),
      ...agents.filter((agent) => !own.has(agent.id)),
    ].map((agent) => ({ id: agent.id, name: agent.name, busy: false }));
    return ordered.map((member) => ({
      ...member,
      name: mentionLabel(member, ordered),
    }));
  };
}

/**
 * A task's description in the WYSIWYG editor: Markdown as you type, ⌘B / ⌘I / ⌘E, `@` an agent.
 * ⏎ is a new line; ⌘⏎ is `onSubmit` (the form's own button). The text is read as Markdown and kept
 * as Markdown; a mention is kept as its `@name`, as the agent reads it. A description opened and
 * not changed is kept as it was written, byte for byte.
 */
export function createDescription(options: {
  /** The description as kept (Markdown). */
  text: string;
  /** The task's own agents, offered first. */
  agents?: () => readonly string[];
  onSubmit?: () => void;
}): Description {
  const limits = limit(DESCRIPTION_MAX);
  const count = signal(0);
  const members = useAgents(options.agents);
  const editor = descriptionText.createEditor({
    text: { text: options.text },
    plugins: [
      submitKeys({ enter: "newline", onSubmit: () => options.onSubmit?.() }),
      mention({ members, describe: () => uiText("mentionInDescription") }),
      limits,
      {
        name: "count",
        editor: {
          setup(handle) {
            const measure = () => count.set(docText(handle.doc()).length);
            measure();
            return handle.onChange(measure);
          },
        },
      },
    ],
  });
  const first = untracked(() => editor.doc());
  return {
    editor,
    count,
    tooLong: limits.tooLong,
    read() {
      const doc = editor.doc();
      if (sameDoc(doc, first)) return options.text;
      return descriptionText.write(doc).text.trim();
    },
  };
}

/** The box, and the line under it. */
const boxHeight = { phone: 200, regular: 240 } as const;
const footHeight = 28;

/**
 * The description box of a form (new task, a draft's confirmation, editing a task): a fixed
 * 240 high (200 on a phone) that scrolls inside, a line under it with the Markdown it takes and
 * the count. No toolbar.
 */
export function DescriptionBox(props: {
  description: Description;
  label: string;
  placeholder?: string;
  phone: boolean;
  autoFocus?: boolean;
  style?: ViewStyle;
}) {
  const c = colors();
  const editor = props.description.editor;
  const height = () => (props.phone ? boxHeight.phone : boxHeight.regular);
  const foot = footHeight;
  return (
    <View
      style={{
        height: height(),
        borderWidth: 1,
        borderColor: editor.focused() ? c().ink : c().strong,
        backgroundColor: c().canvas,
        flexShrink: 0,
        ...props.style,
      }}
    >
      <descriptionText.Editor
        editor={editor}
        label={props.label}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        variant="body"
        clip
        minHeight={height() - foot - 2}
        maxHeight={height() - foot - 2}
        padding={{
          top: space[8],
          bottom: space[8],
          left: space[12],
          right: space[12],
        }}
        style={{ flexShrink: 0 }}
      />
      <View
        style={{
          ...row,
          height: foot,
          flexShrink: 0,
          gap: space[8],
          paddingHorizontal: space[12],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label variant="caption" tone="faint" lines={1} style={{ flex: 1 }}>
          {uiText("descriptionMarkdownHint")}
        </Label>
        <Label
          variant="caption"
          tone={props.description.tooLong() ? "warning" : "faint"}
        >
          {`${grouped(props.description.count())} / ${grouped(DESCRIPTION_MAX)}`}
        </Label>
      </View>
    </View>
  );
}
