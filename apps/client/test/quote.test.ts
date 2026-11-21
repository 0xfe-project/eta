import { expect, test } from "nsh/test";
import { appendQuote } from "../src/pages/chat/quote";

test("a selection becomes a Markdown quote on lines of its own", () => {
  expect(appendQuote("", "one\ntwo")).toBe("> one\n> two\n\n");
  expect(appendQuote("draft  \n", "one\r\n\r\ntwo")).toBe(
    "draft\n\n> one\n>\n> two\n\n",
  );
});

test("an empty selection leaves the draft as it was", () => {
  expect(appendQuote("draft", "  \n ")).toBe("draft");
});
