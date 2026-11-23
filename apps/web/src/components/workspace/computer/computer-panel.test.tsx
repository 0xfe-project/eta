import type { ComputerRealmView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setLanguagePreference } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { cleanup, click, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { ActiveRealmsBar } from "./active-realms-bar";
import { ComputerPanel } from "./computer-panel";
import { ComputerStrip } from "./computer-strip";

function createSampleRealm(
  overrides: Partial<ComputerRealmView> = {},
): ComputerRealmView {
  return {
    id: "r1",
    kind: "browser",
    tier: "cdp",
    machineId: "local",
    sessionId: "s1",
    agentName: "Navigator",
    title: "Checkout Page",
    target: "https://shop.example.com",
    viewport: { width: 1000, height: 500 },
    controller: "agent",
    epoch: 1,
    cursor: { x: 200, y: 400, kind: "move", label: "Continue", at: 100 },
    picker: { status: "idle", files: [], updatedAt: 100 },
    summary: "Filled shipping address",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  setLanguagePreference("en");
});

describe("<ComputerStrip /> and <ComputerPanel />", () => {
  it("renders folded <ComputerStrip /> with status and summary without subscribing to computer.<realmId> frame stream until expanded", async () => {
    setLanguagePreference("en");
    const initialRealm = createSampleRealm();
    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        realms: [initialRealm],
        capabilities: [],
      })
      .target("computer.r1", {
        info: initialRealm,
      })
      .install();

    host.hello();

    const { container } = await mount(<ComputerStrip realmId="r1" />);

    const strip = container.querySelector<HTMLElement>(
      '[data-slot="computer-strip"]',
    );
    expect(strip).not.toBeNull();
    expect(strip!.dataset.controller).toBe("agent");
    expect(strip!.textContent).toContain("Checkout Page");
    expect(strip!.textContent).toContain("Filled shipping address");
    expect(strip!.textContent).toContain("Agent working");

    const subscribedTargets = host.socket
      .framesOf("subscribe")
      .map((frame) => frame.target);
    expect(subscribedTargets).toContain("computer");
    expect(subscribedTargets).not.toContain("computer.r1");
  });

  it("subscribes to computer.<realmId> only when <ComputerPanel /> is expanded and unsubscribes when collapsed", async () => {
    setLanguagePreference("en");
    const initialRealm = createSampleRealm();
    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        realms: [initialRealm],
        capabilities: [],
      })
      .target("computer.r1", {
        info: initialRealm,
      })
      .install();

    host.hello();

    const { container } = await mount(
      <ComputerPanel realmId="r1" defaultOpen={false} />,
    );

    // Initially collapsed as <ComputerStrip />: no subscription to computer.r1
    expect(
      container.querySelector('[data-slot="computer-strip"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-slot="computer-panel"]')).toBeNull();
    expect(
      host.socket
        .framesOf("subscribe")
        .some((frame) => frame.target === "computer.r1"),
    ).toBe(false);

    // Click "Expand view" -> subscribes to computer.r1
    const expandBtn = container.querySelector(
      '[data-slot="computer-strip-expand"]',
    );
    await click(expandBtn);

    expect(
      container.querySelector('[data-slot="computer-panel"]'),
    ).not.toBeNull();
    expect(
      host.socket
        .framesOf("subscribe")
        .some((frame) => frame.target === "computer.r1"),
    ).toBe(true);

    // Click "Collapse view" -> unsubscribes from computer.r1
    const collapseBtn = container.querySelector(
      '[data-slot="computer-panel-collapse"]',
    );
    await click(collapseBtn);

    expect(container.querySelector('[data-slot="computer-panel"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="computer-strip"]'),
    ).not.toBeNull();
    expect(
      host.socket
        .framesOf("unsubscribe")
        .some((frame) => frame.target === "computer.r1"),
    ).toBe(true);
  });

  it("handles single-writer control flow: Take over -> user mode -> forwards viewport input to computer.<id>.input -> Hand back calls computer.<id>.release", async () => {
    setLanguagePreference("en");
    let currentRealm = createSampleRealm();

    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        realms: [currentRealm],
        capabilities: [],
      })
      .target("computer.r1", {
        info: currentRealm,
      })
      .handle("computer.r1.takeover", () => {
        currentRealm = {
          ...currentRealm,
          controller: "user",
          epoch: currentRealm.epoch + 1,
          summary: "User took over control",
        };
        host.set("computer", { realms: [currentRealm] });
        host.set("computer.r1", { info: currentRealm });
        return currentRealm;
      })
      .handle("computer.r1.input", () => currentRealm)
      .handle("computer.r1.release", () => {
        currentRealm = {
          ...currentRealm,
          controller: "agent",
          epoch: currentRealm.epoch + 1,
          summary: "Handed back to agent",
        };
        host.set("computer", { realms: [currentRealm] });
        host.set("computer.r1", { info: currentRealm });
        return currentRealm;
      })
      .install();

    host.hello();

    const { container } = await mount(
      <ComputerPanel realmId="r1" defaultOpen={true} />,
    );

    const panel = container.querySelector<HTMLElement>(
      '[data-slot="computer-panel"]',
    );
    expect(panel).not.toBeNull();
    expect(panel!.dataset.controller).toBe("agent");
    expect(
      container.querySelector('[data-slot="agent-cursor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="computer-input-layer"]'),
    ).toBeNull();

    // 1. Click "Take over"
    const takeoverBtn = container.querySelector(
      '[data-slot="computer-action-takeover"]',
    );
    expect(takeoverBtn).not.toBeNull();
    await click(takeoverBtn);
    await flush();

    expect(
      host.calls.some(
        (call) =>
          call.target === "computer.r1" &&
          call.action === "takeover" &&
          (call.args as { realmId?: string })?.realmId === "r1",
      ),
    ).toBe(true);

    // 2. UI switches to "user" controller mode
    expect(panel!.dataset.controller).toBe("user");
    expect(container.querySelector('[data-slot="agent-cursor"]')).toBeNull();

    const inputLayer = container.querySelector<HTMLElement>(
      '[data-slot="computer-input-layer"]',
    );
    expect(inputLayer).not.toBeNull();

    inputLayer!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1000,
        height: 500,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    // 3. User clicks and types inside viewport -> forwarded to computer.r1.input
    await act(async () => {
      inputLayer!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 500, clientY: 250 }),
      );
      inputLayer!.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });
    await flush();

    const inputCalls = host.calls.filter(
      (call) => call.target === "computer.r1" && call.action === "input",
    );
    expect(inputCalls.map((call) => call.args)).toEqual([
      { realmId: "r1", input: { kind: "click", x: 500, y: 500 } },
      { realmId: "r1", input: { kind: "key", key: "Enter" } },
    ]);

    // 4. Click "Hand back" -> calls computer.r1.release and restores agent mode
    const releaseBtn = container.querySelector(
      '[data-slot="computer-action-release"]',
    );
    expect(releaseBtn).not.toBeNull();
    await click(releaseBtn);
    await flush();

    expect(
      host.calls.some(
        (call) =>
          call.target === "computer.r1" &&
          call.action === "release" &&
          (call.args as { realmId?: string })?.realmId === "r1",
      ),
    ).toBe(true);
    expect(panel!.dataset.controller).toBe("agent");
    expect(
      container.querySelector('[data-slot="agent-cursor"]'),
    ).not.toBeNull();
  });

  it("pauses, resumes, and closes a realm from the panel: stop keeps the desktop, close gives it back", async () => {
    setLanguagePreference("en");
    let currentRealm = createSampleRealm();
    let host: FakeHost;

    const push = (overrides: Partial<ComputerRealmView>): ComputerRealmView => {
      currentRealm = { ...currentRealm, ...overrides };
      host.set("computer", { realms: [currentRealm] });
      host.set("computer.r1", { info: currentRealm });
      return currentRealm;
    };

    host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", { realms: [currentRealm], capabilities: [] })
      .target("computer.r1", { info: currentRealm })
      .handle("computer.r1.pause", () =>
        push({ controller: "paused", epoch: 2, summary: "Paused realm" }),
      )
      .handle("computer.r1.resume", () =>
        push({
          controller: "agent",
          epoch: 3,
          summary: "Resumed agent control",
        }),
      )
      .handle("computer.r1.close", () =>
        push({ controller: "closed", epoch: 4, summary: "Closed realm" }),
      )
      .install();

    host.hello();

    const { container } = await mount(
      <ComputerPanel realmId="r1" defaultOpen={true} />,
    );
    const panel = container.querySelector<HTMLElement>(
      '[data-slot="computer-panel"]',
    );
    expect(panel!.dataset.controller).toBe("agent");

    await click(container.querySelector('[data-slot="computer-action-pause"]'));
    await flush();
    expect(panel!.dataset.controller).toBe("paused");
    expect(
      container.querySelector('[data-slot="computer-input-layer"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="computer-action-resume"]'),
    ).not.toBeNull();

    await click(
      container.querySelector('[data-slot="computer-action-resume"]'),
    );
    await flush();
    expect(panel!.dataset.controller).toBe("agent");

    await click(container.querySelector('[data-slot="computer-action-close"]'));
    await flush();
    const closedPanel = container.querySelector<HTMLElement>(
      '[data-slot="computer-panel"]',
    );
    expect(closedPanel!.dataset.controller).toBe("closed");
    // Closed panel collapses into a compact bar with no viewport or control strip.
    expect(
      container.querySelector('[data-slot="computer-viewport"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="computer-panel-controls"]'),
    ).toBeNull();
    expect(
      host.calls
        .map((call) => call.action)
        .filter((action) => ["pause", "resume", "close"].includes(action)),
    ).toEqual(["pause", "resume", "close"]);
  });

  it("renders ActiveRealmsBar for open realms, listing other conversations last, and switches tabs", async () => {
    setLanguagePreference("en");
    const realmA = createSampleRealm({
      id: "r_a",
      conversationId: "conv_1",
      title: "Notepad A",
    });
    const realmB = createSampleRealm({
      id: "r_b",
      conversationId: "conv_1",
      title: "Browser B",
    });
    const realmClosed = createSampleRealm({
      id: "r_closed",
      conversationId: "conv_1",
      controller: "closed",
      title: "Closed C",
    });
    const realmOther = createSampleRealm({
      id: "r_other",
      conversationId: "conv_2",
      title: "Other Conv",
    });

    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        realms: [realmA, realmB, realmClosed, realmOther],
        capabilities: [],
      })
      .install();

    host.hello();

    const { container } = await mount(
      <ActiveRealmsBar conversationId="conv_1" />,
    );
    const tabs = container.querySelectorAll('[data-slot="active-realm-tab"]');
    // Closed realms are hidden; another conversation's realm stays reachable, listed last.
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.textContent).toBe("Notepad A");
    expect(tabs[1]?.textContent).toBe("Browser B");
    expect(tabs[2]?.textContent).toBe("Other Conv");
    expect(tabs[2]?.getAttribute("data-other-conversation")).toBe("true");
    expect(tabs[0]?.getAttribute("data-other-conversation")).toBeNull();

    await click(tabs[1]);
    await flush();
    expect(
      container.querySelector('[data-slot="computer-strip-title"]')
        ?.textContent,
    ).toBe("Browser B");
  });

  it("keeps a realm from another conversation reachable when it is the only one running", async () => {
    setLanguagePreference("en");
    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        // The app outlives its conversation (and the host): hiding it would leave no way back.
        realms: [
          createSampleRealm({
            id: "r_other",
            conversationId: "conv_2",
            title: "Orphan",
          }),
        ],
        capabilities: [],
      })
      .install();

    host.hello();

    const { container } = await mount(
      <ActiveRealmsBar conversationId="conv_1" />,
    );
    expect(
      container.querySelector('[data-slot="active-realms-bar"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="computer-strip"]')?.textContent,
    ).toContain("Orphan");
  });

  it("hides cleanly when computer plugin is not mounted in hello.mounted", async () => {
    const host = new FakeHost()
      .plugins([])
      .target("computer", { realms: [createSampleRealm()], capabilities: [] })
      .install();

    host.hello();

    const { container } = await mount(
      <ComputerPanel realmId="r1" defaultOpen={true} />,
    );
    expect(container.querySelector('[data-slot="computer-panel"]')).toBeNull();
    expect(container.querySelector('[data-slot="computer-strip"]')).toBeNull();
  });
});
