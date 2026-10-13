import type {
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
} from "lexical";
import type { ReactElement } from "react";
import type { Draft, DraftPart } from "@/lib/composer";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  DecoratorNode,
} from "lexical";
import { createElement } from "react";
import { ComposerBlock } from "./composer-block";

// The composer's content as Lexical nodes: text and line breaks in one
// paragraph, and blocks (long pastes and files) as inline nodes that move,
// select, delete and undo as one character.

export type BlockPart = Exclude<DraftPart, { type: "text" }>;

/** Text as nodes: its lines with line breaks between them. */
function $textNodes(text: string): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i) nodes.push($createLineBreakNode());
    if (line) nodes.push($createTextNode(line));
  });
  return nodes;
}

type SerializedBlockNode = SerializedLexicalNode & { part: BlockPart };

export class BlockNode extends DecoratorNode<ReactElement> {
  __part: BlockPart;

  static getType() {
    return "chat-block";
  }

  static clone(node: BlockNode) {
    return new BlockNode(node.__part, node.__key);
  }

  static importJSON(json: SerializedBlockNode) {
    return new BlockNode(json.part);
  }

  constructor(part: BlockPart, key?: NodeKey) {
    super(key);
    this.__part = part;
  }

  exportJSON(): SerializedBlockNode {
    return { ...super.exportJSON(), part: this.__part };
  }

  createDOM(_config: EditorConfig) {
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.className = "inline-block max-w-full align-bottom";
    return span;
  }

  updateDOM() {
    return false;
  }

  isInline() {
    return true;
  }

  // What copying it as text gives: a paste's whole text.
  getTextContent() {
    return this.__part.type === "paste"
      ? this.__part.text
      : `[${this.__part.name}]`;
  }

  decorate(editor: LexicalEditor) {
    const key = this.getKey();
    const part = this.__part;
    return createElement(ComposerBlock, {
      part,
      remove: () =>
        editor.update(() => {
          $getNodeByKey(key)?.remove();
        }),
      expand: () =>
        editor.update(() => {
          const node = $getNodeByKey(key);
          if (!node || part.type !== "paste") return;
          const nodes = $textNodes(part.text);
          for (const n of nodes) node.insertBefore(n);
          node.remove();
          nodes.at(-1)?.selectNext();
        }),
    });
  }
}

function $isBlockNode(node: LexicalNode | null | undefined): node is BlockNode {
  return node instanceof BlockNode;
}

/** The editor's content as a draft. */
export function $readDraft(): Draft {
  const draft: Draft = [];
  let text = "";
  const flush = () => {
    if (text) draft.push({ type: "text", text });
    text = "";
  };
  $getRoot()
    .getChildren()
    .forEach((paragraph, i) => {
      if (i) text += "\n";
      if (!$isElementNode(paragraph)) return;
      for (const child of paragraph.getChildren()) {
        if ($isBlockNode(child)) {
          flush();
          draft.push(child.__part);
        } else if ($isLineBreakNode(child)) {
          text += "\n";
        } else {
          text += child.getTextContent();
        }
      }
    });
  flush();
  return draft;
}

/** Replace the editor's content with the draft, the caret at its end. */
export function $writeDraft(draft: Draft) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const part of draft)
    paragraph.append(
      ...(part.type === "text" ? $textNodes(part.text) : [new BlockNode(part)]),
    );
  root.append(paragraph);
  paragraph.selectEnd();
}
