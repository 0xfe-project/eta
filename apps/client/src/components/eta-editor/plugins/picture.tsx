import type { TextViewInline } from "nsh/base";
import type { ShownPicture } from "../../picture-cards";
import type { ShownPart, TextPlugin } from "../plugin";
import { isPictureType } from "@eta/client-contracts";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import { fileSize } from "@eta/client-contracts/composer-draft";
import { computed, signal, Text } from "nsh";
import { uiText } from "../../../i18n";
import { Host } from "../../../services/host";
import { PictureModes } from "../../../services/picture-mode";
import { useAttachmentPictures } from "../../../services/pictures";
import { PictureCards, PictureChip } from "../../picture-cards";
import { Lightbox } from "../../picture-viewer";
import { someInline, swapInline } from "../view-source";

/** The custom node a picture is drawn as, where it was put (compact). */
const PICTURE = "etaPicture";

/**
 * Pictures where a text is shown: the files a message carried that are pictures, and the images
 * of its Markdown (`![after.png](…)`). Settings › Appearance › Images in messages, kept on the
 * device, says how: compact (the default), each is a chip with its name in its place, its
 * thumbnail when the pointer rests on it (desktops) and opening large on a press; expanded, the
 * text keeps no names and 180-wide cards go under it. A press opens the viewer, which walks
 * through all of the text's pictures. Only shown text follows the setting: an editor shows chips.
 */
export function pictures(): TextPlugin {
  return { name: "pictures", view: { shown: shownPictures } };
}

function shownPictures(): ShownPart {
  const modes = PictureModes();
  const host = Host();
  const ofFile = host ? useAttachmentPictures() : undefined;
  const expanded = () => modes.mode() === "expanded";
  const opened = signal<number>();
  // One picture per key, so a chip, a card and the viewer read the same one.
  const known = new Map<string, ShownPicture>();
  function pictureOf(node: TextViewInline): ShownPicture | undefined {
    if (node.type === "image") {
      const key = `image:${node.src}`;
      let picture = known.get(key);
      if (!picture) {
        const name = node.alt || node.title || uiText("pictureUnnamed");
        const src = node.src;
        picture = {
          key,
          name,
          caption: name,
          src: () => src,
          failed: () => false,
          load: () => {},
        };
        known.set(key, picture);
      }
      return picture;
    }
    if (node.type !== "custom" || node.name !== DOC_NODES.file)
      return undefined;
    const file = node.attributes ?? {};
    if (!isPictureType(file.contentType)) return undefined;
    const key = file.id ?? "";
    let picture = known.get(key);
    if (!picture) {
      const named = {
        id: key,
        name: file.name ?? "",
        size: Number(file.size ?? 0),
      };
      picture = {
        key,
        name: named.name,
        src: () => undefined,
        failed: () => false,
        load: () => {},
        ...ofFile?.(named),
        caption: `${named.name} · ${fileSize(named.size)}`,
      };
      known.set(key, picture);
    }
    return picture;
  }
  let all: () => ShownPicture[] = () => [];
  const open = (key: string) => {
    const at = all().findIndex((picture) => picture.key === key);
    if (at >= 0) opened.set(at);
  };
  return {
    // A Markdown image, or a file that is a picture.
    touches: ({ markdown, stands }) =>
      markdown.includes("![") ||
      stands.some(
        (stand) =>
          stand.type === DOC_NODES.file &&
          isPictureType(String(stand.attrs?.contentType ?? "")),
      ),
    document: (document) =>
      // Most texts have no pictures: they are left as they are.
      !someInline(document, (node) => !!pictureOf(node))
        ? document
        : swapInline(document, (node) => {
            const picture = pictureOf(node);
            if (!picture) return undefined;
            return expanded()
              ? []
              : [
                  {
                    type: "custom",
                    name: PICTURE,
                    attributes: { key: picture.key },
                    text: picture.name,
                  },
                ];
          }),
    renderCustom: {
      [PICTURE]: (node) => {
        const picture = known.get(node.attributes?.key ?? "");
        return picture ? (
          <PictureChip picture={picture} onOpen={() => open(picture.key)} />
        ) : (
          <Text>{node.text ?? ""}</Text>
        );
      },
    },
    after(read) {
      const list = computed(() => {
        const out: ShownPicture[] = [];
        someInline(read(), (node) => {
          const picture = pictureOf(node);
          if (picture && !out.includes(picture)) out.push(picture);
        });
        return out;
      });
      all = list;
      // Nothing is made for a text with no pictures.
      return (
        <If when={list().length > 0}>
          <If when={expanded()}>
            <PictureCards pictures={list()} onOpen={open} />
          </If>
          <Lightbox pictures={list} index={opened} onIndex={opened.set} />
        </If>
      );
    },
  };
}
