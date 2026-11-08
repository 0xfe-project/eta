/**
 * Parts of the first-time setup on a wire whose state the test writes, for states a real test
 * host cannot be put in: a model gateway whose accounts are not ready yet when the interface
 * connects (the test host's gateway is ready before any client arrives), a host without the
 * providers plugin (`startHost` always mounts it), and an `agents.create` held unanswered for as
 * long as a test needs (the real host answers before a key can land in between).
 */
import type { AgentView, LlmAccounts, LlmModel } from "@eta/client-contracts";
import type { TargetState, WireState } from "../../src/connection/types";
import type { ShellContext } from "../../src/extensions/types";
import { describe, expect, it, vi } from "vitest";
import { readSetupFacts } from "../../src/ext/setup/first-run";
import { SetupLayer } from "../../src/ext/setup/setup-layer";
import { RunningShellContext } from "../../src/extensions/react";
import { renderKit } from "../ext-support/render-kit";
import { fakeWire } from "../ui-support/fake-wire";
import { flush, KEYS, plain } from "../ui-support/render";

function target(sections: Record<string, unknown>): TargetState {
  return { sections, revisions: {}, version: 1 };
}

const AGENT = { id: "a1", name: "Ada", persona: "" } as AgentView;

const NOT_READY: LlmAccounts = {
  ready: false,
  connectors: [],
  connections: [],
};
const READY: LlmAccounts = {
  ready: true,
  connectors: [{ id: "gemini", name: "Google AI Studio", flow: "api_key" }],
  connections: [],
};
const GEMINI: LlmModel = {
  id: "g1",
  connector: "gemini",
  name: "G1",
  status: "available",
  available: true,
};

/** Everything the check reads has come, except what `llm` says. */
function hostState(llm: Record<string, unknown>): Partial<WireState> {
  return {
    mounted: [
      { name: "providers", source: "bundled" },
      { name: "llm", source: "bundled" },
    ] as WireState["mounted"],
    targets: {
      providers: target({ config: { providers: [], revision: "r" } }),
      personas: target({ cards: [] }),
      agents: target({ list: [AGENT] }),
      llm: target(llm),
    },
  };
}

/** A fake wire that keeps which targets are held now and which were ever asked for. */
function trackedWire(state: Partial<WireState>) {
  const wire = fakeWire(state);
  const asked: string[] = [];
  const held = new Map<string, number>();
  wire.subscribe = (name) => {
    asked.push(name);
    held.set(name, (held.get(name) ?? 0) + 1);
    return () => held.set(name, (held.get(name) ?? 1) - 1);
  };
  const holds = (name: string) => (held.get(name) ?? 0) > 0;
  return { wire, asked, holds };
}

describe("readSetupFacts with the model gateway", () => {
  it("waits for the gateway's accounts to be ready, holding the gateway's target meanwhile", async () => {
    const { wire, asked, holds } = trackedWire(
      hostState({ accounts: NOT_READY, models: [] }),
    );
    let facts: Awaited<ReturnType<typeof readSetupFacts>> | "pending" =
      "pending";
    const reading = readSetupFacts(wire, "en", 5_000).then((found) => {
      facts = found;
    });
    await flush();
    expect(facts).toBe("pending");
    expect(asked).toContain("llm");
    expect(holds("llm")).toBe(true);

    wire.store.setState((state) => ({
      targets: {
        ...state.targets,
        llm: target({ accounts: READY, models: [GEMINI] }),
      },
    }));
    await reading;
    expect(facts).not.toBe("pending");
    const found = facts as unknown as Awaited<
      ReturnType<typeof readSetupFacts>
    >;
    expect(found?.models.map((model) => [model.id, model.available])).toEqual([
      ["llm:g1", true],
    ]);
    expect(holds("llm")).toBe(false);
  });

  it("gives up after its deadline and lets every target go", async () => {
    const { wire, holds } = trackedWire(
      hostState({ accounts: NOT_READY, models: [] }),
    );
    expect(await readSetupFacts(wire, "en", 50)).toBeUndefined();
    for (const name of ["providers", "personas", "agents", "llm"])
      expect(holds(name)).toBe(false);
  });
});

