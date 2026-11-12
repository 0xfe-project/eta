/**
 * A layer lives only in the shell it was opened in: a command or a feature that opens one after
 * its shell went away (or on a context kept from an earlier shell) opens nothing, also when a new
 * shell shows by then.
 */
import type { UpgradeBusy } from "@eta/client-contracts";
import type { ConnectionPhase } from "../src/connection/types";
import type { Extension, ShellContext } from "../src/extensions/types";
import { Text } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp, TEST_URL } from "./ui-support/app";
import { loaded, testConfig } from "./ui-support/config";
import { fakeWire } from "./ui-support/fake-wire";
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

const NEW_URL = "http://127.0.0.1:7777";
/** Text of the /install-service question, from its message catalog. */
const HANDOVER_QUESTION = "work in progress may be interrupted";

const temporaryExited: ConnectionPhase = {
  name: "unreachable",
  url: TEST_URL,
  reason: "temporary-exited",
  output: "bye",
};

const givenUp: ConnectionPhase = {
  name: "unreachable",
  url: TEST_URL,
  reason: "timeout",
  output: undefined,
};

async function run(r: Awaited<ReturnType<typeof app>>, line: string) {
  await r.type(line);
  await r.press(KEYS.enter);
  await flush();
}

/** `handoverBusy` that answers only when the test says so, as `upgrade.check` waits on GitHub. */
function holdHandoverBusy(r: Awaited<ReturnType<typeof app>>) {
  let answer: (busy: UpgradeBusy[] | undefined) => void = () => {};
  r.controller.handoverBusy = () => {
    r.controller.calls.push("handoverBusy");
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  return (busy: UpgradeBusy[] | undefined) => answer(busy);
}

/** A command that keeps the context it was run with. */
function grabber(): { extension: Extension; ctx: () => ShellContext } {
  let seen: ShellContext | undefined;
  return {
    extension: {
      id: "zz-grab",
      commands: [
        {
          name: "grab",
          args: [],
          summary: { en: "Grab", zh: "取" },
          examples: [],
          requiredOps: [],
          run: (ctx) => {
            seen = ctx;
          },
        },
      ],
    },
    ctx: () => {
      if (!seen) throw new Error("/grab has not run");
      return seen;
    },
  };
}

describe("a layer opened after its shell went away", () => {
  it("is not shown over the next shell when /install-service hears back after the temporary host exited", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
      columns: 160,
    });
    const answer = holdHandoverBusy(r);
    await run(r, "/install-service");

    r.controller.patch({ phase: temporaryExited, wire: undefined });
    await flush();
    // The real handoverBusy answers undefined when its call fails.
    answer(undefined);
    await flush();

    await r.press(KEYS.enter); // "Use a temporary host" on the unreachable screen
    await flush();
    r.controller.patch({
      phase: { name: "connected", url: NEW_URL, temporary: true },
      wire: fakeWire(),
    });
    await flush();
    expect(plain(r)).toContain(NEW_URL);
    expect(plain(r)).not.toContain(HANDOVER_QUESTION);

    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "handoverBusy",
      "startTemporary persist=false",
    ]);
  });

  it("is not shown when /install-service hears back only once the next shell shows", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
      columns: 160,
    });
    const answer = holdHandoverBusy(r);
    await run(r, "/install-service");

    r.controller.patch({ phase: temporaryExited, wire: undefined });
    await flush();
    r.controller.patch({
      phase: { name: "connected", url: NEW_URL, temporary: true },
      wire: fakeWire(),
    });
    await flush();
    answer([{ kind: "task", name: "Build", number: 4 }]);
    await flush();
    expect(plain(r)).toContain(NEW_URL);
    expect(plain(r)).not.toContain(HANDOVER_QUESTION);
    expect(plain(r)).not.toContain("Tasks: 1");

    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).not.toContain("handover");
  });

  it("does not show /config's settings problems over the next shell when the connection was given up while the editor was open", async () => {
    let editorClosed: (code: number) => void = () => {};
    const r = await app({
      columns: 160,
      runProcess: () =>
        new Promise<number>((resolve) => {
          editorClosed = resolve;
        }),
      loadConfig: async () =>
        loaded(testConfig(), [
          { file: "/test/eta/tui.json", key: "colour", reason: "unknown-key" },
        ]),
    });
    await run(r, "/config");
    expect(r.launches).toHaveLength(1);

    r.controller.patch({ phase: givenUp, wire: undefined });
    await flush();
    r.controller.patch({
      phase: { name: "connected", url: NEW_URL, temporary: true },
      wire: fakeWire(),
    });
    await flush();
    editorClosed(0);
    await flush();
    expect(plain(r)).toContain(NEW_URL);
    expect(plain(r)).not.toContain("unknown key");
    expect(plain(r)).toContain("/help");
  });

  it("opens nothing on a context kept from an earlier shell, even when the same wire comes back", async () => {
    const grab = grabber();
    const r = await app({ extensions: [grab.extension] });
    await run(r, "/grab");
    const old = grab.ctx();
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

    const stale = old.openLayer(() => <Text>STALE LAYER</Text>);
    await flush();
    expect(plain(r)).not.toContain("STALE LAYER");

    // The context of the shell now showing opens layers, and the stale handle cannot close them.
    await run(r, "/grab");
    grab.ctx().openLayer(() => <Text>CURRENT LAYER</Text>);
    await flush();
    expect(plain(r)).toContain("CURRENT LAYER");
    stale.close();
    await flush();
    expect(plain(r)).toContain("CURRENT LAYER");
  });

  it("opens nothing while no shell shows, and nothing of it appears when the next one does", async () => {
    const grab = grabber();
    const r = await app({ extensions: [grab.extension] });
    await run(r, "/grab");
    const old = grab.ctx();
    r.controller.patch({ phase: givenUp, wire: undefined });
    await flush();

    old.openLayer(() => <Text>STALE LAYER</Text>);
    await flush();
    expect(plain(r)).toContain("Cannot connect");
    r.controller.patch({
      phase: { name: "connected", url: NEW_URL, temporary: false },
      wire: fakeWire(),
    });
    await flush();
    expect(plain(r)).not.toContain("STALE LAYER");
    expect(plain(r)).toContain(NEW_URL);
  });
});

