import type { ShownText } from "../src/components/eta-editor/view-source";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import { TextView } from "nsh/base";
import { expect, test } from "nsh/test";
import { selectedText } from "../src/components/eta-editor/selected-text";
import {
  lineEnds,
  standIn,
  viewDocument,
  viewSource,
} from "../src/components/eta-editor/view-source";

// What Quote takes from a reply: the selection a platform reports (the strings below are what the
// web and Linux desktop builds reported for these selections), read back in the reply as written.

const reply: ShownText = {
  text: [
    "There are three places where we can cut that down, and @Ada already looked at the `sessionUser` helper:",
    "",
    "- Track conversion on the trial button and on the contact form separately.",
    "- Keep the old page reachable at /pricing/classic for anyone who bookmarked it.",
    "",
    "```ts",
    "const hit = cache.get(id);",
    "  if (hit) return hit.user;",
    "```",
  ].join("\n"),
  mentions: [{ id: "ada", label: "Ada" }],
};

function quoted(selected: string, text: ShownText = reply) {
  const { markdown, stands } = viewSource(text);
  const document = viewDocument(
    TextView.parse(markdown, { html: false }, [
      lineEnds,
      standIn(DOC_NODES.mention),
    ]),
    stands,
  );
  return selectedText(selected, document);
}

test("a mention the selection left out is quoted by its name", () => {
  expect(
    quoted(
      "There are three places where we can cut that down, and  already looked at the sessionUser helper",
    ),
  ).toBe(
    "There are three places where we can cut that down, and @Ada already looked at the sessionUser helper",
  );
});

test("a selection that starts after a mention does not take it in", () => {
  expect(quoted("already looked at")).toBe("already looked at");
  expect(quoted("@Ada already")).toBe("@Ada already");
});

test("list markers go, and lines are the reply's own, not where the screen wrapped them", () => {
  expect(
    quoted(
      "Track conversion on the trial button and on the contact form separately.\t•\nKeep the old page reachable at /pricing/classic for anyone who bookmarked\nit.",
    ),
  ).toBe(
    "Track conversion on the trial button and on the contact form separately.\nKeep the old page reachable at /pricing/classic for anyone who bookmarked it.",
  );
});

test("code keeps its lines and indent", () => {
  expect(quoted("const hit = cache.get(id);  if (hit) return hit.user;")).toBe(
    "const hit = cache.get(id);\n  if (hit) return hit.user;",
  );
});

test("a selection that is not in the text is not read into it", () => {
  expect(quoted("Nothing like this")).toBeUndefined();
});
