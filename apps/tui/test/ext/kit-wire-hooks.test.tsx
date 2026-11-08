/**
 * The kit's hooks over the wire, against a real host: a target is subscribed while a component
 * reads it and released when the last one unmounts, the store's slices re-render, and a plugin's
 * presence comes from `hello.mounted`.
 */
import type { LayerHandle } from "../../src/extensions/types";
import { Text } from "ink";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTarget } from "../../src/ext/kit/wire-hooks";
import { testCommands } from "../ext-support/commands";
import { renderWithHost } from "../ext-support/render-with-host";

function TargetProbe({ name, target }: { name: string; target?: string }) {
  const state = useTarget(target);
  const sections =
    state === undefined ? "none" : Object.keys(state.sections).sort().join(",");
  return (
    <Text>
      probe {name}: {sections}
    </Text>
  );
}

/** The open probe layers, the top one last: closed the way a command closes its own layer. */
const handles: LayerHandle[] = [];
const closeTopLayer = () => handles.pop()?.close();
beforeEach(() => {
  handles.length = 0;
});

const probes = testCommands("zz-probe", {
  target: (ctx, arg) => {
    const [name = "", target] = arg.split(" ");
    handles.push(
      ctx.openLayer(() => <TargetProbe name={name} target={target} />),
    );
  },
});

describe("useTarget", () => {
  it("subscribes a lazy target while mounted and releases it on unmount", async () => {
    const r = await renderWithHost({ extensions: [probes] });
    const held = () => r.wire.store.getState().targets.plugins;
    // `plugins` is not in hello: nothing is held until somebody subscribes.
    expect(held()).toBeUndefined();

    await r.runCommand("/target one plugins");
    await r.waitFor("probe one: audit,list");
    expect(held()).toBeDefined();

    closeTopLayer();
    await r.waitForGone("probe one");
    await r.waitUntil(() => held() === undefined, "plugins to be released");
    await r.close();
  });
});

describe("useTarget when what it reads changes", () => {
  it("subscribes when the target goes from undefined to a name, and moves from one target to another", async () => {
    let choose: ((target: string | undefined) => void) | undefined;
    function Switching() {
      const [target, setTarget] = useState<string | undefined>(undefined);
      choose = setTarget;
      return <TargetProbe name="switch" target={target} />;
    }
    const r = await renderWithHost({
      extensions: [
        testCommands("zz-switch", {
          switch: (ctx) => {
            ctx.openLayer(() => <Switching />);
          },
        }),
      ],
    });
    const held = (target: string) => r.wire.store.getState().targets[target];
    await r.runCommand("/switch");
    await r.waitFor("probe switch: none");
    expect(held("plugins")).toBeUndefined();

    choose!("plugins");
    await r.waitFor("probe switch: audit,list");
    expect(held("plugins")).toBeDefined();

    choose!("mcp");
    await r.waitFor("probe switch: list");
    await r.waitUntil(
      () => held("plugins") === undefined,
      "plugins to be released",
    );
    expect(held("mcp")).toBeDefined();

    choose!(undefined);
    await r.waitFor("probe switch: none");
    await r.waitUntil(() => held("mcp") === undefined, "mcp to be released");
    await r.close();
  });
});
