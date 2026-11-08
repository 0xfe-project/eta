/**
 * CheckList on its own: Space ticks the marked item, Enter confirms the ticked set, moving and
 * scrolling work as in PickList, and the ticks can be held by the caller.
 *
 * Rendered with the settings and the language only, for the reason given in kit-pick-list.test.tsx.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { CheckList } from "../../src/ext/kit/check-list";
import { LIST_KEYS } from "../ext-support/keys";
import { renderKit } from "../ext-support/render-kit";
import { flush, KEYS, plain } from "../ui-support/render";

function lineOf(screen: string, label: string): string {
  return screen.split("\n").find((line) => line.includes(label)) ?? "";
}

function confirmedKeys(sets: ReadonlySet<string>[]): string[][] {
  return sets.map((set) => [...set].sort());
}

/** A CheckList whose ticks its caller holds and follows. */
function HeldPair({ confirmed }: { confirmed: ReadonlySet<string>[] }) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <CheckList
      items={[
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
      ]}
      checked={checked}
      onToggle={(key, next) =>
        setChecked((now) => {
          const copy = new Set(now);
          if (next) copy.add(key);
          else copy.delete(key);
          return copy;
        })
      }
      empty="none"
      onConfirm={(set) => confirmed.push(set)}
    />
  );
}

describe("check list", () => {
  it("confirms a held tick made in the same read as the Enter", async () => {
    const confirmed: ReadonlySet<string>[] = [];
    const r = renderKit(<HeldPair confirmed={confirmed} />);
    await flush();
    await r.press(`${LIST_KEYS.space}${KEYS.enter}`);
    expect(confirmedKeys(confirmed)).toEqual([["a"]]);
  });

  it("confirms held ticks on two items made in the same read as the Enter", async () => {
    const confirmed: ReadonlySet<string>[] = [];
    const r = renderKit(<HeldPair confirmed={confirmed} />);
    await flush();
    await r.press(
      `${LIST_KEYS.space}${KEYS.down}${LIST_KEYS.space}${KEYS.enter}`,
    );
    expect(confirmedKeys(confirmed)).toEqual([["a", "b"]]);
    expect(lineOf(plain(r), "Alpha")).toContain("[x] Alpha");
    expect(lineOf(plain(r), "Beta")).toContain("[x] Beta");
  });
});
