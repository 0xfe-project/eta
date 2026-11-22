import { expect, test } from "nsh/test";
import { quoteMarkdown } from "../src/components/eta-editor/plugins/quote";

test("a selection becomes a Markdown quote on lines of its own", () => {
  expect(quoteMarkdown("one\ntwo")).toBe("> one\n> two");
  expect(quoteMarkdown("  one  \r\n\r\ntwo\n")).toBe("> one\n>\n> two");
});

test("an empty selection quotes nothing", () => {
  expect(quoteMarkdown("  \n ")).toBe("");
});