describe("readSetupFacts with copies the host is not keeping up to date", () => {
  /** A copy that came with `hello`, or whose last reader left: version 0. */
  function unfollowed(sections: Record<string, unknown>): TargetState {
    return { sections, revisions: {}, version: 0 };
  }

  it("waits past a hello copy of the agents and decides on the list the host sends after it subscribed", async () => {
    const state = hostState({ accounts: READY, models: [GEMINI] });
    state.targets!.agents = unfollowed({ list: [] });
    const { wire, asked } = trackedWire(state);
    let facts: Awaited<ReturnType<typeof readSetupFacts>> | "pending" =
      "pending";
    const reading = readSetupFacts(wire, "en", 5_000).then((found) => {
      facts = found;
    });
    await flush();
    expect(asked).toContain("agents");
    expect(facts).toBe("pending");

    wire.store.setState((current) => ({
      targets: { ...current.targets, agents: target({ list: [AGENT] }) },
    }));
    await reading;
    expect(
      (facts as unknown as Awaited<ReturnType<typeof readSetupFacts>>)?.agents,
    ).toEqual([AGENT]);
  });

  it.each(["providers", "personas", "agents", "llm"])(
    "does not decide while the %s copy is one the host is not keeping up to date",
    async (name) => {
      const state = hostState({ accounts: READY, models: [GEMINI] });
      const held = state.targets![name]!;
      state.targets![name] = unfollowed(held.sections);
      const { wire, holds } = trackedWire(state);
      expect(await readSetupFacts(wire, "en", 50)).toBeUndefined();
      expect(holds(name)).toBe(false);
    },
  );
});

describe("the setup layer without the providers' config", () => {
  function renderLayer(state: Partial<WireState>) {
    const wire = fakeWire(state);
    const notes: string[] = [];
    let closed = 0;
    const ctx = {
      wire,
      locale: "en",
      notify: (text: string) => notes.push(text),
    } as unknown as ShellContext;
    const r = renderKit(
      <RunningShellContext value={ctx}>
        <SetupLayer handle={{ close: () => (closed += 1) }} />
      </RunningShellContext>,
      { columns: 100 },
    );
    return { r, notes, closed: () => closed };
  }

  it("says the host has no providers plugin, and leaves on Esc", async () => {
    const { r, notes, closed } = renderLayer({ mounted: [] });
    await flush();
    expect(plain(r)).toContain("This host has no providers plugin");
    expect(plain(r)).not.toContain("Reading the host");
    await r.press(KEYS.escape);
    expect(closed()).toBe(1);
    expect(notes.join("\n")).toContain("/setup");
  });

  it("passes on the providers plugin's load error", async () => {
    const { r } = renderLayer({
      mounted: [
        {
          name: "providers",
          source: "bundled",
          error: "config.json is broken",
        },
      ] as WireState["mounted"],
    });
    await flush();
    expect(plain(r)).toContain("config.json is broken");
  });

  it("leaves on Esc while it is still reading the host", async () => {
    const { r, closed } = renderLayer({
      mounted: [
        { name: "providers", source: "bundled" },
      ] as WireState["mounted"],
    });
    await flush();
    expect(plain(r)).toContain("Reading the host");
    await r.press(KEYS.escape);
    expect(closed()).toBe(1);
  });
});

