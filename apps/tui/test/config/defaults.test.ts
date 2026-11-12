import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { ACTION_NAMES } from "../../src/config/types";

const bind = (key: string, alt = false, ctrl = false) => [
  { key, ctrl, alt, shift: false },
];

describe("the default config", () => {
  it("binds one key to every action", () => {
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
