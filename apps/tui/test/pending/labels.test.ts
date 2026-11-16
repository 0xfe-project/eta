/**
 * A task's status word takes the colour the web app's mark has, in the theme's terminal colours.
 */
import type { BoardTaskStatus } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { statusColor } from "../../src/ext/pending/labels";

describe("statusColor", () => {
  it("paints each status as the web app does, in terminal colours", () => {
    const theme = DEFAULT_CONFIG.theme;
    const colors = Object.fromEntries(
      (
        [
          "backlog",
          "todo",
          "in_progress",
          "in_review",
          "done",
          "blocked",
          "cancelled",
        ] as BoardTaskStatus[]
      ).map((status) => [status, statusColor(status, theme)]),
    );
    expect(colors).toEqual({
      backlog: "gray",
      // To-do is plain text: the terminal's own colour.
      todo: undefined,
      in_progress: "cyan",
      in_review: "yellow",
      done: "green",
      blocked: "red",
      cancelled: "gray",
    });
  });

  it("follows a theme the user wrote", () => {
    expect(
      statusColor("blocked", { ...DEFAULT_CONFIG.theme, error: "#ff0000" }),
    ).toBe("#ff0000");
  });
});
