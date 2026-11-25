import type { UploadState } from "@eta/client-contracts/composer-doc";
import type { Signal } from "nsh";
import type { RichNodeViewProps } from "nsh/base";
import type { EtaEditorHandle } from "../editor";
import type { TextPlugin } from "../plugin";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@eta/client-contracts";
import { DOC_NODES, docToDraft } from "@eta/client-contracts/composer-doc";
import { fileSize } from "@eta/client-contracts/composer-draft";
import { computed, effect, Picker, signal } from "nsh";
import { defineExtension, insertContent } from "nsh/base";
import { uiText } from "../../../i18n";
import { AttachmentFiles } from "../../../services/attachment-files";
import { Host } from "../../../services/host";
import {
  isPicture,
  fileSize as pictureSize,
  useAttachmentPictures,
} from "../../../services/pictures";
import { problemText } from "../../../services/problem-text";
import { hint } from "../../controls";
import { Lightbox, picturePreview } from "../../picture-viewer";
import { colors } from "../../theme";
import { showToast } from "../../toast";
import { isBmp, pastedFile } from "../bmp-to-png";
import { Chip } from "../chip";
import { oneStep } from "../step";
import { standIn } from "../view-source";

/** Where a place's attachments go: the upload queue and each file's state, by block id. */
export interface Uploads {
  state: (id: string) => UploadState | undefined;
  /** Fraction `0..1` while uploading, when known. */
  progress?: (id: string) => number | undefined;
  /** Uploads `file` as the attachment `id` (queued after the uploads before it); with `error`, it
   * is refused before uploading and shows why. */
  start: (id: string, file: File, error?: string) => void;
  /** Uploads a failed one again; false when its bytes are gone (it was not this session's). */
  retry: (id: string) => boolean;
  /** A picture of an image file, while the app has its bytes. */
  thumbnail: (id: string) => string | undefined;
}

const isImage = (type: string) => type.startsWith("image/");

