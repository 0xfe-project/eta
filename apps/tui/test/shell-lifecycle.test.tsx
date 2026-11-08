/**
 * What belongs to the shell lives and dies with it: its layers, the extensions' background parts,
 * and the failures of actions started from a layer or a key.
 */
import type { ConnectionPhase } from "../src/connection/types";
import type { Extension, PinnedTab } from "../src/extensions/types";
import { Text, useInput } from "ink";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useAction, useShell } from "../src/extensions/react";
import { renderApp, TEST_URL } from "./ui-support/app";
import { flush, KEYS, plain } from "./ui-support/render";

const open: { unmount: () => void }[] = [];
async function app(...args: Parameters<typeof renderApp>) {
  const rendered = await renderApp(...args);
  open.push(rendered);
  return rendered;
}
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

const temporary = {
  name: "connected",
  url: TEST_URL,
  temporary: true,
} as const satisfies ConnectionPhase;

const temporaryExited: ConnectionPhase = {
  name: "unreachable",
  url: TEST_URL,
  reason: "temporary-exited",
  output: "bye",
};

async function run(r: Awaited<ReturnType<typeof app>>, line: string) {
  await r.type(line);
  await r.press(KEYS.enter);
  await flush();
}

/** A layer whose component reads the shell's context, as the docs tell features to. */
function PanelLayer() {
  const ctx = useShell();
  return <Text>Panel for {ctx.locale}</Text>;
}

const panelExtension: Extension = {
  id: "zz-panel",
  commands: [
    {
      name: "panel",
      args: [],
      summary: { en: "Open the panel", zh: "打开面板" },
      examples: [],
      requiredOps: [],
      run: (ctx) => {
        ctx.openLayer(() => <PanelLayer />);
      },
    },
  ],
};

describe("layers belong to the shell", () => {
  it("closes the /install-service question when the temporary host exits, so Enter picks an unreachable choice", async () => {
    const r = await app({ phase: temporary, columns: 160 });
    r.controller.busy = [{ kind: "task", name: "Build", number: 4 }];
    await run(r, "/install-service");
    expect(plain(r)).toContain("Tasks: 1");

    r.controller.patch({ phase: temporaryExited, wire: undefined });
    await flush();
    expect(plain(r)).not.toContain("Tasks: 1");
    expect(plain(r)).toContain("Use a temporary host");
    expect(plain(r)).toContain("Change the address");

    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).not.toContain("handover");
    expect(r.controller.calls).toEqual([
      "handoverBusy",
      "startTemporary persist=false",
    ]);
  });

  it("keeps running when a layer that uses useShell() is open as the connection is given up", async () => {
    const r = await app({ extensions: [panelExtension] });
    await run(r, "/panel");
    expect(plain(r)).toContain("Panel for en");

    r.controller.patch({
      phase: {
        name: "unreachable",
        url: TEST_URL,
        reason: "timeout",
        output: undefined,
      },
      wire: undefined,
    });
    await flush();
    expect(plain(r)).toContain("Cannot connect");
    expect(plain(r)).not.toContain("Panel for");
    expect(plain(r)).not.toContain("useShell");
  });

  it("does not bring an old layer back when the shell shows again", async () => {
    const r = await app({ extensions: [panelExtension] });
    await run(r, "/panel");
    const wire = r.controller.getState().wire;
    r.controller.patch({
      phase: { name: "unauthorized", url: TEST_URL },
      wire: undefined,
    });
    await flush();
    r.controller.patch({
      phase: { name: "connected", url: TEST_URL, temporary: false },
      wire,
    });
    await flush();
    expect(plain(r)).not.toContain("Panel for");
    expect(plain(r)).toContain("/help");
  });

  it("keeps the layers while reconnecting, under the cover", async () => {
    const r = await app({ extensions: [panelExtension] });
    await run(r, "/panel");
    r.controller.setPhase({
      name: "reconnecting",
      url: TEST_URL,
      temporary: false,
      since: Date.now(),
    });
    await flush();
    r.controller.setPhase({
      name: "connected",
      url: TEST_URL,
      temporary: false,
    });
    await flush();
    expect(plain(r)).toContain("Panel for en");
  });

  it("still shows the settings problems found at start over the screens before the shell", async () => {
    const r = await app({
      phase: { name: "first-run", suggestedUrl: undefined },
      problems: [
        { file: "/test/eta/tui.json", key: "colour", reason: "unknown-key" },
      ],
      columns: 160,
    });
    expect(plain(r)).toContain("unknown key");
    expect(plain(r)).not.toContain("Start a temporary host");
    await r.press("x");
    expect(plain(r)).toContain("Start a temporary host");
  });
});

