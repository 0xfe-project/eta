import type { SkillFileContent } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { TextViewBlock, TextViewInline } from "nsh/base";
import { cleanup, computed, effect, Image, signal, View } from "nsh";
import { TextView } from "nsh/base";
import {
  colors,
  fontFamily,
  Fonts,
  Label,
  monoFontFamily,
  textFaces,
  textStyle,
} from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";

export type SkillReadingPosition =
  | { kind: "offset"; y: number }
  | { kind: "heading"; heading: string };

export function skillFileLink(
  file: string,
  url: string,
): { path: string; heading?: string } | undefined {
  const hash = url.indexOf("#");
  const relative = hash < 0 ? url : url.slice(0, hash);
  const path = relative
    ? skillRelativeFile(file, relative)
    : hash < 0
      ? undefined
      : file;
  if (!path) return;
  try {
    const heading =
      hash < 0
        ? undefined
        : decodeURIComponent(url.slice(hash + 1)).normalize("NFC");
    return { path, heading };
  } catch {
    return undefined;
  }
}

/** An image file, shown whole in this box. */
const imageHeight = 300;

const markerName = "skill-heading-anchor";
const linkName = "skill-keyboard-link";

function keyboardLinks(
  content: TextViewInline[],
  path: string,
): TextViewInline[] {
  return content.flatMap((inline): TextViewInline[] => {
    if (inline.type === "link") {
      if (!/^https?:\/\//i.test(inline.url) && !skillFileLink(path, inline.url))
        return [inline];
      const name = TextView.plainText({
        blocks: [{ type: "paragraph", content: inline.content }],
      });
      // TextView reports pointer presses, but its inline text links cannot take focus.
      // Keep the original runs for selection and line wrapping, and add a focus target beside them.
      return [
        {
          type: "custom",
          name: linkName,
          attributes: {
            url: inline.url,
            label: name || inline.title || inline.url,
          },
        },
        inline,
      ];
    }
    return "content" in inline && inline.content
      ? [{ ...inline, content: keyboardLinks(inline.content, path) }]
      : [inline];
  });
}

function prepareBlocks(
  blocks: TextViewBlock[],
  path: string,
  headings: Set<string>,
): TextViewBlock[] {
  return blocks.map((block): TextViewBlock => {
    switch (block.type) {
      case "paragraph":
        return { ...block, content: keyboardLinks(block.content, path) };
      case "heading": {
        const content = keyboardLinks(block.content, path);
        if (!block.anchor) return { ...block, content };
        const heading = block.anchor.normalize("NFC");
        headings.add(heading);
        return {
          ...block,
          content: [
            { type: "custom", name: markerName, attributes: { heading } },
            ...content,
          ],
        };
      }
      case "blockquote":
        return {
          ...block,
          children: prepareBlocks(block.children, path, headings),
        };
      case "details":
        return {
          ...block,
          summary: keyboardLinks(block.summary, path),
          children: prepareBlocks(block.children, path, headings),
        };
      case "list":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            children: prepareBlocks(item.children, path, headings),
          })),
        };
      case "table": {
        const markCells = (cells: typeof block.head) =>
          cells.map((cell) => ({
            ...cell,
            content: keyboardLinks(cell.content, path),
          }));
        return {
          ...block,
          head: markCells(block.head),
          rows: block.rows?.map(markCells),
        };
      }
      default:
        return block;
    }
  });
}

function SkillKeyboardLink(props: {
  url: string;
  label: string;
  onLink: (url: string, focusTarget?: ViewRef) => void;
}) {
  const c = colors();
  let focusTarget: ViewRef | undefined;
  return (
    <View style={{ width: 0, height: 0, overflow: "visible" }}>
      <View
        role="link"
        ref={(view) => {
          focusTarget = view;
        }}
        focusable
        accessibilityLabel={props.label}
        onPress={() => props.onLink(props.url, focusTarget)}
        focusVisibleStyle={{ backgroundColor: c().blue }}
        style={{
          position: "absolute",
          width: space[2],
          height: space[16],
          left: -3,
          top: -14,
          pointerEvents: "none",
        }}
      />
    </View>
  );
}

function SkillHeadingMarker(props: {
  heading: string;
  position?: SkillReadingPosition;
  onHeading: (anchor: ViewRef, isCurrent: () => boolean) => void;
}) {
  const marker = signal<ViewRef>();
  effect(() => {
    const position = props.position;
    const anchor = marker();
    if (
      !anchor ||
      position?.kind !== "heading" ||
      position.heading !== props.heading
    )
      return;
    let current = true;
    cleanup(() => {
      current = false;
    });
    props.onHeading(anchor, () => current);
  });
  return <View ref={marker.set} style={{ width: 0, height: 0 }} />;
}