/** Why a file over the size limit cannot go. */
export const tooLarge = (name: string) =>
  uiText("composerFileTooLarge", {
    name,
    limit: `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
  });

function FileView(input: {
  view: RichNodeViewProps;
  uploads: Uploads;
  onOpen: (id: string) => void;
}) {
  const props = input.view;
  const uploads = input.uploads;
  const c = colors();
  const pictureOf = useAttachmentPictures();
  const id = () => String(props.node.attrs.id);
  const name = () => String(props.node.attrs.name);
  const image = () => isImage(String(props.node.attrs.contentType));
  const state = () => uploads.state(id());
  const failure = () => {
    const current = state();
    return current?.state === "failed" ? current : undefined;
  };
  /** An uploaded picture: it previews on hover and opens in the lightbox on a press (#735). */
  const picture = () => {
    const current = state();
    return image() && current?.state === "done" && isPicture(current.attachment)
      ? pictureOf(current.attachment)
      : undefined;
  };
  effect(() => picture()?.load());
  /** Uploading, failed: said after the name. A done file says its size; a picture says it on hover. */
  const status = () => {
    const current = state();
    if (!current) return uiText("uploadLost");
    if (current.state === "uploading") return uiText("uploading");
    if (current.state === "failed")
      return uiText(current.retry ? "uploadFailedRetry" : "uploadRefused");
    return undefined;
  };
  const size = () => {
    const current = state();
    return current?.state === "done" ? fileSize(current.attachment.size) : "";
  };
  return (
    <Chip
      label={name()}
      icon={image() ? undefined : "file"}
      thumbnail={image() ? uploads.thumbnail(id()) : undefined}
      detail={image() ? undefined : size() || undefined}
      status={status()}
      tone={state()?.state === "failed" || !state() ? "red" : "ink"}
      tooltip={(() => {
        const shown = picture();
        // Why it failed, drawn (a bare string tooltip draws nothing on the web).
        return shown ? picturePreview(shown, 248) : hint(failure()?.error, c);
      })()}
      cursor={picture() ? "zoom-in" : failure() ? "pointer" : undefined}
      dim={state()?.state === "uploading"}
      progress={
        state()?.state === "uploading"
          ? (uploads.progress?.(id()) ?? 0)
          : undefined
      }
      selected={props.selected}
      accessibilityLabel={(() => {
        const current = state();
        if (failure()?.retry) return uiText("retryUpload", { name: name() });
        if (failure())
          return uiText("attachRefusedWhy", {
            name: name(),
            reason: failure()!.error,
          });
        if (picture() && current?.state === "done")
          return uiText("openPicture", {
            name: name(),
            size: pictureSize(current.attachment.size),
          });
        return uiText(image() ? "imageKindNamed" : "fileKindNamed", {
          name: name(),
        });
      })()}
      onPress={() => {
        const failed = failure();
        if (failed?.retry) uploads.retry(id());
        // Refused before uploading: a press says why (a touch screen has no hover).
        else if (failed)
          showToast({
            title: uiText("attachRefused", { name: name() }),
            body: failed.error,
            tone: "red",
          });
        else if (picture()) input.onOpen(id());
      }}
      removeLabel={uiText("removeAttachment", { name: name() })}
      onRemove={() => props.deleteNode()}
    />
  );
}

/** A file sent with a text, where the text is shown: its name and size, a sent picture's
 * thumbnail (pressed, it opens large). */
function ShownFileChip(props: {
  file: { id: string; name: string; contentType: string; size: number };
}) {
  const host = Host();
  const pictureOf = host ? useAttachmentPictures() : undefined;
  const open = signal(false);
  const image = () => isImage(props.file.contentType);
  const picture = computed(() =>
    image() && pictureOf && isPicture(props.file)
      ? pictureOf(props.file)
      : undefined,
  );
  effect(() => picture()?.load());
  return (
    <>
      <Chip
        label={props.file.name}
        icon={picture()?.src() ? undefined : "file"}
        thumbnail={picture()?.src()}
        detail={image() ? undefined : fileSize(props.file.size)}
        tooltip={(() => {
          const shown = picture();
          return shown ? picturePreview(shown, 248) : undefined;
        })()}
        cursor={picture() ? "zoom-in" : undefined}
        accessibilityLabel={
          picture()
            ? uiText("openPicture", {
                name: props.file.name,
                size: pictureSize(props.file.size),
              })
            : uiText(image() ? "imageKindNamed" : "fileKindNamed", {
                name: props.file.name,
              })
        }
        onPress={picture() ? () => open.set(true) : undefined}
      />
      <If when={picture()}>
        {(shown) => (
          <Lightbox
            pictures={() => [shown()]}
            index={() => (open() ? 0 : undefined)}
            onIndex={(at) => open.set(at !== undefined)}
          />
        )}
      </If>
    </>
  );
}

/** A file (not a picture) sent with a text, where the text is shown: its name and size; a press
 * saves the host's copy (the share sheet, the app's storage, or a browser's download). */
function SavedFileChip(props: {
  file: { id: string; name: string; contentType: string; size: number };
}) {
  const files = AttachmentFiles();
  return (
    <Chip
      label={props.file.name}
      icon="file"
      detail={fileSize(props.file.size)}
      status={files?.busy() === props.file.id ? uiText("saving") : undefined}
      accessibilityLabel={uiText("saveFile", {
        name: props.file.name,
        size: fileSize(props.file.size),
      })}
      onPress={files ? () => void files.save(props.file) : undefined}
    />
  );
}

const attachmentView: TextPlugin["view"] = {
  extensions: [standIn(DOC_NODES.file)],
  renderCustom: {
    [DOC_NODES.file]: (node) => {
      const file = {
        id: node.attributes?.id ?? "",
        name: node.attributes?.name ?? "",
        contentType: node.attributes?.contentType ?? "",
        size: Number(node.attributes?.size ?? 0),
      };
      // A picture is the `pictures` plugin's where the system has it.
      return isPicture(file) ? (
        <ShownFileChip file={file} />
      ) : (
        <SavedFileChip file={file} />
      );
    },
  },
};

/** The files of a text shown, with no editor: what `attachment` shows, for a place that only
 * shows texts (sent messages). A file saves on a press; a picture is the `pictures` plugin's. */
export function shownFiles(): TextPlugin {
  return { name: "attachment", view: attachmentView };
}

/** How many attachment blocks the document holds. */
function attachmentCount(editor: EtaEditorHandle) {
  return docToDraft(editor.doc()).draft.filter((part) => part.type === "file")
    .length;
}

/**
 * Files and pictures — pasted, dropped, or picked with ＋ — go in where the caret is as one block
 * each ("image · shot.png", "file · notes.pdf") and upload at once. The block shows the upload:
 * uploading, failed (press to retry), done. Backspace or × takes it out, undo brings it back (its
 * upload is kept until the message goes, so nothing uploads twice). Shown, the files that went with
 * a text come after it as the same blocks, a picture opening large.
 */
export function attachment(options: {
  uploads: Uploads;
  /** Refuses new files (an archived chat). */
  blocked?: () => boolean;
}): TextPlugin & { pick: (editor: EtaEditorHandle) => Promise<void> } {
  const { uploads } = options;
  /** The lightbox's picture, by its block id. */
  const open = signal<string>();
  let handle: EtaEditorHandle | undefined;
  function insert(files: File[], editor: EtaEditorHandle) {
    if (options.blocked?.()) return true;
    // A Windows screenshot comes as a BMP, which neither the models nor Chromium take.
    if (files.some(isBmp)) {
      void Promise.all(
        files.map((file) =>
          pastedFile(file).catch((error: unknown) =>
            refusedFile(file.name, problemText(error)),
          ),
        ),
      ).then((converted) => place(converted, editor));
      return true;
    }
    return place(files, editor);
  }
  function place(files: File[], editor: EtaEditorHandle) {
    const room = MAX_ATTACHMENTS - attachmentCount(editor);
    const nodes = files.map((file, index) => {
      const id = crypto.randomUUID();
      uploads.start(id, file, refusal(file, index, room));
      return {
        type: DOC_NODES.file,
        attrs: {
          id,
          name: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        },
      };
    });
    if (nodes.length) editor.session.run(oneStep(insertContent(nodes)));
    return true;
  }
  return {
    name: "attachment",
    view: attachmentView,
    editor: {
      extensions: [
        defineExtension({
          name: DOC_NODES.file,
          node: {
            group: "inline",
            inline: true,
            atom: true,
            selectable: true,
            attrs: {
              id: { default: "" },
              name: { default: "" },
              contentType: { default: "" },
              size: { default: 0 },
            },
            renderText: "[{name}]",
            parseDOM: [
              {
                tag: "span[data-eta=file]",
                getAttrs: {
                  id: "data-id",
                  name: "data-name",
                  contentType: "data-type",
                  size: "data-size",
                },
              },
            ],
            toDOM: [
              "span",
              {
                "data-eta": "file",
                "data-id": { attr: "id" },
                "data-name": { attr: "name" },
                "data-type": { attr: "contentType" },
                "data-size": { attr: "size" },
              },
            ],
          },
          addNodeView: () => (props: RichNodeViewProps) => (
            <FileView view={props} uploads={uploads} onOpen={open.set} />
          ),
        }),
      ],
      files: insert,
      setup(editor) {
        handle = editor;
      },
      overlay: () => (
        <PictureLightbox
          ids={() => {
            handle?.revision();
            return handle
              ? docToDraft(handle.doc())
                  .draft.filter((part) => part.type === "file")
                  .map((part) => part.id)
              : [];
          }}
          uploads={uploads}
          open={open}
        />
      ),
      paste(action, editor) {
        if (action.kind !== "textFile") return false;
        return insert(
          [
            new File([action.text], uiText("pastedFile"), {
              type: "text/plain;charset=utf-8",
            }),
          ],
          editor,
        );
      },
    },
    async pick(editor) {
      if (options.blocked?.()) return;
      const chosen = await Picker.pickFiles({
        multiple: true,
        maxSize: MAX_ATTACHMENT_BYTES,
      });
      insert(
        chosen.map(
          (item) =>
            // Over the size limit the picker gives no bytes: the block says why.
            item.file ?? refusedFile(item.name, tooLarge(item.name)),
        ),
        editor,
      );
      editor.focus();
    },
  };
}

/** The draft's uploaded pictures over the window, the one pressed first; arrows walk the rest. */
function PictureLightbox(props: {
  ids: () => string[];
  uploads: Uploads;
  open: Signal<string | undefined>;
}) {
  const pictureOf = useAttachmentPictures();
  const pictures = computed(() =>
    props.ids().flatMap((id) => {
      const current = props.uploads.state(id);
      return current?.state === "done" && isPicture(current.attachment)
        ? [pictureOf(current.attachment)]
        : [];
    }),
  );
  const index = () => {
    const id = props.open();
    if (id === undefined) return undefined;
    const at = pictures().findIndex((picture) => picture.key === id);
    return at < 0 ? undefined : at;
  };
  return (
    <Lightbox
      pictures={pictures}
      index={index}
      onIndex={(at) =>
        props.open.set(at === undefined ? undefined : pictures()[at]?.key)
      }
    />
  );
}

const refused = new WeakMap<File, string>();

/** A file that cannot go (unreadable, too large to read): its block shows `error`. */
export function refusedFile(name: string, error: string): File {
  const file = new File([], name);
  refused.set(file, error);
  return file;
}

/** Why a file cannot go, before uploading it; nothing when it can. */
function refusal(file: File, index: number, room: number): string | undefined {
  const error = refused.get(file);
  if (error) return error;
  if (index >= room)
    return uiText("attachmentCountLimit", { count: MAX_ATTACHMENTS });
  if (file.size > MAX_ATTACHMENT_BYTES) return tooLarge(file.name);
  return undefined;
}
