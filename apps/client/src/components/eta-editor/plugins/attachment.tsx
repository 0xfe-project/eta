import type { UploadState } from "@eta/client-contracts/composer-doc";
import type { RichNodeViewProps } from "nsh/base";
import type { EtaEditorHandle, EtaPlugin } from "../editor";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@eta/client-contracts";
import { DOC_NODES, docToDraft } from "@eta/client-contracts/composer-doc";
import { fileSize } from "@eta/client-contracts/composer-draft";
import { Picker } from "nsh";
import { defineExtension, insertContent } from "nsh/base";
import { uiText } from "../../../i18n";
import { Chip } from "../chip";
import { oneStep } from "../step";

/** Where a place's attachments go: the upload queue and each file's state, by block id. */
export interface Uploads {
  state: (id: string) => UploadState | undefined;
  /** Uploads `file` as the attachment `id` (queued after the uploads before it); with `error`, it
   * is refused before uploading and shows why. */
  start: (id: string, file: File, error?: string) => void;
  /** Uploads a failed one again; false when its bytes are gone (it was not this session's). */
  retry: (id: string) => boolean;
  /** A picture of an image file, while the app has its bytes. */
  thumbnail: (id: string) => string | undefined;
}

const isImage = (type: string) => type.startsWith("image/");

function FileView(input: { view: RichNodeViewProps; uploads: Uploads }) {
  const props = input.view;
  const uploads = input.uploads;
  const id = () => String(props.node.attrs.id);
  const name = () => String(props.node.attrs.name);
  const image = () => isImage(String(props.node.attrs.contentType));
  const state = () => uploads.state(id());
  const failure = () => {
    const current = state();
    return current?.state === "failed" ? current : undefined;
  };
  const status = () => {
    const current = state();
    if (!current) return uiText("uploadLost");
    if (current.state === "uploading") return uiText("uploading");
    if (current.state === "failed")
      return uiText(current.retry ? "uploadFailedRetry" : "uploadRefused");
    return fileSize(current.attachment.size);
  };
  return (
    <Chip
      kind={uiText(image() ? "imageKind" : "fileKind")}
      label={name()}
      thumbnail={image() ? uploads.thumbnail(id()) : undefined}
      status={status()}
      tone={state()?.state === "failed" || !state() ? "red" : "ink"}
      tooltip={failure()?.error}
      dim={state()?.state === "uploading"}
      selected={props.selected}
      accessibilityLabel={
        failure()?.retry
          ? uiText("retryUpload", { name: name() })
          : uiText(image() ? "imageKindNamed" : "fileKindNamed", {
              name: name(),
            })
      }
      onPress={() => {
        if (failure()?.retry) uploads.retry(id());
      }}
      removeLabel={uiText("removeAttachment", { name: name() })}
      onRemove={() => props.deleteNode()}
    />
  );
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
 * upload is kept until the message goes, so nothing uploads twice).
 */
export function attachment(options: {
  uploads: Uploads;
  /** Refuses new files (an archived chat). */
  blocked?: () => boolean;
}): EtaPlugin & { pick: (editor: EtaEditorHandle) => Promise<void> } {
  const { uploads } = options;
  function insert(files: File[], editor: EtaEditorHandle) {
    if (options.blocked?.()) return true;
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
          <FileView view={props} uploads={uploads} />
        ),
      }),
    ],
    files: insert,
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
            item.file ??
            refusedFile(
              item.name,
              uiText("composerFileTooLarge", { name: item.name }),
            ),
        ),
        editor,
      );
      editor.focus();
    },
  };
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
  if (file.size > MAX_ATTACHMENT_BYTES)
    return uiText("composerFileTooLarge", { name: file.name });
  return undefined;
}
