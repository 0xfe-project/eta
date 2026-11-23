import type {
  DocNode,
  SerializedDraft,
} from "@eta/client-contracts/composer-doc";
import type { PasteRange } from "@eta/client-contracts/composer-draft";
import type { MentionRef } from "@eta/client-contracts/composer-markdown";
import type { RichNodeJSON, RichSchema } from "nsh/base";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import {
  docToMarkdown,
  markdownSource,
  restoreDoc,
  sameDoc,
} from "@eta/client-contracts/composer-markdown";
import { starterSchema } from "nsh/base";

// Markdown in and out of the editor's document, with nsh's Markdown reader (CommonMark and
// GitHub's) and the writer in `composer-markdown`. The wire format of mentions, pastes and files is
// the one messages always had: see there.

let schema: RichSchema | undefined;

/** Text as kept (a message, a description) as the editor's document. */
export interface StoredText {
  text: string;
  /** Folded pastes: where each is in `text`. */
  blocks?: readonly PasteRange[];
  /** The members `text` mentions, as it names them. */
  mentions?: readonly MentionRef[];
}

/**
 * Markdown as the editor's document: formatting as its nodes, each folded paste (`blocks`) a paste
 * block again, each `@label` of `mentions` a mention block. Each line of a paragraph is a
 * paragraph, as a message's lines are lines.
 */
export function markdownToDoc(input: StoredText): DocNode {
  const { source, stands } = markdownSource(input);
  schema ??= starterSchema();
  let parsed: DocNode;
  try {
    parsed = schema.parseMarkdown(source) as DocNode;
  } catch {
    // Nothing the reader takes: the text, line by line.
    parsed = {
      type: DOC_NODES.doc,
      content: [
        {
          type: DOC_NODES.paragraph,
          content: source ? [{ type: DOC_NODES.text, text: source }] : [],
        },
      ],
    };
  }
  return restoreDoc(parsed, stands);
}

/** The mentions a document holds, as `markdownToDoc` needs them to read its Markdown back. */
function mentionsOf(doc: DocNode, out: MentionRef[] = []): MentionRef[] {
  if (doc.type === DOC_NODES.mention) {
    const id = String(doc.attrs?.id ?? "");
    if (!out.some((mention) => mention.id === id))
      out.push({ id, label: String(doc.attrs?.label ?? id) });
  }
  for (const child of doc.content ?? []) mentionsOf(child, out);
  return out;
}

/**
 * The document as Markdown to keep or send. Words are written as typed (`snake_case` stays), as a
 * plain message always was; a block whose words would read back as something else (a line typed
 * as `- x` after its list was undone) is written with Markdown's characters escaped. Checked by
 * reading the Markdown back: what is sent reads as what was written.
 */
export function docToStoredMarkdown(doc: DocNode): SerializedDraft {
  const mentions = mentionsOf(doc);
  const reads = (out: SerializedDraft, written: DocNode) =>
    sameDoc(
      written,
      markdownToDoc({ text: out.text, blocks: out.blocks, mentions }),
    );
  const raw = docToMarkdown(doc);
  if (reads(raw, doc)) return raw;
  const blocks = doc.content ?? [];
  const escaping = blocks.map((block) => {
    const alone: DocNode = { type: DOC_NODES.doc, content: [block] };
    return reads(docToMarkdown(alone), alone)
      ? ("raw" as const)
      : ("escaped" as const);
  });
  const mixed = docToMarkdown(doc, (index) => escaping[index] ?? "escaped");
  if (reads(mixed, doc)) return fewerEscapes(mixed, (out) => reads(out, doc));
  return docToMarkdown(doc, () => "escaped");
}

/** Escapes tried one by one at most; past it a message keeps every escape. */
const MAX_TRIED_ESCAPES = 120;

/**
 * `out` with each backslash escape it can do without taken out, left to right: one taken out
 * stays out when the text still reads the same (`reads`). Pastes are never touched; their ranges
 * move with the text.
 */
function fewerEscapes(
  out: SerializedDraft,
  reads: (out: SerializedDraft) => boolean,
): SerializedDraft {
  const inPaste = (at: number, blocks: readonly PasteRange[]) =>
    blocks.some(([start, stop]) => at >= start && at < stop);
  let current = out;
  let tried = 0;
  for (let at = 0; at < current.text.length - 1; at++) {
    if (current.text[at] !== "\\" || inPaste(at, current.blocks)) continue;
    if (!/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(current.text[at + 1]!))
      continue;
    if (++tried > MAX_TRIED_ESCAPES) break;
    const candidate: SerializedDraft = {
      ...current,
      text: current.text.slice(0, at) + current.text.slice(at + 1),
      blocks: current.blocks.map(
        ([start, stop]) =>
          (start > at ? [start - 1, stop - 1] : [start, stop]) as PasteRange,
      ),
    };
    if (reads(candidate)) current = candidate;
    // Kept: an escaped backslash (`\\`) is two characters; the next one is its own.
    else at++;
  }
  return current;
}

/** A document for `RichEditorSession.setContent` / `insertContent`. */
export const asRich = (doc: DocNode) => doc as RichNodeJSON;