describe("failures of actions started outside a command's run", () => {
  it("reports a rejected handover in the status area instead of leaving it unhandled", async () => {
    const r = await app({ phase: temporary, columns: 200 });
    r.controller.busy = [{ kind: "reply", name: "Chat" }];
    r.controller.handoverError = new Error(
      "the host in use is not a temporary host",
    );
    await run(r, "/install-service");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toContain("handover");
    expect(plain(r)).toContain("the host in use is not a temporary host");
  });

  it("gives features reportFailure for their own asynchronous actions", async () => {
    let ctxSeen: ReturnType<typeof useShell> | undefined;
    const r = await app({
      columns: 200,
      extensions: [
        {
          id: "zz-grab",
          commands: [
            {
              name: "grab",
              args: [],
              summary: { en: "Grab", zh: "取" },
              examples: [],
              requiredOps: [],
              run: (ctx) => {
                ctxSeen = ctx;
              },
            },
          ],
        },
      ],
    });
    await run(r, "/grab");
    ctxSeen!.reportFailure(
      Promise.reject(new Error("the panel could not load")),
    );
    await flush();
    expect(plain(r)).toContain("the panel could not load");
    ctxSeen!.reportFailure(Promise.resolve("fine"));
    await flush();
    expect(plain(r)).toContain("the panel could not load");
  });
});

describe("pinned tabs can be selected", () => {
  function pinned(id: string, picks: string[]): PinnedTab {
    return { id, useLabel: () => `Pin ${id}`, onSelect: () => picks.push(id) };
  }

  it("selects the rightmost pinned tab with panel.open while the home input is empty", async () => {
    const picks: string[] = [];
    const r = await app({
      extensions: [
        { id: "zz-a", pinnedTabs: [pinned("first", picks)] },
        { id: "zz-b", pinnedTabs: [pinned("last", picks)] },
      ],
    });
    await r.press(KEYS.left);
    expect(picks).toEqual(["last"]);
  });

  it("leaves Left alone while the home input has text", async () => {
    const picks: string[] = [];
    const r = await app({
      extensions: [{ id: "zz-a", pinnedTabs: [pinned("p", picks)] }],
    });
    await r.type("ab");
    await r.press(KEYS.left);
    expect(picks).toEqual([]);
    await r.press(KEYS.escape);
    await r.press(KEYS.left);
    expect(picks).toEqual(["p"]);
  });

  it("does nothing under a layer", async () => {
    const picks: string[] = [];
    const r = await app({
      extensions: [
        { id: "zz-a", pinnedTabs: [pinned("p", picks)] },
        panelExtension,
      ],
    });
    await run(r, "/panel");
    await r.press(KEYS.left);
    expect(picks).toEqual([]);
  });
});

describe("an extension's Background", () => {
  function backgroundFeature(events: string[]): Extension {
    function Background() {
      const ctx = useShell();
      useAction("review.open", () => events.push(`review in ${ctx.locale}`));
      useInput(() => {});
      useEffect(() => {
        events.push("mounted");
        return () => {
          events.push("unmounted");
        };
      }, []);
      return <Text>BACKGROUND TEXT</Text>;
    }
    return { id: "zz-bg", Background };
  }

  it("is mounted with the shell, binds keys, takes no room, and stops under a layer", async () => {
    const events: string[] = [];
    const r = await app({
      extensions: [backgroundFeature(events), panelExtension],
    });
    expect(events).toEqual(["mounted"]);
    expect(plain(r)).not.toContain("BACKGROUND TEXT");
    await r.press("\u0012"); // ctrl+r: review.open in the test settings
    expect(events).toEqual(["mounted", "review in en"]);
    await run(r, "/panel");
    await r.press("\u0012");
    expect(events).toEqual(["mounted", "review in en"]);
  });

  it("stops behind the reconnecting cover", async () => {
    const events: string[] = [];
    const r = await app({ extensions: [backgroundFeature(events)] });
    r.controller.setPhase({
      name: "reconnecting",
      url: TEST_URL,
      temporary: false,
      since: Date.now(),
    });
    await flush();
    await r.press("\u0012");
    expect(events).toEqual(["mounted"]);
  });

  it("is unmounted when the shell goes away", async () => {
    const events: string[] = [];
    const r = await app({ extensions: [backgroundFeature(events)] });
    r.controller.patch({
      phase: {
        name: "unreachable",
        url: TEST_URL,
        reason: "timeout",
        output: undefined,
      },
      wire: undefined,
    });
    await flush();
    expect(events).toEqual(["mounted", "unmounted"]);
  });
});