describe("a layer opened from onConnected", () => {
  function opensOnConnect(): Extension {
    return {
      id: "zz-welcome",
      onConnected: (ctx) => {
        ctx.openLayer(() => <Text>WELCOME LAYER</Text>);
      },
    };
  }

  it("shows once the shell of that connection shows", async () => {
    const wire = fakeWire({ status: "connecting" });
    const r = await app({
      phase: { name: "connecting", url: TEST_URL, temporary: false },
      patch: { wire },
      extensions: [opensOnConnect()],
    });
    // The hello comes while the controller still says connecting.
    wire.store.setState({ status: "open" });
    await flush();
    r.controller.setPhase({
      name: "connected",
      url: TEST_URL,
      temporary: false,
    });
    await flush();
    expect(plain(r)).toContain("WELCOME LAYER");
  });

  it("is gone when that connection is given up before its shell shows", async () => {
    const wire = fakeWire({ status: "connecting" });
    const r = await app({
      phase: { name: "connecting", url: TEST_URL, temporary: false },
      patch: { wire },
      extensions: [
        {
          id: "zz-welcome",
          onConnected: (ctx, first) => {
            if (first) ctx.openLayer(() => <Text>WELCOME LAYER</Text>);
          },
        },
      ],
    });
    wire.store.setState({ status: "open" });
    await flush();
    r.controller.patch({ phase: givenUp, wire: undefined });
    await flush();
    r.controller.patch({
      phase: { name: "connected", url: NEW_URL, temporary: false },
      wire: fakeWire(),
    });
    await flush();
    expect(plain(r)).toContain(NEW_URL);
    expect(plain(r)).not.toContain("WELCOME LAYER");
  });
});
