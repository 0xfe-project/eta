/**
 * What the conversation view is drawn from, between the part that reads the host (rows, members,
 * the live run of each member's session) and the part that turns it into terminal lines.
 *
 * The transcript is a list of items. Each item is drawn on its own into lines of a known width,
 * and the view scrolls, searches and selects over those lines; so an item's lines depend only on
 * the item and the options, never on the items around it.
 */
import type { AttachmentView } from "@eta/client-contracts";
import type { Locale, Theme } from "../../config/types";
import type { RunImage, ToolBlock } from "./model/run";

/** A folded paste in a user's text: `[start, end)` in UTF-16 offsets, as `send` takes them. */
export type PasteRange = [number, number];

/** What an agent worked through; folded unless unfolded. */
export interface ThinkingItem {
  kind: "thinking";
  key: string;
  text: string;
  streaming: boolean;
}

/** What an agent said, as markdown; `streaming` while it is still being written. */
export interface TextItem {
  kind: "text";
  key: string;
  text: string;
  streaming: boolean;
}

/**
 * A tool call. `progress` is what a running call has printed so far (from `tool:update`); once
 * the call ends its output is `tool.output`.
 */
export interface ToolItem {
  kind: "tool";
  key: string;
  tool: ToolBlock;
  progress: string | undefined;
}

/** An item a reply's steps are made of. */
export type StepItem = ThinkingItem | TextItem | ToolItem;

/**
 * One thing in the transcript, oldest first. `key` is stable for as long as the thing is on
 * screen (a streamed text keeps its key when its row lands), and is what folding is keyed by.
 */
export type TranscriptItem =
  /** What the user said; pastes the sender folded are drawn folded. */
  | {
      kind: "user";
      key: string;
      text: string;
      pastes: PasteRange[];
      attachments: AttachmentView[];
      images: RunImage[];
    }
  /**
   * The name over a reply, in a group conversation; the reply is framed under it. `agentId` is the
   * agent the reply is from (empty when the row names none); `members` are the agent ids of the
   * conversation's members. The two pick the frame's colour, so that members get different ones.
   */
  | {
      kind: "author";
      key: string;
      name: string;
      agentId: string;
      members: readonly string[];
    }
  | ThinkingItem
  | TextItem
  | ToolItem
  /**
   * The steps of one reply as one line, where its first step stands: its tool calls and the
   * thinking and text from the start of the reply up to its last tool call, in order. Folded,
   * the steps are not items of their own; unfolded, they follow as they were, each folding on
   * its own. `replying` while the reply is still running.
   */
  | { kind: "steps"; key: string; steps: StepItem[]; replying: boolean }
  /**
   * How a reply ended when the text does not say it: stopped, or failed with the host's `code`
   * (`restart`, `run_failed`, `unavailable`, `gone`, or one this TUI does not know) and its words.
   * `run-error` is a turn inside a running reply that ended on an error.
   */
  | {
      kind: "outcome";
      key: string;
      outcome: "stopped" | "failed" | "run-error";
      code: string | undefined;
      text: string;
    }
  /** Where a session folded its history into a summary; folded unless unfolded. */
  | {
      kind: "summary";
      key: string;
      summary: "compaction" | "branch";
      text: string;
    }
  /**
   * One line about the conversation rather than in it, already in the reader's language: a system
   * row, a message that woke nobody, a reply waiting its turn or waiting on the user, a task row.
   */
  | {
      kind: "notice";
      key: string;
      tone: "muted" | "warning";
      text: string;
    };

export interface RenderOptions {
  /** Columns the lines may use. Every line drawn is at most this wide. */
  width: number;
  /** `toolOutput.previewLines`: how many lines of a long tool output show while it is folded. */
  previewLines: number;
  /**
   * The item is unfolded: a thinking block or summary shows its text, a tool output shows whole,
   * a reply's steps line marks that its steps show.
   */
  expanded: boolean;
  theme: Theme;
  locale: Locale;
}

/** The codes that turn a style on and off again; both empty for the terminal's own colour. */
export interface SgrPair {
  open: string;
  close: string;
}

/** What a reply's frame is drawn with, besides the transcript's width. */
export interface FrameStyle {
  /** The author's name as one line without colours or control characters. */
  name: string;
  /** Around the frame's corners and bars. */
  border: SgrPair;
  /** Around the name in the top edge. */
  nameStyle: SgrPair;
}

/** One item drawn. */
export interface RenderedItem {
  /** The lines as the terminal shows them, colours included (SGR only); each at most `width` wide. */
  lines: string[];
  /** The same lines without colours, for search and for copying lines. Same length as `lines`. */
  plain: string[];
  /**
   * What copying the whole item puts on the clipboard: the text as written (the markdown, the
   * command and its whole output, the patch), not the lines as drawn.
   */
  source: string;
  /** Unfolding would show more than is shown now, or folding would show less. */
  foldable: boolean;
  /** How the reply under an author is framed; every author's drawing has it (`AuthorDrawing`). */
  frame?: FrameStyle | undefined;
}

export type AuthorItem = Extract<TranscriptItem, { kind: "author" }>;

/**
 * An author drawn: `lines` are the author's own line, which shows where the transcript is too
 * narrow for frames, and `frame` how the reply under it is framed where it is wide enough.
 */
export interface AuthorDrawing extends RenderedItem {
  frame: FrameStyle;
}

/**
 * Draws one item; an author always with its frame style. Implemented in `render/`; the view caches
 * by item, options and key.
 */
export interface RenderItem {
  (item: AuthorItem, options: RenderOptions): AuthorDrawing;
  (item: TranscriptItem, options: RenderOptions): RenderedItem;
}
