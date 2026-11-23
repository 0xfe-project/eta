import type { ComputerUserInput } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  isPluginMounted,
  useComputer,
  useComputerRealm,
} from "@/queries/computer";
import { cleanup, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { ComputerViewport } from "./computer-viewport";

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("<ComputerViewport />", () => {
  it("renders normalized 0..1000 cursor coordinates at 25%, 75% with agent badge and 60ms linear transition class", async () => {
    const { container } = await mount(
      <ComputerViewport
        controller="agent"
        agentName="Analyst"
        viewport={{ width: 1280, height: 800 }}
        cursor={{
          x: 250,
          y: 750,
          kind: "click",
          label: "Submit",
          at: 1000,
        }}
      />,
    );

    const cursorEl = container.querySelector<HTMLElement>(
      '[data-slot="agent-cursor"]',
    );
    expect(cursorEl).not.toBeNull();
    expect(cursorEl!.style.left).toBe("25%");
    expect(cursorEl!.style.top).toBe("75%");
    expect(cursorEl!.className).toContain("transition-[left,top]");
    expect(cursorEl!.className).toContain("duration-[60ms]");
    expect(cursorEl!.className).toContain("ease-linear");
    expect(cursorEl!.className).toContain("motion-reduce:transition-none");

    const badgeEl = container.querySelector('[data-slot="agent-cursor-badge"]');
    expect(badgeEl?.textContent).toContain("Analyst");
    expect(badgeEl?.textContent).toContain("Submit");

    const pulseEl = container.querySelector('[data-slot="agent-cursor-pulse"]');
    expect(pulseEl).not.toBeNull();
    expect(pulseEl!.className).toContain("motion-reduce:animate-none");
  });

  it("shows the agent cursor in agent controller mode and does NOT emit onUserInput on user clicks", async () => {
    const inputs: ComputerUserInput[] = [];
    const { container } = await mount(
      <ComputerViewport
        controller="agent"
        viewport={{ width: 1000, height: 500 }}
        cursor={{ x: 500, y: 500, kind: "move", at: 1000 }}
        onUserInput={(input) => inputs.push(input)}
      />,
    );

    expect(
      container.querySelector('[data-slot="agent-cursor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="computer-input-layer"]'),
    ).toBeNull();

    const root = container.querySelector<HTMLElement>(
      '[data-slot="computer-viewport"]',
    )!;
    await act(async () => {
      root.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 100 }),
      );
    });

    expect(inputs).toEqual([]);
  });

  it("hides the agent cursor in user takeover mode and emits normalized 0..1000 ComputerUserInput events on click and typing", async () => {
    const inputs: ComputerUserInput[] = [];
    const { container } = await mount(
      <ComputerViewport
        controller="user"
        viewport={{ width: 800, height: 400 }}
        cursor={{ x: 500, y: 500, kind: "move", at: 1000 }}
        onUserInput={(input) => inputs.push(input)}
      />,
    );

    expect(container.querySelector('[data-slot="agent-cursor"]')).toBeNull();

    const inputLayer = container.querySelector<HTMLElement>(
      '[data-slot="computer-input-layer"]',
    );
    expect(inputLayer).not.toBeNull();

    inputLayer!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 400,
        right: 800,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    await act(async () => {
      inputLayer!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 300 }),
      );
      inputLayer!.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
      );
      inputLayer!.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });

    expect(inputs).toEqual([
      { kind: "click", x: 250, y: 750 },
      { kind: "type", text: "a" },
      { kind: "key", key: "Enter" },
    ]);
  });

  it("renders the silent picker status bar when picker.status === 'intercepted_silent' with the injected filename", async () => {
    const { container } = await mount(
      <ComputerViewport
        controller="agent"
        cursor={{ x: 100, y: 100, kind: "move", at: 1000 }}
        picker={{
          status: "intercepted_silent",
          mode: "open_single",
          files: ["invoice-2026.pdf"],
          updatedAt: 2000,
        }}
      />,
    );

    const pickerBar = container.querySelector<HTMLElement>(
      '[data-slot="computer-picker-bar"]',
    );
    expect(pickerBar).not.toBeNull();
    expect(pickerBar!.dataset.status).toBe("intercepted_silent");
    expect(pickerBar!.textContent).toContain("intercepted_silent");
    expect(pickerBar!.textContent).toContain("invoice-2026.pdf");
  });

  it("flips agent cursor badge near right/bottom edges, supports Ctrl+Shift+V host paste, and shows approval review button", async () => {
    let pasted = 0;
    let reviewed = 0;
    const { container, show } = await mount(
      <ComputerViewport
        controller="agent"
        agentName="Navigator"
        viewport={{ width: 1280, height: 800 }}
        cursor={{ x: 920, y: 920, kind: "move", label: "Save", at: 10 }}
        picker={{
          status: "awaiting_approval",
          files: ["secret.txt"],
          updatedAt: 10,
        }}
        onReviewApproval={() => {
          reviewed += 1;
        }}
      />,
    );

    const badge = container.querySelector<HTMLElement>(
      '[data-slot="agent-cursor-badge"]',
    );
    expect(badge?.dataset.flipLeft).toBe("true");
    expect(badge?.dataset.flipUp).toBe("true");

    const reviewBtn = container.querySelector<HTMLButtonElement>(
      '[data-slot="computer-picker-review"]',
    );
    expect(reviewBtn).not.toBeNull();
    await act(async () => {
      reviewBtn!.click();
    });
    expect(reviewed).toBe(1);

    await show(
      <ComputerViewport
        controller="user"
        viewport={{ width: 1280, height: 800 }}
        onUserInput={() => {}}
        onPasteFromHost={() => {
          pasted += 1;
        }}
      />,
    );
    expect(
      container.querySelector('[data-slot="computer-takeover-hint"]'),
    ).not.toBeNull();
    const inputLayer = container.querySelector<HTMLElement>(
      '[data-slot="computer-input-layer"]',
    )!;
    await act(async () => {
      inputLayer.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "V",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(pasted).toBe(1);
  });

  it("checks hello.mounted via isPluginMounted('computer') and streams computer.<realmId> state and ephemeral events", async () => {
    const host = new FakeHost()
      .plugins([{ name: "computer", source: "bundled" }])
      .target("computer", {
        realms: [
          {
            id: "r1",
            kind: "browser",
            tier: "cdp",
            machineId: "local",
            sessionId: "s1",
            agentName: "Navigator",
            title: "Docs",
            target: "https://example.com",
            viewport: { width: 1280, height: 800 },
            controller: "agent",
            epoch: 1,
            cursor: { x: 100, y: 200, kind: "move", at: 10 },
            picker: { status: "idle", files: [], updatedAt: 10 },
            summary: "Opened page",
            createdAt: 10,
            updatedAt: 10,
          },
        ],
        capabilities: [],
      })
      .target("computer.r1", {
        info: {
          id: "r1",
          kind: "browser",
          tier: "cdp",
          machineId: "local",
          sessionId: "s1",
          agentName: "Navigator",
          title: "Docs",
          target: "https://example.com",
          viewport: { width: 1280, height: 800 },
          controller: "agent",
          epoch: 1,
          cursor: { x: 100, y: 200, kind: "move", at: 10 },
          picker: { status: "idle", files: [], updatedAt: 10 },
          summary: "Opened page",
          createdAt: 10,
          updatedAt: 10,
        },
      })
      .install();

    host.hello();
    expect(isPluginMounted("computer")).toBe(true);
    expect(isPluginMounted("unmounted_plugin")).toBe(false);

    function Harness() {
      const root = useComputer();
      const realm = useComputerRealm("r1");
      if (!root.mounted || !realm.info) return null;
      return (
        <ComputerViewport
          controller={realm.info.controller}
          agentName={realm.info.agentName}
          viewport={realm.info.viewport}
          frame={realm.frame}
          cursor={realm.cursor}
          picker={realm.picker}
          title={realm.info.title}
        />
      );
    }

    const { container } = await mount(<Harness />);
    const cursorEl = container.querySelector<HTMLElement>(
      '[data-slot="agent-cursor"]',
    );
    expect(cursorEl?.style.left).toBe("10%");
    expect(cursorEl?.style.top).toBe("20%");

    await act(async () => {
      host.socket.receive({
        type: "event",
        target: "computer.r1",
        name: "cursor",
        data: {
          realmId: "r1",
          epoch: 1,
          x: 600,
          y: 400,
          kind: "click",
          at: 20,
        },
      });
      host.socket.receive({
        type: "event",
        target: "computer.r1",
        name: "picker",
        data: {
          realmId: "r1",
          status: "intercepted_silent",
          files: ["report.csv"],
          updatedAt: 25,
        },
      });
    });

    expect(cursorEl?.style.left).toBe("60%");
    expect(cursorEl?.style.top).toBe("40%");
    expect(
      container.querySelector('[data-slot="computer-picker-bar"]')?.textContent,
    ).toContain("report.csv");
  });
});
