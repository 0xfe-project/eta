import type { AttachmentView } from "@eta/client-contracts";
import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { MentionRef } from "@eta/client-contracts/composer-markdown";
import type { Bounds, ViewStyle } from "nsh";
import type { RichNodeJSON, RichNodeViewProps } from "nsh/base";
import type { ViewedPicture } from "../picture-viewer";
import type { EtaPlugin } from "./editor";
import type { StoredText } from "./markdown";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import { fileSize } from "@eta/client-contracts/composer-draft";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { computed, effect, Image, signal, untracked, View } from "nsh";
import { defineExtension } from "nsh/base";
import { uiText } from "../../i18n";
import { AttachmentFiles } from "../../services/attachment-files";
import { useHost } from "../../services/host";
import { PictureModes } from "../../services/picture-mode";
import { isPicture, useAttachmentPictures } from "../../services/pictures";
import { canHover } from "../menu";
import { Lightbox, picturePreview } from "../picture-viewer";
import { Label } from "../text";
import { colors, row } from "../theme";
import { Chip } from "./chip";
import { createEtaEditor, EtaEditor } from "./editor";
import { markdownToDoc } from "./markdown";
import { fileNode } from "./plugins/attachment";
import { mentionNode } from "./plugins/mention";
import { chatText } from "./systems";

// Text as it is shown (a message, a task's description, a routine's report): the chat's editor,
// read-only, so it looks exactly as it did while it was written. Its blocks do what they do where
// the text is read: a mention opens its member, a file saves, a picture opens, a folded paste
// unfolds, a code block copies. A message's files are not in its text (they go as attachments):
// they follow it, as chips on a line of their own or, for pictures in the expanded mode, as cards.

/** What a press on a picture's chip or card opens: the lightbox at that picture. */
type OpenPicture = (key: string) => void;

/** How long the pointer rests on a picture's chip before its thumbnail shows. */
const PREVIEW_DELAY = 300;

/** A picture's thumbnail on hover. */
const PREVIEW_SIZE = 248;

/** A picture card's width (the expanded mode), and the gap between cards. */
const CARD_WIDTH = 180;
const CARD_GAP = 8;

/** The selected text of shown text and where it is (in the root view), as a quote takes it. */
export interface ShownSelection {
  text: string;
  pageBounds?: Bounds | null;
}

/** A picture of shown text: one the message carries, or a Markdown image. */
interface ShownPicture extends ViewedPicture {
  load: () => void;
  /** "after.png": what the chip says. */
  name: string;
  /** "298.0 KB", where it is known. */
  size?: string;
}

/** A Markdown image's picture: its own URL. */
function urlPicture(src: string, alt: string): ShownPicture {
  const name = alt || uiText("pictureUnnamed");
  return {
    key: src,
    name,
    caption: name,
    src: () => src,
    failed: () => false,
    load: () => {},
  };
}

function PictureChip(props: {
  picture: ShownPicture;
  label: string;
  onOpen: OpenPicture;
}) {
  effect(() => props.picture.load());
  return (
    <Chip
      label={props.label}
      thumbnail={props.picture.src()}
      icon="file"
      cursor="zoom-in"
      tooltip={picturePreview(props.picture, PREVIEW_SIZE, PREVIEW_DELAY)}
      accessibilityLabel={
        props.picture.size
          ? uiText("openPicture", {
              name: props.label,
              size: props.picture.size,
            })
          : uiText("openPictureNamed", { name: props.label })
      }
      onPress={() => props.onOpen(props.picture.key)}
    />
  );
}

/** A message's file where it is shown: a picture opens, any other file saves. */
function FileChip(props: {
  view: RichNodeViewProps;
  picture: (file: AttachmentView) => ShownPicture;
  onOpen: OpenPicture;
}) {
  const files = AttachmentFiles();
  const file = (): AttachmentView => ({
    id: String(props.view.node.attrs.id),
    name: String(props.view.node.attrs.name),
    contentType: String(props.view.node.attrs.contentType),
    size: Number(props.view.node.attrs.size),
  });
  return (
    <If
      when={isPicture(file())}
      else={
        <Chip
          label={file().name}
          icon="file"
          detail={fileSize(file().size)}
          status={files?.busy() === file().id ? uiText("saving") : undefined}
          accessibilityLabel={uiText("saveFile", {
            name: file().name,
            size: fileSize(file().size),
          })}
          onPress={files ? () => void files.save(file()) : undefined}
        />
      }
    >
      <PictureChip
        picture={props.picture(file())}
        label={file().name}
        onOpen={props.onOpen}
      />
    </If>
  );
}