describe("the agents step while it creates", () => {
  // Ids differ from names: a step that matched agents to cards by name would show.
  const card = (name: string) => ({
    id: `p-${name}`,
    name,
    description: "",
    custom: false,
  });

  /**
   * A host with a usable model, three cards, no agents, and creates the test answers. `agents`
   * is the copy of the agents the wire holds at first.
   */
  function renderCreating(
    agents: TargetState = target({ list: [] as AgentView[] }),
  ) {
    const wire = fakeWire({
      mounted: [
        { name: "providers", source: "bundled" },
      ] as WireState["mounted"],
      targets: {
        providers: target({
          config: {
            providers: [
              {
                id: "local",
                kind: "openai-compatible",
                hasApiKey: false,
                models: [{ id: "m1" }],
              },
            ],
            revision: "r",
          },
        }),
        personas: target({ cards: [card("Ann"), card("Bea"), card("Cat")] }),
        agents,
      },
    });
    const creates: { name: string; answer: (failure?: Error) => void }[] = [];
    wire.call = (async (_target: string, _action: string, args?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        creates.push({
          name: (args as { name: string }).name,
          answer: (failure) =>
            failure === undefined ? resolve({ agent: {} }) : reject(failure),
        });
      })) as typeof wire.call;
    const notes: string[] = [];
    const ctx = {
      wire,
      locale: "en",
      notify: (text: string) => notes.push(text),
    } as unknown as ShellContext;
    const r = renderKit(
      <RunningShellContext value={ctx}>
        <SetupLayer handle={{ close: () => undefined }} />
      </RunningShellContext>,
      { columns: 100 },
    );
    const line = (name: string) =>
      plain(r)
        .split("\n")
        .find((row) => row.includes(` ${name}`)) ?? "";
    return { r, creates, notes, line, wire };
  }

  /** An agent wearing the card named `name`, under another name. */
  const wearing = (name: string) =>
    ({
      id: `agent-${name}`,
      name: `${name} agent`,
      persona: `p-${name}`,
    }) as AgentView;

  it("takes no ticks while a create is unanswered, and keeps the ticks made before it", async () => {
    const { r, creates, line } = renderCreating();
    await flush();
    expect(line("Bea")).toContain("[x]");
    // Untick Bea before creating, then leave the marker on Cat.
    await r.press(KEYS.down);
    await r.press(" ");
    expect(line("Bea")).toContain("[ ]");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await flush();
    expect(creates.map((create) => create.name)).toEqual(["Ann"]);

    // Ann's create hangs: Space on Cat changes nothing.
    await r.press(" ");
    await flush();
    expect(line("Cat")).toContain("[x]");
    expect(line("Bea")).toContain("[ ]");

    // The host refuses Ann: the step stays, with the ticks as they were before Enter.
    creates[0]?.answer(new Error("refused"));
    await flush();
    expect(plain(r)).toContain("refused");
    expect(line("Ann")).toContain("[x]");
    expect(line("Bea")).toContain("[ ]");
    expect(line("Cat")).toContain("[x]");

    // Again, answered this time: Ann and Cat, never Bea.
    await r.press(KEYS.enter);
    await flush();
    creates[1]?.answer();
    await flush();
    creates[2]?.answer();
    await flush();
    expect(creates.map((create) => create.name)).toEqual(["Ann", "Ann", "Cat"]);
  });

  it("skips a card that got an agent on the host while an earlier card was being created", async () => {
    const { r, creates, wire } = renderCreating();
    await flush();
    await r.press(KEYS.enter);
    await flush();
    expect(creates.map((create) => create.name)).toEqual(["Ann"]);

    // Another client gives Bea an agent while Ann's create is unanswered.
    wire.store.setState((state) => ({
      targets: {
        ...state.targets,
        agents: target({ list: [wearing("Bea")] }),
      },
    }));
    creates[0]?.answer();
    await flush();
    creates[1]?.answer();
    await flush();
    expect(creates.map((create) => create.name)).toEqual(["Ann", "Cat"]);
  });

  it("on Enter over a hello copy of the agents, creates nothing until the host's list comes, then skips the cards it shows worn", async () => {
    const { r, creates, wire } = renderCreating({
      sections: { list: [] },
      revisions: {},
      version: 0,
    });
    await flush();
    await r.press(KEYS.enter);
    await flush();
    expect(creates).toEqual([]);

    wire.store.setState((state) => ({
      targets: {
        ...state.targets,
        agents: target({ list: [wearing("Ann")] }),
      },
    }));
    await flush();
    creates[0]?.answer();
    await flush();
    creates[1]?.answer();
    await flush();
    expect(creates.map((create) => create.name)).toEqual(["Bea", "Cat"]);
  });

  it("when the host's list does not come in time, creates nothing, says so, and creates on Enter once it has come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { r, creates, wire, line } = renderCreating({
        sections: { list: [] },
        revisions: {},
        version: 0,
      });
      await flush();
      await r.press(KEYS.enter);
      await flush();
      vi.advanceTimersByTime(10_000);
      await flush();
      expect(plain(r)).toContain("Cannot read the host's agents right now");
      expect(creates).toEqual([]);
      // Not busy any more: a tick changes again.
      await r.press(" ");
      await flush();
      expect(line("Ann")).toContain("[ ]");
      await r.press(" ");
      await flush();
      expect(line("Ann")).toContain("[x]");

      wire.store.setState((state) => ({
        targets: {
          ...state.targets,
          agents: target({ list: [wearing("Ann")] }),
        },
      }));
      await flush();
      await r.press(KEYS.enter);
      await flush();
      creates[0]?.answer();
      await flush();
      creates[1]?.answer();
      await flush();
      expect(creates.map((create) => create.name)).toEqual(["Bea", "Cat"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
