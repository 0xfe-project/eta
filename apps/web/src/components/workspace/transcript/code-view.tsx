import { useMemo } from "react";
import { tokenize } from "sugar-high/core";
import { tokenize as tokenizeJs } from "sugar-high/lang/javascript";
import * as json from "sugar-high/lang/json";

/** sugar-high's token kinds, in the order of the numbers `tokenize` gives them. */
const KINDS = [
  "identifier",
  "keyword",
  "string",
  "class",
  "property",
  "entity",
  "jsxliterals",
  "sign",
  "comment",
  "break",
  "space",
] as const;

// JSON is not JavaScript: no regex, JSX or template literals to look for.
const JSON_OPTIONS = {
  ...json,
  jsx: false,
  regex: false,
  templateStrings: false,
};

const tokensOf = (lang: "js" | "json", text: string) =>
  lang === "js" ? tokenizeJs(text, undefined) : tokenize(text, JSON_OPTIONS);

/**
 * Code with its tokens coloured. Tokenizing is synchronous and cheap, so a script still being
 * written is coloured on every frame: the text only grows, the spans already drawn are the same
 * elements next frame, and the new ones are added after them.
 */
export function CodeView({
  lang,
  text,
}: {
  lang: "js" | "json";
  text: string;
}) {
  const tokens = useMemo(() => tokensOf(lang, text), [lang, text]);
  return (
    <code className="code-view" data-lang={lang}>
      {tokens.map(([kind, value], index) => (
        // Tokens are the text in order; a longer text keeps every earlier token in its place.
        // eslint-disable-next-line react/no-array-index-key
        <span key={index} className={`tok-${KINDS[kind] ?? "identifier"}`}>
          {value}
        </span>
      ))}
    </code>
  );
}