function skillRelativeFile(file: string, raw: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(raw.split("#", 1)[0]!);
  } catch {
    return;
  }
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    /[\\?]/.test(path) ||
    Array.from(path).some((part) => part.charCodeAt(0) < 32)
  )
    return;
  const parts = file.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

function SkillMarkdownImage(props: {
  path: string;
  alt?: string;
  read: (path: string) => Promise<SkillFileContent>;
}) {
  const image = signal<Extract<SkillFileContent, { kind: "image" }>>();
  effect(() => {
    const path = props.path;
    const read = props.read;
    let active = true;
    cleanup(() => {
      active = false;
    });
    image.set(undefined);
    void read(path)
      .then((content) => {
        if (active && content.kind === "image") image.set(content);
      })
      .catch(() => {});
  });
  return (
    <If
      when={image()}
      else={
        <Label variant="small" tone="muted">
          {props.alt || uiText("imageUnavailable")}
        </Label>
      }
    >
      {(content) => (
        <Image
          accessibilityLabel={props.alt}
          src={`data:${content().mime};base64,${content().base64}`}
          style={{
            width: "100%",
            height: Math.min(280, content().height),
            objectFit: "contain",
          }}
        />
      )}
    </If>
  );
}

export function SkillFile(props: {
  content: SkillFileContent;
  path: string;
  position?: SkillReadingPosition;
  onLink: (url: string, focusTarget?: ViewRef) => void;
  onOffset: (y: number) => void;
  onHeading: (anchor: ViewRef, isCurrent: () => boolean) => void;
  read: (path: string) => Promise<SkillFileContent>;
}) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const text = () =>
    props.content.kind === "text"
      ? (props.content.preview?.body ?? props.content.text)
      : props.content.kind === "unsupported"
        ? props.content.reason
        : "";
  const image = () =>
    props.content.kind === "image"
      ? `data:${props.content.mime};base64,${props.content.base64}`
      : "";
  const markdown = computed(() => {
    if (
      props.content.kind !== "text" ||
      !/\.(?:md|markdown)$/i.test(props.path)
    )
      return;
    const parsed = TextView.parse(text(), { html: false });
    const headings = new Set<string>();
    const document = {
      ...parsed,
      blocks: prepareBlocks(parsed.blocks, props.path, headings),
      footnotes: parsed.footnotes?.map((footnote) => ({
        ...footnote,
        children: prepareBlocks(footnote.children, props.path, headings),
      })),
    };
    return { document, headings };
  });
  const root = signal<ViewRef>();
  effect(() => {
    const position = props.position;
    if (!root() || !position) return;
    if (position.kind === "offset") {
      props.onOffset(position.y);
    } else if (
      !position.heading ||
      (position.heading.toLowerCase() === "top" &&
        !markdown()?.headings.has(position.heading))
    ) {
      props.onOffset(0);
    }
  });
  return (
    <View ref={root.set}>
      <If
        when={image()}
        else={
          <If when={markdown()} else={<Label>{text()}</Label>}>
            <TextView
              document={markdown()?.document}
              renderCustom={(node) => {
                if (node.name === markerName && node.attributes?.heading)
                  return (
                    <SkillHeadingMarker
                      heading={node.attributes.heading}
                      position={props.position}
                      onHeading={props.onHeading}
                    />
                  );
                if (node.name === linkName && node.attributes?.url)
                  return (
                    <SkillKeyboardLink
                      label={node.attributes.label ?? node.attributes.url}
                      url={node.attributes.url}
                      onLink={props.onLink}
                    />
                  );
                return null;
              }}
              selectable
              onLinkPress={({ url }) => props.onLink(url)}
              renderImage={({ src, alt }) => {
                const path = skillRelativeFile(props.path, src);
                return path ? (
                  <SkillMarkdownImage path={path} alt={alt} read={props.read} />
                ) : (
                  <Label variant="small" tone="muted">
                    {alt || uiText("imageUnavailable")}
                  </Label>
                );
              }}
              styles={{
                root: {
                  fontFamily: fontFamily(fonts().interface),
                  ...textStyle(type("body")),
                  color: c().ink,
                  gap: space[12],
                },
                heading: { marginTop: 0, marginBottom: 0 },
                heading1: textStyle(type("title"), "prose"),
                heading2: textStyle(type("subtitle"), "prose"),
                heading3: textStyle(type("body")),
                paragraph: { marginTop: 0, marginBottom: 0 },
                list: { gap: space[4] },
                listMarker: { color: c().ink },
                code: { fontFamily: monoFontFamily(fonts()) },
                codeBlockCode: {
                  fontFamily: monoFontFamily(fonts()),
                },
                link: { color: c().blue },
              }}
              codeBlockActions={[{ id: "copy" }]}
            />
          </If>
        }
      >
        <Image
          src={image()}
          style={{ width: "100%", height: imageHeight, objectFit: "contain" }}
        />
      </If>
    </View>
  );
}
