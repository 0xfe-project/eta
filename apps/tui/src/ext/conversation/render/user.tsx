import type { AttachmentView } from "@eta/client-contracts";
import type { ReactNode } from "react";
import type { PasteRange, TranscriptItem } from "../contract";
import type { RunImage } from "../model/run";
import type { DrawContext, DrawnItem } from "./context";
import { Text } from "ink";
import { draw } from "./lines";
import { Prefixed } from "./prefixed";
import { countLines, formatSize, imageLabel, linesLabel } from "./text";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** A stretch of what the user wrote: their own words, or a paste drawn folded. */
type Stretch =
  | { kind: "words"; text: string }
  | { kind: "paste"; lines: number };

/** What the user said after `› `, each paste as a placeholder, then the files and pictures. */
export function drawUser(item: UserItem, context: DrawContext): DrawnItem {
  const { colors, t } = context;
  const stretches = stretchesOf(item.text, item.pastes);
  const extras = [
    ...item.attachments.map((file) => attachmentLine(file, context)),
    ...item.images.map((image) => imageLine(image, context)),
  ];
  const node = (
    <Prefixed mark="›" markColor={colors.accent}>
      {stretches.length > 0 && (
        <Text wrap="wrap" color={colors.text}>
          {stretches.map((stretch, index) =>
            stretch.kind === "words" ? (
              // Stretches never reorder, so the index names each.
              // eslint-disable-next-line react/no-array-index-key
              <Text key={index}>{stretch.text}</Text>
            ) : (
              // eslint-disable-next-line react/no-array-index-key
              <Text key={index} color={colors.muted}>
                {t("pasted", { lines: linesLabel(stretch.lines, t) })}
              </Text>
            ),
          )}
        </Text>
      )}
      {extras}
    </Prefixed>
  );
  return {
    lines: draw(node, context.width),
    source: item.text,
    foldable: false,
  };
}

/**
 * The text cut at its pastes. A paste that overlaps one before it, or reaches outside the text,
 * is drawn as written.
 */
function stretchesOf(text: string, pastes: readonly PasteRange[]): Stretch[] {
  const stretches: Stretch[] = [];
  let cursor = 0;
  const sorted = [...pastes].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of sorted) {
    if (start < cursor || end > text.length || start >= end) continue;
    if (start > cursor)
      stretches.push({ kind: "words", text: text.slice(cursor, start) });
    stretches.push({
      kind: "paste",
      lines: countLines(text.slice(start, end)),
    });
    cursor = end;
  }
  if (cursor < text.length)
    stretches.push({ kind: "words", text: text.slice(cursor) });
  return stretches;
}

function attachmentLine(file: AttachmentView, context: DrawContext): ReactNode {
  return (
    <Text key={`file-${file.id}`} wrap="wrap" color={context.colors.muted}>
      {`${context.t("file")} ${file.name} · ${formatSize(file.size)}`}
    </Text>
  );
}

function imageLine(image: RunImage, context: DrawContext): ReactNode {
  return (
    <Text
      key={`image-${image.entryId}-${image.index}`}
      wrap="wrap"
      color={context.colors.muted}
    >
      {imageLabel(image, context.t)}
    </Text>
  );
}