/** The pictures of the expanded mode: 180-wide cards under the text, in their order. */
function PictureCards(props: {
  pictures: readonly ShownPicture[];
  onOpen: OpenPicture;
}) {
  const c = colors();
  const room = signal(0);
  // Two to a row where two 180-wide cards do not fit (a phone): each takes half.
  const width = () =>
    room() && room() < CARD_WIDTH * 2 + CARD_GAP
      ? Math.max(96, Math.floor((room() - CARD_GAP) / 2))
      : CARD_WIDTH;
  return (
    <View
      onLayout={({ bounds }) => room.set(bounds.size.width)}
      style={{ ...row, flexWrap: "wrap", gap: CARD_GAP, paddingTop: 8 }}
    >
      <Each of={props.pictures} key={(picture) => picture.key}>
        {(picture) => {
          effect(() => picture().load());
          return (
            <View
              role="button"
              testID="picture-card"
              accessibilityLabel={
                picture().size
                  ? uiText("openPicture", {
                      name: picture().name,
                      size: picture().size!,
                    })
                  : uiText("openPictureNamed", { name: picture().name })
              }
              onPress={() => props.onOpen(picture().key)}
              hoverStyle={{ borderColor: c().strong }}
              style={{
                width: width(),
                flexShrink: 0,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
                cursor: "zoom-in",
              }}
            >
              <View
                style={{
                  height: 96,
                  backgroundColor: c().selected,
                  overflow: "hidden",
                }}
              >
                <If when={picture().src()}>
                  {(src) => (
                    <Image
                      src={src()}
                      fadeDuration={0}
                      style={{ width: "100%", height: 96, objectFit: "cover" }}
                    />
                  )}
                </If>
              </View>
              <View
                style={{
                  borderTopWidth: 1,
                  borderColor: c().border,
                  paddingVertical: 4,
                  paddingHorizontal: 6,
                }}
              >
                <Label variant="caption" tone="muted" lines={1}>
                  {picture().caption}
                </Label>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

const paragraph = (content: DocNode[]): DocNode => ({
  type: DOC_NODES.paragraph,
  content,
});

/** `doc` without its pictures, each found handed to `found`; a paragraph left empty goes. */
function withoutPictures(
  doc: DocNode,
  found: (node: DocNode) => void,
): DocNode | undefined {
  if (doc.type === DOC_NODES.picture) {
    found(doc);
    return undefined;
  }
  if (!doc.content) return doc;
  const had = doc.content.length;
  const content = doc.content.flatMap((child) => {
    const kept = withoutPictures(child, found);
    return kept ? [kept] : [];
  });
  if (doc.type === DOC_NODES.paragraph && had && !content.length)
    return undefined;
  return { ...doc, content };
}

/** What is shown: the text's document, the message's files after it, the cards' pictures. */
function shown(
  text: StoredText,
  files: readonly AttachmentView[],
  expanded: boolean,
): {
  doc: DocNode;
  cards: { src?: string; alt?: string; file?: AttachmentView }[];
} {
  let doc = text.text.trim()
    ? markdownToDoc(text, { pictures: true })
    : { type: DOC_NODES.doc, content: [] as DocNode[] };
  const cards: { src?: string; alt?: string; file?: AttachmentView }[] = [];
  if (expanded)
    doc =
      withoutPictures(doc, (node) =>
        cards.push({
          src: String(node.attrs?.src ?? ""),
          alt: String(node.attrs?.alt ?? ""),
        }),
      ) ?? doc;
  const chips = files.filter((file) => !expanded || !isPicture(file));
  for (const file of files)
    if (expanded && isPicture(file)) cards.push({ file });
  const content = [...(doc.content ?? [])];
  if (chips.length)
    content.push(
      paragraph(
        chips.flatMap((file, index) => [
          ...(index ? [{ type: DOC_NODES.text, text: " " }] : []),
          {
            type: DOC_NODES.file,
            attrs: {
              id: file.id,
              name: file.name,
              contentType: file.contentType,
              size: file.size,
            },
          },
        ]),
      ),
    );
  return {
    doc: {
      type: DOC_NODES.doc,
      content: content.length ? content : [{ type: DOC_NODES.paragraph }],
    },
    cards,
  };
}

/**
 * Text as kept (Markdown, with its pastes and mentions) shown with the chat's text system: the
 * editor, not editable, and on a touch screen not focusable. `files`: the files a message
 * carries, shown after it. Pictures follow Settings › Appearance › Images in messages.
 */
export function ShownText(props: {
  text: StoredText;
  label: string;
  files?: readonly AttachmentView[];
  variant?: "body" | "small";
  /** A mention's press: its member, by id. Without it a mention is only a name. */
  onMember?: (id: string) => void;
  onSelectionChange?: (selection: ShownSelection) => void;
  style?: ViewStyle;
}) {
  const modes = PictureModes();
  const attachmentPicture = useAttachmentPictures();
  const opened = signal<number>();
  const expanded = () => modes.mode() === "expanded";
  const view = computed(() => shown(props.text, props.files ?? [], expanded()));
  // One picture object per key, so a chip, a card and the lightbox read the same one.
  const known = new Map<string, ShownPicture>();
  const pictureOfFile = (file: AttachmentView): ShownPicture => {
    let picture = known.get(file.id);
    if (!picture) {
      const base = attachmentPicture(file);
      picture = { ...base, name: file.name, size: fileSize(file.size) };
      known.set(file.id, picture);
    }
    return picture;
  };
  const pictureOfUrl = (src: string, alt: string): ShownPicture => {
    let picture = known.get(src);
    if (!picture) {
      picture = urlPicture(src, alt);
      known.set(src, picture);
    }
    return picture;
  };
  /** Every picture, in the order the text shows them: the lightbox walks through these. */
  const pictures = computed(() => {
    const out: ShownPicture[] = [];
    const walk = (node: DocNode) => {
      if (node.type === DOC_NODES.picture)
        out.push(
          pictureOfUrl(
            String(node.attrs?.src ?? ""),
            String(node.attrs?.alt ?? ""),
          ),
        );
      else if (
        node.type === DOC_NODES.file &&
        isPicture({ contentType: String(node.attrs?.contentType ?? "") })
      )
        out.push(
          pictureOfFile({
            id: String(node.attrs?.id),
            name: String(node.attrs?.name),
            contentType: String(node.attrs?.contentType),
            size: Number(node.attrs?.size),
          }),
        );
      for (const child of node.content ?? []) walk(child);
    };
    walk(view().doc);
    for (const card of view().cards)
      out.push(
        card.file
          ? pictureOfFile(card.file)
          : pictureOfUrl(card.src ?? "", card.alt ?? ""),
      );
    return out;
  });
  const open: OpenPicture = (key) => {
    const at = pictures().findIndex((picture) => picture.key === key);
    if (at >= 0) opened.set(at);
  };
  const chips: EtaPlugin = {
    name: "shownBlocks",
    extensions: [
      mentionNode(props.onMember),
      fileNode((node) => (
        <FileChip view={node} picture={pictureOfFile} onOpen={open} />
      )),
      defineExtension({
        name: DOC_NODES.picture,
        node: {
          group: "inline",
          inline: true,
          atom: true,
          selectable: false,
          attrs: { src: { default: "" }, alt: { default: "" } },
          renderText: "{alt}",
        },
        addNodeView: () => (node: RichNodeViewProps) => (
          <PictureChip
            picture={pictureOfUrl(
              String(node.node.attrs.src),
              String(node.node.attrs.alt),
            )}
            label={String(node.node.attrs.alt) || uiText("pictureUnnamed")}
            onOpen={open}
          />
        ),
      }),
    ],
  };
  const editor = untracked(() =>
    createEtaEditor({
      plugins: [...chatText.plugins, chips],
      doc: view().doc,
    }),
  );
  editor.session.setEditable(false);
  // The text changed (a message edited, the mode switched): the same view shows the new one.
  let current = untracked(() => JSON.stringify(view().doc));
  effect(() => {
    const next = view().doc;
    const key = JSON.stringify(next);
    if (key === current) return;
    current = key;
    editor.session.setContent(next as RichNodeJSON);
  });
  function selected(selection: { from: number; to: number; empty: boolean }) {
    if (!props.onSelectionChange) return;
    if (selection.empty) {
      props.onSelectionChange({ text: "" });
      return;
    }
    const session = editor.session;
    const text = session.textBetween(selection.from, selection.to, "\n");
    const box = (pos: number) =>
      session.pageCoordsAtPos(pos) as {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
    const start = box(selection.from);
    const end = box(selection.to);
    const pageBounds =
      start && end
        ? {
            origin: { x: Math.min(start.x, end.x), y: start.y },
            size: {
              width: Math.max(1, Math.abs(end.x - start.x)),
              height: Math.max(start.height, end.y + end.height - start.y),
            },
          }
        : null;
    props.onSelectionChange({ text, pageBounds });
  }
  return (
    <View style={props.style}>
      <EtaEditor
        editor={editor}
        label={props.label}
        editable={false}
        focusable={canHover ? undefined : false}
        variant={props.variant}
        padding={{ top: 0, bottom: 0, left: 0, right: 0 }}
        onSelectionChange={props.onSelectionChange ? selected : undefined}
      />
      <If when={view().cards.length}>
        <PictureCards
          pictures={pictures().slice(pictures().length - view().cards.length)}
          onOpen={open}
        />
      </If>
      <Lightbox pictures={pictures} index={opened} onIndex={opened.set} />
    </View>
  );
}

/** Every agent as text names them (`@label`): the mentions of text not in a chat (a task's
 * description, a routine's report). */
export function useAgentMentions(): () => MentionRef[] {
  const host = useHost();
  return () => {
    const named = host.agents().map((agent) => ({
      id: agent.id,
      name: agent.name,
    }));
    return named.map((agent) => ({
      id: agent.id,
      label: mentionLabel(agent, named),
    }));
  };
}
