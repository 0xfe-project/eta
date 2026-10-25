import type { StructuralNode } from "../src/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerTriadEngine, renderSyntheticUiFrame } from "../src/index";

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
      expect(s2.timingsMs.totalStep).toBeLessThan(120);
    } finally {
      localEngine.close();
    }
  });
});
