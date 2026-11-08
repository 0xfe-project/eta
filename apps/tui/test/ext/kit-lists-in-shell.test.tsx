/**
 * The kit's input components inside the real shell: a layer opened over one of them takes its
 * keys away, and it has them back when that layer closes.
 */
import type { ReactNode } from "react";
import type { LayerHandle, ShellContext } from "../../src/extensions/types";
import { Text, useInput } from "ink";
import { describe, expect, it } from "vitest";
import { CheckList } from "../../src/ext/kit/check-list";
import { PickList } from "../../src/ext/kit/pick-list";
import { TextPrompt } from "../../src/ext/kit/text-prompt";
import { useInputActive } from "../../src/extensions/react";
import { testCommands } from "../ext-support/commands";
import { LIST_KEYS } from "../ext-support/keys";
import { renderWithHost } from "../ext-support/render-with-host";
import { KEYS } from "../ui-support/render";

/** A layer that takes every key and closes on Esc. */
function Cover({ handle }: { handle: LayerHandle }) {
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) handle.close();
    },
    { isActive: active },
  );
  return <Text>cover layer</Text>;
}

const ITEMS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
];

/** A shell with nothing open but the home screen, and its context to open layers from. */
async function shell() {
  let grabbed: ShellContext | undefined;
  const r = await renderWithHost({
    extensions: [
      testCommands("zz-probe", {
        grab: (ctx) => {
          grabbed = ctx;
        },
      }),
    ],
  });
  await r.runCommand("/grab");
  const ctx = grabbed!;
  const open = (node: ReactNode) => ctx.openLayer(() => node);
  const cover = async () => {
    ctx.openLayer((handle) => <Cover handle={handle} />);
    await r.waitFor("cover layer");
  };
  const uncover = async () => {
    await r.press(KEYS.escape);
    await r.waitForGone("cover layer");
  };
  return { r, open, cover, uncover };
}

describe("kit components under a layer", () => {
  it("a pick list takes no keys while covered", async () => {
    const picked: string[] = [];
    const { r, open, cover, uncover } = await shell();
    open(
      <PickList items={ITEMS} empty="none" onPick={(k) => picked.push(k)} />,
    );
    await r.waitFor("Alpha");
    await cover();
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(picked).toEqual([]);
    await uncover();
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(picked).toEqual(["b"]);
    await r.close();
  });

  it("a check list takes no keys while covered", async () => {
    const confirmed: string[][] = [];
    const { r, open, cover, uncover } = await shell();
    open(
      <CheckList
        items={ITEMS}
        empty="none"
        onConfirm={(set) => confirmed.push([...set])}
      />,
    );
    await r.waitFor("[ ] Alpha");
    await cover();
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.enter);
    expect(confirmed).toEqual([]);
    await uncover();
    await r.waitFor("[ ] Alpha");
    await r.press(LIST_KEYS.space);
    await r.press(KEYS.enter);
    expect(confirmed).toEqual([["a"]]);
    await r.close();
  });

  it("a text prompt takes no keys while covered", async () => {
    const submitted: string[] = [];
    const { r, open, cover, uncover } = await shell();
    open(
      <TextPrompt
        label="Name"
        onSubmit={(v) => submitted.push(v)}
        onCancel={() => undefined}
      />,
    );
    await r.waitFor("Name");
    await cover();
    await r.type("zed");
    await r.press(KEYS.enter);
    expect(submitted).toEqual([]);
    await uncover();
    await r.type("amy");
    await r.press(KEYS.enter);
    expect(submitted).toEqual(["amy"]);
    await r.close();
  });
});
