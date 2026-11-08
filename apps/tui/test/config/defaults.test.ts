import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { ACTION_NAMES } from "../../src/config/types";

const bind = (key: string, alt = false, ctrl = false, shift = false) => [
  { key, ctrl, alt, shift },
];

describe("the default config", () => {
  it("binds a key to every action", () => {
    expect(Object.keys(DEFAULT_CONFIG.keybindings).sort()).toEqual(
      [...ACTION_NAMES].sort(),
    );
    const expected: Record<string, unknown> = {
      "tabs.previous": bind("left", true),
      "tabs.next": bind("right", true),
      "panel.open": bind("left"),
      "review.open": bind("r", true),
      "tabs.close": bind("w", true),
      "reply.stop": bind("escape"),
      "app.quit": bind("c", false, true),
      "transcript.pageUp": bind("pageup"),
      "transcript.pageDown": bind("pagedown"),
      "transcript.lineUp": bind("up", false, false, true),
      "transcript.lineDown": bind("down", false, false, true),
      "transcript.top": bind("home", false, true),
      "transcript.bottom": bind("end", false, true),
      "transcript.search": bind("f", false, true),
      "transcript.select": bind("v", true),
      "transcript.expandAll": bind("o", false, true),
      "message.newline": [
        ...bind("enter", true),
        ...bind("enter", false, false, true),
      ],
      "message.steer": bind("tab"),
      "pending.openConversation": bind("o", true),
    };
    for (let n = 1; n <= 9; n += 1)
      expected[`tabs.goTo${n}`] = bind(String(n), true);
    expect(DEFAULT_CONFIG.keybindings).toEqual(expected);
  });

  it("puts the tab bar at the bottom and previews five lines", () => {
    expect(DEFAULT_CONFIG.layout).toEqual({ tabBar: "bottom" });
    expect(DEFAULT_CONFIG.toolOutput).toEqual({ previewLines: 5 });
  });
});
