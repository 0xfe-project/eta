/** The composer's history: what a send records, and stepping back and forth through it. */
import { describe, expect, it } from "vitest";
import { afterSend } from "../../src/ext/conversation/composer/history";
import { pasteText } from "../../src/ext/conversation/composer/paste";
import { emptyComposer } from "../../src/ext/conversation/composer/state";

describe("recording a send", () => {
  it("keeps a folded paste folded", () => {
    const withPaste = pasteText(emptyComposer(), "1\n2\n3\n4\n5\n6");
    const state = afterSend(withPaste);
    expect(state.history[0]).toEqual({
      text: withPaste.text,
      pastes: withPaste.pastes,
    });
  });
});
