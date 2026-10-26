import type { StructuralNode } from "../src/index";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ComputerTriadEngine,
  modelsDirPath,
  renderSyntheticUiFrame,
} from "../src/index";

describe("3-Model Edge Triad Experiments (UI Detector+64d Embed + Fast OCR + OpenJev System-1)", () => {
  let engine: ComputerTriadEngine;
  const WIDTH = 1280;
  const HEIGHT = 720;

  beforeAll(() => {
    engine = new ComputerTriadEngine();
  });

  afterAll(() => {
    engine.close();
  });

  it("experiment 1: Latency breakdown, 2D Atlas ROI packing, and xxHash OCR cache speedup", () => {
    const baseWidgets = [
      { bbox: { x: 80, y: 60, w: 220, h: 40 }, kind: "input" as const },
      { bbox: { x: 320, y: 60, w: 120, h: 40 }, kind: "button" as const },
      { bbox: { x: 80, y: 140, w: 160, h: 38 }, kind: "button" as const },
      { bbox: { x: 80, y: 200, w: 160, h: 38 }, kind: "toggle_on" as const },
    ];
    const nodes: StructuralNode[] = [
      {
        role: "searchbox",
        label: "Search packages",
        bbox: { x: 80, y: 60, w: 220, h: 40 },
        region: "header",
      },
      {
        role: "button",
        label: "Run Search",
        bbox: { x: 320, y: 60, w: 120, h: 40 },
        region: "header",
      },
      {
        role: "button",
        label: "Filter Active",
        bbox: { x: 80, y: 140, w: 160, h: 38 },
        region: "main",
      },
      {
        role: "switch",
        label: "Auto Refresh",
        bbox: { x: 80, y: 200, w: 160, h: 38 },
        region: "main",
      },
    ];

    const frame1 = renderSyntheticUiFrame(WIDTH, HEIGHT, baseWidgets);

    // Cold frame (full screen dirty -> populates OCR cache)
    const step1 = engine.step({
      currRgb: frame1,
      width: WIDTH,
      height: HEIGHT,
      subgoal: "Click the Search packages input box",
      nowMs: 1000,
      resetDelta: true,
      nextHint: {
        actionType: "click",
        targetLabelHint: "Search packages",
      },
      structuralNodes: nodes,
    });

    // Warm frame with localized dirty rect (input box focused)
    const focusedWidgets = [
      {
        bbox: { x: 80, y: 60, w: 220, h: 40 },
        kind: "input" as const,
        focused: true,
      },
      ...baseWidgets.slice(1),
    ];
    const frame2 = renderSyntheticUiFrame(WIDTH, HEIGHT, focusedWidgets);
    const step2 = engine.step({
      prevRgb: frame1,
      currRgb: frame2,
      width: WIDTH,
      height: HEIGHT,
      subgoal: "Type eta-core into Search packages",
      cursor: "ibeam",
      nowMs: 1400,
      nextHint: {
        actionType: "type",
        targetAnchorId: step1.chosenAnchorId ?? undefined,
        targetLabelHint: "Search packages",
        textArg: "eta-core",
      },
      structuralNodes: nodes.map((n, idx) =>
        idx === 0 ? { ...n, focused: true } : n,
      ),
    });

    expect(step1.ortVersion).toMatch(/^1\./);
    expect(["cuda", "directml", "coreml", "cpu"]).toContain(step1.provider);
    expect(step1.ocrProvider).toBe(step1.provider);
    // The INT8 verdict encoder loses to the CPU on short sequences, so a GPU machine keeps it there
    // unless ETA_COMPUTER_ENCODER_PROVIDER says otherwise.
    if (step1.provider === "cpu") {
      expect(step1.encoderProvider).toBe("cpu");
    }
    expect(step1.providerChain).toContain("cpu");
    expect(step2.dirty.dirtyAreaRatio).toBeLessThan(0.05);
    expect(step2.ocrCache.hits).toBeGreaterThan(0);
    expect(step2.timingsMs.detectorOrt).toBeLessThan(120);
    expect(step2.timingsMs.jevOrt).toBeLessThan(120);
    expect(step2.timingsMs.totalStep).toBeLessThan(400);

    // Third step repeats the same decision on a frame whose widget set is unchanged:
    // the detector is skipped and the encoder's verdict is reused, which is the fast path.
    const step3 = engine.step({
      prevRgb: frame2,
      currRgb: frame2,
      width: WIDTH,
      height: HEIGHT,
      subgoal: "Type eta-core into Search packages",
      cursor: "ibeam",
      nowMs: 1800,
      nextHint: {
        actionType: "type",
        targetAnchorId: step2.chosenAnchorId ?? undefined,
        targetLabelHint: "Search packages",
        textArg: "eta-core",
      },
      structuralNodes: nodes.map((n, idx) =>
        idx === 0 ? { ...n, focused: true } : n,
      ),
    });

    expect(step3.fusion.landmarkReused).toBe(true);
    expect(step3.timingsMs.detectorOrt).toBe(0);
    expect(step3.gate).toBe("fast_commit");
    expect(step3.timingsMs.totalStep).toBeLessThan(60);
  });

  it("experiment 2: Multi-step speculative action chain (Click Input -> Type Query -> Click Submit)", () => {
    const localEngine = new ComputerTriadEngine();
    try {
      const nodesStep1: StructuralNode[] = [
        {
          role: "textbox",
          label: "Project Name",
          bbox: { x: 100, y: 120, w: 260, h: 40 },
          region: "form",
        },
        {
          role: "button",
          label: "Create Project",
          bbox: { x: 100, y: 200, w: 160, h: 42 },
          region: "form",
        },
      ];
      const f1 = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        { bbox: { x: 100, y: 120, w: 260, h: 40 }, kind: "input" },
        { bbox: { x: 100, y: 200, w: 160, h: 42 }, kind: "button" },
      ]);

      // Step 1: Select and click "Project Name" input (#1)
      const s1 = localEngine.step({
        currRgb: f1,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Project Name input field",
        nowMs: 2000,
        resetDelta: true,
        nextHint: { actionType: "click", targetLabelHint: "Project Name" },
        structuralNodes: nodesStep1,
      });

      expect(s1.gate).toBe("fast_commit");
      expect(s1.chosenAction).toBe("click:#1");
      expect(s1.chosenProbability).toBeGreaterThan(0.8);
      expect(s1.forwardPrediction.expectedCursor).toBe("ibeam");
      expect(s1.forwardPrediction.expectedFocusId).toBe(1);

      // Step 2: Input is now focused and cursor is IBeam -> Type "eta-computer" into #1
      const f2 = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        {
          bbox: { x: 100, y: 120, w: 260, h: 40 },
          kind: "input",
          focused: true,
        },
        { bbox: { x: 100, y: 200, w: 160, h: 42 }, kind: "button" },
      ]);
      const s2 = localEngine.step({
        prevRgb: f1,
        currRgb: f2,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Type eta-computer into Project Name",
        cursor: "ibeam",
        nowMs: 2400,
        nextHint: {
          actionType: "type",
          targetAnchorId: 1,
          targetLabelHint: "Project Name",
          textArg: "eta-computer",
        },
        structuralNodes: [{ ...nodesStep1[0]!, focused: true }, nodesStep1[1]!],
      });

      expect(s2.gate).toBe("fast_commit");
      expect(s2.chosenAction).toBe("type:#1");
      expect(s2.noul.postconditionMet).toBeGreaterThan(0.85);
      expect(s2.noul.unexpectedBlocker).toBeLessThan(0.1);
      expect(s2.surprise.totalEnergy).toBeLessThan(0.4);

      // Step 3: Text entered -> Click "Create Project" button (#2)
      const s3 = localEngine.step({
        prevRgb: f1,
        currRgb: f2,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Create Project button",
        cursor: "ibeam",
        nowMs: 2800,
        nextHint: {
          actionType: "click",
          targetAnchorId: 2,
          targetLabelHint: "Create Project",
        },
        structuralNodes: [
          { ...nodesStep1[0]!, focused: true, label: "eta-computer" },
          nodesStep1[1]!,
        ],
      });

      expect(s3.gate).toBe("fast_commit");
      expect(s3.chosenAction).toBe("click:#2");
      expect(s3.goalProgressScore).toBeGreaterThan(3.8);
    } finally {
      localEngine.close();
    }
  });

  it("experiment 3: Persistent Anchor ID tracking across dynamic layout shift (Local Micro-Correction)", () => {
    const localEngine = new ComputerTriadEngine();
    try {
      const f1 = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        { bbox: { x: 120, y: 100, w: 180, h: 38 }, kind: "button" },
        { bbox: { x: 120, y: 180, w: 180, h: 42 }, kind: "button" },
      ]);

      // Frame 1: Anchor #1 = "Show Advanced", Anchor #2 = "Save Settings" at y=180
      const s1 = localEngine.step({
        currRgb: f1,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Expand Show Advanced options",
        nowMs: 3000,
        resetDelta: true,
        nextHint: { actionType: "click", targetLabelHint: "Show Advanced" },
        structuralNodes: [
          {
            role: "button",
            label: "Show Advanced",
            bbox: { x: 120, y: 100, w: 180, h: 38 },
          },
          {
            role: "button",
            label: "Save Settings",
            bbox: { x: 120, y: 180, w: 180, h: 42 },
          },
        ],
      });
      const saveAnchorBefore = s1.activeAnchors.find(
        (a) => a.label === "Save Settings",
      )!;
      expect(saveAnchorBefore.id).toBe(2);

      // Frame 2: Expanding inserted 2 new checkboxes, pushing "Save Settings" down by +110px to y=290!
      // A naive positional index would renumber "Save Settings" to #4, breaking speculative step `click:#2`.
      const f2 = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        { bbox: { x: 120, y: 100, w: 180, h: 38 }, kind: "button" },
        { bbox: { x: 120, y: 155, w: 200, h: 32 }, kind: "toggle_on" },
        { bbox: { x: 120, y: 205, w: 200, h: 32 }, kind: "toggle_on" },
        { bbox: { x: 120, y: 290, w: 180, h: 42 }, kind: "button" },
      ]);

      const s2 = localEngine.step({
        prevRgb: f1,
        currRgb: f2,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Save Settings button",
        nowMs: 3500,
        nextHint: {
          actionType: "click",
          targetAnchorId: 2,
          targetLabelHint: "Save Settings",
        },
        structuralNodes: [
          {
            role: "button",
            label: "Show Advanced",
            bbox: { x: 120, y: 100, w: 180, h: 38 },
          },
          {
            role: "checkbox",
            label: "Enable Telemetry",
            bbox: { x: 120, y: 155, w: 200, h: 32 },
          },
          {
            role: "checkbox",
            label: "Enable Cache",
            bbox: { x: 120, y: 205, w: 200, h: 32 },
          },
          {
            role: "button",
            label: "Save Settings",
            bbox: { x: 120, y: 290, w: 180, h: 42 },
          },
        ],
      });

      const saveAnchorAfter = s2.activeAnchors.find(
        (a) => a.label === "Save Settings",
      )!;
      // Persistent ID #2 is preserved despite 2 new elements inserted above it!
      expect(saveAnchorAfter.id).toBe(2);
      expect(saveAnchorAfter.movedDelta[1]).toBeCloseTo(110, 0);
      expect(s2.chosenAction).toBe("click:#2");
      expect(s2.chosenBbox?.y).toBeCloseTo(290, 0);
      expect(s2.gate).toBe("local_micro_correction");
    } finally {
      localEngine.close();
    }
  });

  it("experiment 4: High-churn transitions — Rigid-body scroll compensation & Foveated region folding (80 nodes)", () => {
    const localEngine = new ComputerTriadEngine();
    try {
      // Part A: Rigid-body scroll of list items by (0, -140px)
      const listNodes1: StructuralNode[] = Array.from(
        { length: 6 },
        (_, i) => ({
          role: "listitem",
          label: `Repository Item #${i + 1}`,
          bbox: { x: 200, y: 180 + i * 70, w: 400, h: 52 },
          region: "main",
        }),
      );
      const frameScroll1 = renderSyntheticUiFrame(
        WIDTH,
        HEIGHT,
        listNodes1.map((n) => ({ bbox: n.bbox, kind: "button" as const })),
      );
      localEngine.step({
        currRgb: frameScroll1,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Scroll down to find Repository Item #6",
        nowMs: 4000,
        resetDelta: true,
        nextHint: { actionType: "scroll" },
        structuralNodes: listNodes1,
      });

      // Shift all items up by -140px
      const listNodes2: StructuralNode[] = listNodes1.map((n) => ({
        ...n,
        bbox: { ...n.bbox, y: n.bbox.y - 140 },
      }));
      const frameScroll2 = renderSyntheticUiFrame(
        WIDTH,
        HEIGHT,
        listNodes2.map((n) => ({ bbox: n.bbox, kind: "button" as const })),
      );
      const scrollStep = localEngine.step({
        prevRgb: frameScroll1,
        currRgb: frameScroll2,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Repository Item #6",
        nowMs: 4500,
        nextHint: {
          actionType: "click",
          targetLabelHint: "Repository Item #6",
        },
        structuralNodes: listNodes2,
      });

      expect(scrollStep.fusion.rigidScrollDetected).toBe(true);
      expect(scrollStep.fusion.rigidScrollDelta[1]).toBeCloseTo(-140, 1);
      expect(scrollStep.fusion.retainedIdCount).toBeGreaterThanOrEqual(6);
      expect(scrollStep.noul.unexpectedBlocker).toBeLessThan(0.15);

      // Part B: Full-screen navigation with 80 nodes across 4 macro-regions (Foveated Folding cap = 20)
      const massiveNodes: StructuralNode[] = [];
      for (let i = 0; i < 25; i++) {
        massiveNodes.push({
          role: "link",
          label: `Sidebar Nav Link ${i}`,
          bbox: { x: 20, y: 40 + i * 24, w: 160, h: 20 },
          region: "sidebar",
        });
      }
      for (let i = 0; i < 25; i++) {
        massiveNodes.push({
          role: "button",
          label: `Footer Action ${i}`,
          bbox: {
            x: 220 + (i % 5) * 140,
            y: 620 + Math.floor(i / 5) * 20,
            w: 120,
            h: 18,
          },
          region: "footer",
        });
      }
      for (let i = 0; i < 15; i++) {
        massiveNodes.push({
          role: "button",
          label: `Header Tool ${i}`,
          bbox: { x: 200 + i * 60, y: 10, w: 54, h: 28 },
          region: "header",
        });
      }
      for (let i = 0; i < 15; i++) {
        massiveNodes.push({
          role: "button",
          label: i === 7 ? "Generate API Token" : `Security Setting ${i}`,
          bbox: { x: 260, y: 80 + i * 32, w: 240, h: 28 },
          region: "security_panel",
        });
      }

      const foldedStep = localEngine.step({
        currRgb: frameScroll2,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Generate API Token in security_panel",
        nowMs: 5000,
        maxAnchors: 20,
        resetDelta: true,
        nextHint: {
          actionType: "click",
          targetLabelHint: "Generate API Token",
        },
        structuralNodes: massiveNodes,
      });

      expect(foldedStep.fusion.activeAnchorCount).toBeLessThanOrEqual(20);
      expect(foldedStep.fusion.collapsedRegionCount).toBeGreaterThanOrEqual(2);
      expect(
        foldedStep.activeAnchors.some((a) => a.label === "Generate API Token"),
      ).toBe(true);
    } finally {
      localEngine.close();
    }
  });

  it("experiment 5: Unexpected modal popup blocker triggers Top-Layer isolation and Slow VLM escalation", () => {
    const localEngine = new ComputerTriadEngine();
    try {
      const f1 = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        {
          bbox: { x: 200, y: 150, w: 280, h: 42 },
          kind: "input",
          focused: true,
        },
      ]);

      // Step 1: Expect local perturbation on input box #1
      localEngine.step({
        currRgb: f1,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Type username into input field",
        cursor: "ibeam",
        nowMs: 6000,
        resetDelta: true,
        nextHint: { actionType: "type", targetLabelHint: "Username" },
        structuralNodes: [
          {
            role: "textbox",
            label: "Username",
            bbox: { x: 200, y: 150, w: 280, h: 42 },
            focused: true,
          },
        ],
      });

      // Step 2: Unexpected full-screen dimmed modal dialog pops up at zLayer=1!
      const fModal = renderSyntheticUiFrame(
        WIDTH,
        HEIGHT,
        [
          { bbox: { x: 380, y: 220, w: 520, h: 260 }, kind: "modal" },
          { bbox: { x: 560, y: 410, w: 160, h: 42 }, kind: "button" },
        ],
        true,
      );

      const sModal = localEngine.step({
        prevRgb: f1,
        currRgb: fModal,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Submit Form button",
        nowMs: 6500,
        nextHint: { actionType: "click", targetLabelHint: "Submit Form" },
        structuralNodes: [
          {
            role: "textbox",
            label: "Username",
            bbox: { x: 200, y: 150, w: 280, h: 42 },
            zLayer: 0,
          },
          {
            role: "dialog",
            label: "Authentication Expired: Please re-login",
            bbox: { x: 380, y: 220, w: 520, h: 260 },
            region: "modal",
            zLayer: 1,
          },
          {
            role: "button",
            label: "Close Dialog",
            bbox: { x: 560, y: 410, w: 160, h: 42 },
            region: "modal",
            zLayer: 1,
          },
        ],
      });

      // Top-layer zLayer=1 modal isolated background nodes out, spiked surprise & unexpectedBlocker, and aborted speculation!
      expect(sModal.fusion.modalIsolated).toBe(true);
      expect(sModal.activeAnchors.every((a) => a.region === "modal")).toBe(
        true,
      );
      expect(sModal.noul.unexpectedBlocker).toBeGreaterThan(0.65);
      expect(sModal.noul.postconditionMet).toBeLessThan(0.25);
      expect(sModal.surprise.totalEnergy).toBeGreaterThan(0.45);
      expect(sModal.gate).toBe("slow_escalation");
    } finally {
      localEngine.close();
    }
  });

  it("experiment 6: Safety guardrails — Destructive action intercept & 300ms idempotency debounce lock", () => {
    const localEngine = new ComputerTriadEngine();
    try {
      const fDanger = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        { bbox: { x: 300, y: 240, w: 220, h: 44 }, kind: "danger" },
      ]);

      // 6A: Destructive action ("Delete Production Database") is intercepted by Noul irreversibleRisk
      const sDanger = localEngine.step({
        currRgb: fDanger,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Delete Production Database permanently",
        nowMs: 7000,
        resetDelta: true,
        nextHint: {
          actionType: "click",
          targetLabelHint: "Delete Production Database",
        },
        structuralNodes: [
          {
            role: "button",
            label: "Delete Production Database",
            bbox: { x: 300, y: 240, w: 220, h: 44 },
          },
        ],
      });

      expect(sDanger.noul.irreversibleRisk).toBeGreaterThan(0.6);
      expect(sDanger.gate).toBe("safety_intercept");

      // 6B: 300ms Debounce Lock prevents double-click hazard on the same anchor
      const fNormal = renderSyntheticUiFrame(WIDTH, HEIGHT, [
        { bbox: { x: 100, y: 100, w: 160, h: 40 }, kind: "button" },
        { bbox: { x: 300, y: 100, w: 160, h: 40 }, kind: "button" },
      ]);
      const normalNodes: StructuralNode[] = [
        {
          role: "button",
          label: "Save Draft",
          bbox: { x: 100, y: 100, w: 160, h: 40 },
        },
        {
          role: "button",
          label: "Preview Draft",
          bbox: { x: 300, y: 100, w: 160, h: 40 },
        },
      ];

      const click1 = localEngine.step({
        currRgb: fNormal,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Save Draft",
        nowMs: 8000,
        resetDelta: true,
        nextHint: { actionType: "click", targetLabelHint: "Save Draft" },
        structuralNodes: normalNodes,
      });
      const saveId = click1.chosenAnchorId!;
      expect(click1.chosenAction).toBe(`click:#${saveId}`);

      // Immediate re-evaluation 50ms later (< 300ms cooldown): clicking `Save Draft` again is suppressed!
      const click2 = localEngine.step({
        prevRgb: fNormal,
        currRgb: fNormal,
        width: WIDTH,
        height: HEIGHT,
        subgoal: "Click Save Draft",
        nowMs: 8050,
        nextHint: { actionType: "click", targetAnchorId: saveId },
        structuralNodes: normalNodes,
      });
      expect(click2.chosenAction).not.toBe(`click:#${saveId}`);
    } finally {
      localEngine.close();
    }
  });

  it("experiment 7: Real Eta Web UI (1038x858, 32 live DOM elements) multi-step speculative trace", () => {
    const localEngine = new ComputerTriadEngine();
    const W = 1038;
    const H = 858;
    const liveEtaNodes: StructuralNode[] = [
      {
        role: "a",
        label: "ETA",
        bbox: { x: 14, y: 8, w: 33, h: 24 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "折叠或展开侧栏",
        bbox: { x: 255, y: 7, w: 25, h: 25 },
        region: "sidebar",
      },
      {
        role: "a",
        label: "任务",
        bbox: { x: 7, y: 47, w: 273, h: 29 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "新对话",
        bbox: { x: 255, y: 87, w: 22, h: 22 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "智能体",
        bbox: { x: 11, y: 577, w: 244, h: 20 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "新建智能体",
        bbox: { x: 255, y: 576, w: 22, h: 22 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "Thinker · DeepSeek-V4.1-Flash 空闲",
        bbox: { x: 8, y: 608, w: 272, h: 47 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "Insighter · DeepSeek-V4.1-Flash 空闲",
        bbox: { x: 8, y: 661, w: 272, h: 47 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "Executor · DeepSeek-V4.1-Flash 空闲",
        bbox: { x: 8, y: 715, w: 272, h: 47 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "Artist · DeepSeek-V4.1-Flash 空闲",
        bbox: { x: 8, y: 769, w: 272, h: 47 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "设置",
        bbox: { x: 4, y: 826, w: 280, h: 29 },
        region: "sidebar",
      },
      {
        role: "button",
        label: "正在与 Thinker 私聊（空闲），切换智能体",
        bbox: { x: 295, y: 3, w: 71, h: 32 },
        region: "header",
      },
      {
        role: "button",
        label: "添加附件",
        bbox: { x: 313, y: 811, w: 30, h: 28 },
        region: "composer",
      },
      {
        role: "textbox",
        label: "Message Input",
        bbox: { x: 350, y: 805, w: 240, h: 36 },
        region: "composer",
      },
      {
        role: "button",
        label: "发送",
        bbox: { x: 601, y: 811, w: 43, h: 29 },
        region: "composer",
      },
      {
        role: "tab",
        label: "上下文",
        bbox: { x: 754, y: 9, w: 79, h: 22 },
        region: "inspector",
      },
      {
        role: "tab",
        label: "产物",
        bbox: { x: 918, y: 9, w: 37, h: 22 },
        region: "inspector",
      },
      {
        role: "button",
        label: "Inspect",
        bbox: { x: 933, y: 189, w: 58, h: 22 },
        region: "inspector",
      },
    ];

    try {
      const f1 = renderSyntheticUiFrame(
        W,
        H,
        liveEtaNodes.map((n) => ({
          bbox: n.bbox,
          kind: n.role === "textbox" ? ("input" as const) : ("button" as const),
        })),
      );

      // Step 1: Click "Inspect" button in the right inspector panel
      const s1 = localEngine.step({
        currRgb: f1,
        width: W,
        height: H,
        subgoal: "Click Inspect button in inspector",
        nowMs: 9000,
        resetDelta: true,
        nextHint: { actionType: "click", targetLabelHint: "Inspect" },
        structuralNodes: liveEtaNodes,
      });

      const inspectAnchor = s1.activeAnchors.find(
        (a) => a.label === "Inspect",
      )!;
      expect(s1.gate).toBe("fast_commit");
      expect(s1.chosenAction).toBe(`click:#${inspectAnchor.id}`);
      expect(s1.chosenProbability).toBeGreaterThan(0.8);
      expect(s1.timingsMs.totalStep).toBeLessThan(400);

      // Step 2: Focus and type into "Message Input" in composer
      const s2 = localEngine.step({
        prevRgb: f1,
        currRgb: f1,
        width: W,
        height: H,
        subgoal: "Type hello into Message Input",
        cursor: "ibeam",
        nowMs: 9400,
        nextHint: {
          actionType: "type",
          targetLabelHint: "Message Input",
          textArg: "hello",
        },
        structuralNodes: liveEtaNodes.map((n) =>
          n.label === "Message Input" ? { ...n, focused: true } : n,
        ),
      });

      const inputAnchor = s2.activeAnchors.find(
        (a) => a.label === "Message Input",
      )!;
      expect(s2.gate).toBe("fast_commit");
      expect(s2.chosenAction).toBe(`type:#${inputAnchor.id}`);
      expect(s2.timingsMs.totalStep).toBeLessThan(400);
    } finally {
      localEngine.close();
    }
  });

  it("experiment 8: Execution-provider preference is honoured through the native chain", () => {
    // `cpu` is the one chain entry that must work everywhere, so it is the honest way to assert the
    // preference plumbing without depending on the host having a GPU.
    const localEngine = new ComputerTriadEngine({ providers: "cpu" });
    try {
      const out = localEngine.step({
        currRgb: renderSyntheticUiFrame(640, 360, [
          { bbox: { x: 40, y: 30, w: 120, h: 32 }, kind: "button" },
        ]),
        width: 640,
        height: 360,
        subgoal: "Click Continue",
        nowMs: 12000,
        resetDelta: true,
        nextHint: { actionType: "click", targetLabelHint: "Continue" },
        structuralNodes: [
          {
            role: "button",
            label: "Continue",
            bbox: { x: 40, y: 30, w: 120, h: 32 },
          },
        ],
      });

      expect(out.provider).toBe("cpu");
      expect(out.ocrProvider).toBe("cpu");
      expect(out.encoderProvider).toBe("cpu");
      expect(out.providerChain[0]).toBe("cpu");
    } finally {
      localEngine.close();
    }
  });

  const wevisoneDir = join(modelsDirPath(), "wevisone_vl_2b_oga");
  // The 1.44 GB grounding artifact is produced by scripts/prepare-wevisone-oga.py and is not in
  // git, so this runs only where someone prepared it. Skipping keeps a fresh checkout green.
  it.skipIf(!existsSync(join(wevisoneDir, "genai_config.json")))(
    "experiment 9: Pure-vision desktop grounding via quantized WeVisOne-VL-2B (onnxruntime-genai) + KV-cache reuse + System-1 handoff",
    () => {
      const localEngine = new ComputerTriadEngine({ providers: "cpu" });
      try {
        const W = 640;
        const H = 360;
        // Render a pure-vision UI frame with a blue primary button at [100,120,160,50]
        // and a red danger button at [340,120,160,50], with ZERO structural A11y nodes.
        const frame = renderSyntheticUiFrame(W, H, [
          { bbox: { x: 100, y: 120, w: 160, h: 50 }, kind: "button" },
          { bbox: { x: 340, y: 120, w: 160, h: 50 }, kind: "danger" },
        ]);

        // 1. Direct WeVisOne-VL-2B grounding (cold: runs INT8 ViT + visual prefill)
        const g1 = localEngine.groundWeVisOne({
          currRgb: frame,
          width: W,
          height: H,
          task: "point",
          query: "the blue button on the left",
          targetWidth: 224,
          targetHeight: 128,
        });
        expect(g1.rejected).toBe(false);
        expect(g1.kvCacheReused).toBe(false);
        expect(g1.visualTokens).toBe(28);
        expect(g1.point).not.toBeNull();
        const [px1, py1] = g1.point!;
        expect(px1).toBeGreaterThanOrEqual(80);
        expect(px1).toBeLessThanOrEqual(280);
        expect(py1).toBeGreaterThanOrEqual(100);
        expect(py1).toBeLessThanOrEqual(190);

        // 2. Second query on the SAME frame reuses the visual KV cache via `OgaGenerator_RewindTo`
        const g2 = localEngine.groundWeVisOne({
          currRgb: frame,
          width: W,
          height: H,
          task: "referring",
          query: "the red button on the right",
          targetWidth: 224,
          targetHeight: 128,
        });
        expect(g2.rejected).toBe(false);
        expect(g2.kvCacheReused).toBe(true);
        expect(g2.timingsMs.visionAndPrefill).toBe(0);
        expect(g2.timingsMs.total).toBeLessThan(g1.timingsMs.total);
        expect(g2.point).not.toBeNull();
        const [px2, py2] = g2.point!;
        expect(px2).toBeGreaterThanOrEqual(310);
        expect(px2).toBeLessThanOrEqual(520);
        expect(py2).toBeGreaterThanOrEqual(100);
        expect(py2).toBeLessThanOrEqual(190);

        // 3. Absent target rejection returns `rejected: true` (`<box>none</box>`)
        const g3 = localEngine.groundWeVisOne({
          currRgb: frame,
          width: W,
          height: H,
          task: "referring",
          query: "a yellow star icon in the bottom right corner",
          targetWidth: 224,
          targetHeight: 128,
        });
        expect(g3.rejected).toBe(true);
        expect(g3.kvCacheReused).toBe(true);
        expect(g3.point).toBeNull();

        // 4. End-to-end pure-vision `step()` with `enableWeVisOneFallback: true` and NO structuralNodes:
        //    Frame 1 grounds via WeVisOne-VL-2B and injects the persistent anchor;
        //    Frame 2 tracks and types/clicks via System-1 in <60ms without re-invoking WeVisOne!
        const s1 = localEngine.step({
          currRgb: frame,
          width: W,
          height: H,
          subgoal: "Click the blue button on the left",
          nowMs: 15000,
          resetDelta: true,
          enableWeVisOneFallback: true,
          nextHint: {
            actionType: "click",
            targetLabelHint: "the blue button on the left",
          },
        });
        expect(s1.gate).toBe("fast_commit");
        expect(s1.wevisoneGrounding).not.toBeNull();
        expect(s1.wevisoneGrounding?.rejected).toBe(false);
        expect(s1.chosenAnchorId).not.toBeNull();

        // Frame 2: repeat on the same pure-vision frame -> System-1 reuses the grounded anchor label
        // and commits in <60ms with `wevisoneGrounding: null`!
        const s2 = localEngine.step({
          prevRgb: frame,
          currRgb: frame,
          width: W,
          height: H,
          subgoal: "Click the blue button on the left",
          nowMs: 15400,
          enableWeVisOneFallback: true,
          nextHint: {
            actionType: "click",
            targetAnchorId: s1.chosenAnchorId ?? undefined,
            targetLabelHint: "the blue button on the left",
          },
        });
        expect(s2.gate).toBe("fast_commit");
        expect(s2.wevisoneGrounding).toBeNull();
        expect(s2.chosenAnchorId).toBe(s1.chosenAnchorId);
        expect(s2.timingsMs.totalStep).toBeLessThan(60);

        // 5. High-resolution 4K (3840x2160) two-stage coarse-to-fine foveated grounding:
        //    Stage 1 runs aspect-ratio smart resize globally, then Stage 2 automatically crops
        //    a 1:1 native-resolution window around the coarse hit so tiny 4K controls stay sharp.
        const W4K = 3840;
        const H4K = 2160;
        const frame4K = renderSyntheticUiFrame(W4K, H4K, [
          { bbox: { x: 2800, y: 1500, w: 180, h: 56 }, kind: "danger" },
        ]);
        const g4k = localEngine.groundWeVisOne({
          currRgb: frame4K,
          width: W4K,
          height: H4K,
          task: "referring",
          query: "the red button",
          foveatedRefine: true,
        });
        expect(g4k.rejected).toBe(false);
        expect(g4k.foveatedRefined).toBe(true);
        expect(g4k.coarsePoint).not.toBeNull();
        expect(g4k.refinedRoi).not.toBeNull();
        expect(g4k.point).not.toBeNull();
        const [px4k, py4k] = g4k.point!;
        expect(px4k).toBeGreaterThanOrEqual(2750);
        expect(px4k).toBeLessThanOrEqual(3020);
        expect(py4k).toBeGreaterThanOrEqual(1460);
        expect(py4k).toBeLessThanOrEqual(1600);
      } finally {
        localEngine.close();
      }
    },
    45000,
  );
});
