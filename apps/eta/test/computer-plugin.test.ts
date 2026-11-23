import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ComputerCursorEvent,
  ComputerFrameEvent,
  ComputerMachineCapabilities,
  ComputerPickerState,
  ComputerRealmView,
} from "@eta/client-contracts";
import type { EventFrame, ServerFrame } from "@eta/client-wire-proto";
import type { ToolResult } from "@eta/harness";
import type { SessionMeta, SessionsService, Socket } from "@eta/server";
/**
 * Host Plugin, Session Tools & Grounder/Model Routing (`T9`):
 *
 * Verifies:
 * 1. Vision model gate rejects text-only models with `computer_model_lacks_vision` and allows
 *    image-capable models (`checkModelSupportsVision` + `computer_open` / `computer_observe`).
 * 2. `computer_open` -> `computer_observe` (full + GroundCascade `crop`) -> `computer_act` ->
 *    `computer_clipboard` -> `computer_close` lifecycle works end-to-end and updates the `/ws`
 *    `computer` and `computer.<realmId>` targets (`info` section + `frame`, `cursor`, `picker`
 *    events, plus `takeover` / `release` / `pause` / `resume` / `stop` / `input` / `resolvePicker`
 *    / `close` actions).
 * 3. Optional `groundingModel` routing invokes the model layer (`KernelModels`) and records token
 *    usage via the usage callback (`onGenerated` / `usage` table).
 * 4. Out-of-workspace file path in `computer_stage_files` and `computer_resolve_picker` triggers
 *    the `ask` / Inbox approval gate, succeeding on `"allow"` and failing on `"deny"`.
 */
import path from "node:path";
import process from "node:process";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { AskRegistry } from "@eta/harness";
import { createConnection, WireService } from "@eta/server";
import { describe, expect, it } from "vitest";
import { computerPlugin } from "../src/computer/plugin";
import {
  checkModelSupportsVision,
  ComputerService,
} from "../src/computer/service";
import { computerSessionTools } from "../src/computer/tools";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { entryOf } from "../src/usage/recorder";
import { UsageStore } from "../src/usage/store";
import { say, scriptedModels } from "./support/models";

function createBilledMessage(
  text: string,
  options: {
    provider?: string;
    model?: string;
    input?: number;
    output?: number;
    cost?: number;
  } = {},
): AssistantMessage {
  const input = options.input ?? 120;
  const output = options.output ?? 25;
  return {
    ...say(text),
    provider: options.provider ?? "grounder",
    model: options.model ?? "fast-vision-v1",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: options.cost ?? 0.0045,
      },
    },
  };
}

function findTool(
  tools: ReturnType<ReturnType<typeof computerSessionTools>>,
  name: string,
) {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`Expected tool "${name}" to be registered`);
  }
  return found;
}

interface WireTestHarness {
  wire: WireService;
  socketId: number;
  frames: ServerFrame[];
  section: <T = unknown>(target: string, sectionName: string) => T | undefined;
  events: <T = unknown>(target: string, eventName: string) => T[];
  subscribe: (target: string) => void;
  unsubscribe: (target: string) => void;
  call: <T = unknown>(
    target: string,
    action: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  dispose: () => Promise<void>;
}

function mountComputerPluginWire(service: ComputerService): WireTestHarness {
  const createStubContext = () =>
    ({
      reflect: { provide: () => {} },
      set: () => {},
      runtime: {},
      effect: () => {},
    }) as never;

  const wire = new WireService(createStubContext(), {
    focusedIntervalMs: 0,
    backgroundIntervalMs: 0,
  });

  const frames: ServerFrame[] = [];
  const sectionsByTarget = new Map<string, Record<string, unknown>>();
  const socketId = 1;

  const recordFrame = (frame: ServerFrame): void => {
    frames.push(frame);
    if (frame.type === "hello") {
      for (const [target, snap] of Object.entries(frame.state)) {
        sectionsByTarget.set(target, { ...snap.sections });
      }
    } else if (frame.type === "state") {
      if (frame.snapshot !== undefined) {
        sectionsByTarget.set(frame.target, { ...frame.snapshot.sections });
      } else if (frame.patch !== undefined) {
        const prev = sectionsByTarget.get(frame.target) ?? {};
        const next: Record<string, unknown> = {};
        for (const name of Object.keys(frame.patch.revisions)) {
          next[name] =
            name in frame.patch.sections
              ? frame.patch.sections[name]
              : prev[name];
        }
        sectionsByTarget.set(frame.target, next);
      }
    }
  };

  wire.attachSink((addressed) => {
    if (addressed.socketId !== undefined) {
      if (addressed.socketId === socketId) {
        recordFrame(addressed.frame);
      }
      return;
    }
    if (
      addressed.target !== undefined &&
      wire.state.subscriptions(socketId).includes(addressed.target)
    ) {
      recordFrame(addressed.frame);
    }
  });

  let applied = false;
  let pluginCleanup: (() => void | Promise<void>) | undefined;
  const plugin = computerPlugin({ service }, () => {
    applied = true;
  });

  plugin.apply({
    wire,
    sessions: {} as SessionsService,
    effect: (execute: () => () => void | Promise<void>) => {
      pluginCleanup = execute();
      return pluginCleanup;
    },
  });

  if (!applied) {
    throw new Error("computerPlugin did not call applied()");
  }

  const fakeSocket: Socket = {
    id: socketId,
    send: (frame) => {
      recordFrame(frame);
    },
  };

  const conn = createConnection(fakeSocket, {
    wire,
    mounted: () => [{ name: "computer", source: "bundled" }],
  });

  let reqCounter = 0;

  return {
    wire,
    socketId,
    frames,
    section: <T = unknown>(
      target: string,
      sectionName: string,
    ): T | undefined =>
      sectionsByTarget.get(target)?.[sectionName] as T | undefined,
    events: <T = unknown>(target: string, eventName: string): T[] =>
      frames
        .filter(
          (f): f is EventFrame =>
            f.type === "event" && f.target === target && f.name === eventName,
        )
        .map((f) => f.data as T),
    subscribe: (target: string) => {
      wire.subscribe(socketId, target);
    },
    unsubscribe: (target: string) => {
      wire.unsubscribe(socketId, target);
    },
    call: async <T = unknown>(
      target: string,
      action: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const requestId = `req_${++reqCounter}`;
      const outcome = await wire.dispatch(
        {
          op: "call",
          requestId,
          target,
          action,
          args,
        },
        { reply: () => {} },
      );
      return outcome.result as T;
    },
    dispose: async () => {
      conn.close();
      await pluginCleanup?.();
      await service.closeAll();
    },
  };
}

describe("t9: ComputerService, computerSessionTools, and computerPlugin", () => {
  describe("1. Model capability gate (checkModelSupportsVision)", () => {
    it("rejects text-only or missing models with computer_model_lacks_vision and allows vision models", async () => {
      const textOnlyCheck = checkModelSupportsVision({
        id: "openai:gpt-text-only",
        input: ["text"],
      });
      expect(textOnlyCheck.ok).toBe(false);
      if (!textOnlyCheck.ok) {
        expect(textOnlyCheck.code).toBe("computer_model_lacks_vision");
        expect(textOnlyCheck.message).toContain(
          "computer_model_lacks_vision: model openai:gpt-text-only does not support image input; choose a multimodal model such as gpt-6.2-sol, gemini-4-hydrogen, or claude-opus-5.5",
        );
      }

      const visionCheck = checkModelSupportsVision({
        id: "openai:gpt-6.2-sol",
        input: ["text", "image"],
      });
      expect(visionCheck).toEqual({
        ok: true,
        modelId: "openai:gpt-6.2-sol",
      });

      // Verify computer_open enforces the gate against the session's model
      const textOnlyModels = fakeModels([
        assistantMessage({ content: [{ type: "text", text: "ok" }] }),
      ]);
      const baseGetModel = textOnlyModels.getModel.bind(textOnlyModels);
      textOnlyModels.getModel = (provider, modelId) => {
        const m = baseGetModel(provider, modelId);
        return m ? ({ ...m, input: ["text"] } as typeof m) : undefined;
      };

      const service = new ComputerService({
        models: textOnlyModels,
      });
      const meta: SessionMeta = {
        id: "sess_vision_gate",
        createdAt: Date.now(),
        cwd: process.cwd(),
        model: "fake:text-only-m1",
      };
      const tools = computerSessionTools({
        service,
        models: () => textOnlyModels,
      })({
        meta,
        session: undefined as never,
      });
      const openTool = findTool(tools, "computer_open");

      const deniedResult = (await openTool.execute(
        { kind: "browser", target: "https://example.com" },
        { turn: 1, toolCallId: "tc-deny" },
      )) as ToolResult;
      expect(deniedResult.isError).toBe(true);
      expect(deniedResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("computer_model_lacks_vision"),
      });
      expect(service.realms()).toHaveLength(0);

      // Now upgrade model to support ["text", "image"]
      const { models: visionModels } = scriptedModels(() => say("ok"), {
        vision: true,
      });
      const visionTools = computerSessionTools({
        service,
        models: () => visionModels,
      })({
        meta: { ...meta, model: "fake:vision-m1" },
        session: undefined as never,
      });
      const allowedOpenTool = findTool(visionTools, "computer_open");

      const allowedResult = (await allowedOpenTool.execute(
        { kind: "browser", target: "https://example.com" },
        { turn: 1, toolCallId: "tc-allow" },
      )) as ToolResult<{ realmId: string; realm: ComputerRealmView }>;
      expect(allowedResult.isError).toBeUndefined();
      expect(allowedResult.details?.realm.kind).toBe("browser");
      expect(service.realms()).toHaveLength(1);
    });
  });

  describe("2. End-to-end tool lifecycle and /ws computer & computer.<realmId> targets", () => {
    it("executes computer_open -> computer_observe (full + GroundCascade crop) -> computer_act -> computer_clipboard -> computer_close and updates /ws targets", async () => {
      const { models } = scriptedModels(() => say("ok"), { vision: true });
      const service = new ComputerService({
        machineId: "machine_primary",
        models,
      });
      const harness = mountComputerPluginWire(service);

      // Eager `computer` state is present immediately from hello
      expect(
        harness.section<ComputerRealmView[]>("computer", "realms"),
      ).toEqual([]);
      expect(
        Array.isArray(
          harness.section<ComputerMachineCapabilities[]>(
            "computer",
            "capabilities",
          ),
        ),
      ).toBe(true);
      expect(
        harness.section<string | null>("computer", "groundingModel"),
      ).toBeNull();

      harness.subscribe("computer");

      const projectDir = path.resolve(process.cwd(), ".eta-test-cu-proj");
      const meta: SessionMeta = {
        id: "sess_e2e",
        createdAt: Date.now(),
        cwd: projectDir,
        agentId: "agent_ada",
        conversationId: "conv_1",
        model: "fake:vision-model",
      };

      const tools = computerSessionTools({
        service,
        models: () => models,
        agentName: () => "Ada",
        taskOfSession: () => "task_9",
        machineOfSession: () => "machine_primary",
      })({
        meta,
        session: undefined as never,
      });

      const openTool = findTool(tools, "computer_open");
      const observeTool = findTool(tools, "computer_observe");
      const actTool = findTool(tools, "computer_act");
      const clipboardTool = findTool(tools, "computer_clipboard");
      const closeTool = findTool(tools, "computer_close");

      // 1) computer_open
      const openRes = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/dashboard",
          title: "Example Dashboard",
          viewport: { width: 1280, height: 800 },
        },
        { turn: 1, toolCallId: "tc-open-1" },
      )) as ToolResult<{
        realmId: string;
        reused: boolean;
        realm: ComputerRealmView;
      }>;

      expect(openRes.isError).toBeUndefined();
      const realmId = openRes.details!.realmId;
      expect(realmId).toBeTruthy();
      expect(openRes.details!.reused).toBe(false);
      expect(openRes.details!.realm).toMatchObject({
        id: realmId,
        kind: "browser",
        target: "https://example.com/dashboard",
        sessionId: "sess_e2e",
        agentId: "agent_ada",
        agentName: "Ada",
        conversationId: "conv_1",
        taskId: "task_9",
        machineId: "machine_primary",
        controller: "agent",
        epoch: 1,
      });

      // Calling computer_open again with same (kind, target) reuses the realm
      const reuseRes = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/dashboard",
        },
        { turn: 1, toolCallId: "tc-open-reuse" },
      )) as ToolResult<{ realmId: string; reused: boolean }>;
      expect(reuseRes.details).toMatchObject({
        realmId,
        reused: true,
      });

      // Verify /ws `computer` target reflects the opened realm
      const publishedRealms = harness.section<ComputerRealmView[]>(
        "computer",
        "realms",
      )!;
      expect(publishedRealms).toHaveLength(1);
      expect(publishedRealms[0]).toMatchObject({
        id: realmId,
        kind: "browser",
        target: "https://example.com/dashboard",
        controller: "agent",
      });

      // Subscribe to `computer.<realmId>` on /ws to warm frame & cursor streaming
      const realmTarget = `computer.${realmId}`;
      harness.subscribe(realmTarget);
      expect(
        harness.section<ComputerRealmView>(realmTarget, "info"),
      ).toMatchObject({
        id: realmId,
        controller: "agent",
      });

      // 2) computer_observe (full viewport)
      const observeFull = (await observeTool.execute(
        { realmId },
        { turn: 2, toolCallId: "tc-obs-full" },
      )) as ToolResult<{
        realmId: string;
        viewport: { width: number; height: number };
        cropRect?: unknown;
      }>;
      expect(observeFull.isError).toBeUndefined();
      expect(observeFull.content[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      const imageBlock = observeFull.content[0] as {
        type: "image";
        mimeType: string;
        data: string;
      };
      expect(imageBlock.data.length).toBeGreaterThan(20);
      expect(observeFull.details?.viewport).toEqual({
        width: 1280,
        height: 800,
        scaleFactor: 1,
      });
      expect(observeFull.details?.cropRect).toBeUndefined();

      // Watching client receives the `frame` event on `computer.<realmId>`
      const frameEvents = harness.events<ComputerFrameEvent>(
        realmTarget,
        "frame",
      );
      expect(frameEvents).toHaveLength(1);
      expect(frameEvents[0]!.realmId).toBe(realmId);
      expect(frameEvents[0]!.data).toBe(imageBlock.data);

      // 3) computer_observe with GroundCascade crop (zoomed observation)
      const observeCrop = (await observeTool.execute(
        {
          realmId,
          crop: { x: 250, y: 250, width: 500, height: 500, unit: "normalized" },
        },
        { turn: 2, toolCallId: "tc-obs-crop" },
      )) as ToolResult<{
        cropRect: { x: number; y: number; width: number; height: number };
        observationViewport: { width: number; height: number };
      }>;
      expect(observeCrop.isError).toBeUndefined();
      expect(observeCrop.details?.cropRect).toEqual({
        x: 320,
        y: 200,
        width: 640,
        height: 400,
      });
      expect(observeCrop.details?.observationViewport).toMatchObject({
        width: 640,
        height: 400,
      });

      // 4) computer_act (micro-actions batch)
      const actRes = (await actTool.execute(
        {
          realmId,
          actions: [
            { kind: "move", x: 500, y: 250, unit: "normalized" },
            { kind: "click", x: 500, y: 250, unit: "normalized" },
            { kind: "type", text: "eta computer use", submit: true },
          ],
        },
        { turn: 3, toolCallId: "tc-act-1" },
      )) as ToolResult<{
        completedSteps: number;
        totalSteps: number;
        cursor: { x: number; y: number };
      }>;
      expect(actRes.isError).toBeUndefined();
      expect(actRes.details?.completedSteps).toBe(3);
      expect(actRes.details?.totalSteps).toBe(3);
      expect(actRes.details?.cursor).toMatchObject({
        x: 500,
        y: 250,
      });

      // Verify `cursor` event arrived on `computer.<realmId>`
      const cursorEvents = harness.events<ComputerCursorEvent>(
        realmTarget,
        "cursor",
      );
      expect(cursorEvents.some((e) => e.x === 500 && e.y === 250)).toBe(true);

      // Verify takeover / release single-writer lock via /ws `computer.<realmId>` actions
      const takenOver = await harness.call<ComputerRealmView>(
        realmTarget,
        "takeover",
        {
          reason: "Manual adjustment",
        },
      );
      expect(takenOver.controller).toBe("user");
      expect(takenOver.epoch).toBe(2);

      // While user holds control, agent `computer_act` is rejected
      const blockedAct = (await actTool.execute(
        {
          realmId,
          actions: [{ kind: "click", x: 100, y: 100 }],
        },
        { turn: 4, toolCallId: "tc-act-blocked" },
      )) as ToolResult;
      expect(blockedAct.isError).toBe(true);
      expect(blockedAct.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining('controller is "user"'),
      });

      // User can send manual input while `controller === "user"`
      const afterInput = await harness.call<ComputerRealmView>(
        realmTarget,
        "input",
        {
          input: { kind: "click", x: 750, y: 750 },
        },
      );
      expect(afterInput.cursor).toMatchObject({
        x: 750,
        y: 750,
        kind: "click",
      });

      // Release control back to agent
      const released = await harness.call<ComputerRealmView>(
        realmTarget,
        "release",
        {
          reason: "Done manual input",
        },
      );
      expect(released.controller).toBe("agent");
      expect(released.epoch).toBe(3);

      // 5) computer_clipboard (isolated VirtualClipboard)
      const writeClip = (await clipboardTool.execute(
        {
          realmId,
          action: "write",
          text: "isolated-realm-secret-token",
          html: "<b>isolated-realm-secret-token</b>",
        },
        { turn: 5, toolCallId: "tc-clip-write" },
      )) as ToolResult<{ text: string; revision: number }>;
      expect(writeClip.isError).toBeUndefined();
      expect(writeClip.details?.text).toBe("isolated-realm-secret-token");
      expect(writeClip.details?.revision).toBe(1);

      const readClip = (await clipboardTool.execute(
        {
          realmId,
          action: "read",
        },
        { turn: 5, toolCallId: "tc-clip-read" },
      )) as ToolResult<{ text: string; html: string; revision: number }>;
      expect(readClip.isError).toBeUndefined();
      expect(readClip.content[0]).toMatchObject({
        type: "text",
        text: "isolated-realm-secret-token",
      });
      expect(readClip.details?.html).toBe("<b>isolated-realm-secret-token</b>");

      // 6) computer_close
      const closeRes = (await closeTool.execute(
        {
          realmId,
          reason: "Task completed",
        },
        { turn: 6, toolCallId: "tc-close" },
      )) as ToolResult<{ realm: ComputerRealmView }>;
      expect(closeRes.isError).toBeUndefined();
      expect(closeRes.details?.realm.controller).toBe("closed");

      expect(
        harness.section<ComputerRealmView>(realmTarget, "info")?.controller,
      ).toBe("closed");
      expect(
        harness
          .section<ComputerRealmView[]>("computer", "realms")
          ?.find((r) => r.id === realmId)?.controller,
      ).toBe("closed");

      // 7) A relaunch that asks for its own script/args must not end the window already open: an
      //    app realm can hold unsaved work, and ending a Computer Use app is the user's decision.
      const first = (await openTool.execute(
        { kind: "browser", target: "https://example.com/report" },
        { turn: 7, toolCallId: "tc-open-replace-1" },
      )) as ToolResult<{ realmId: string }>;
      const again = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/report",
          reuse: false,
        },
        { turn: 7, toolCallId: "tc-open-replace-2" },
      )) as ToolResult;
      expect(again.isError).toBe(true);
      expect(again.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("is already open in realm"),
      });
      // The window that was already open is untouched.
      expect(
        service.manager.require(first.details!.realmId).view().controller,
      ).toBe("agent");

      await harness.dispose();
    });
  });

  describe("3. Optional groundingModel routing and usage table accounting", () => {
    it("delegates locateWithGrounder to groundingModel and records every token in the usage callback and database", async () => {
      const db = openDatabase(":memory:");
      applyMigrations(db, loadMigrations());
      const usageStore = new UsageStore(db);
      const recordedCalls: { meta: SessionMeta; message: AssistantMessage }[] =
        [];

      const { models, requests } = scriptedModels(
        () =>
          createBilledMessage('{"x": 500, "y": 500, "unit": "normalized"}', {
            provider: "grounder",
            model: "ui-tars-fast",
            input: 340,
            output: 18,
            cost: 0.0025,
          }),
        { vision: true },
      );

      const service = new ComputerService({
        machineId: "machine_primary",
        models,
        onGenerated: (meta, message) => {
          recordedCalls.push({ meta, message });
          usageStore.record(entryOf(meta, message));
        },
      });
      const harness = mountComputerPluginWire(service);
      harness.subscribe("computer");

      // Set groundingModel via the wire action `computer.setGroundingModel`
      const setRes = await harness.call<{ groundingModel: string | null }>(
        "computer",
        "setGroundingModel",
        {
          model: "grounder:ui-tars-fast",
        },
      );
      expect(setRes.groundingModel).toBe("grounder:ui-tars-fast");
      expect(harness.section<string | null>("computer", "groundingModel")).toBe(
        "grounder:ui-tars-fast",
      );

      const meta: SessionMeta = {
        id: "sess_grounder",
        createdAt: Date.now(),
        cwd: process.cwd(),
        agentId: "agent_ada",
        conversationId: "conv_grounder",
        model: "fake:vision-main",
      };

      const tools = computerSessionTools({
        service,
        models: () => models,
      })({
        meta,
        session: undefined as never,
      });
      const openTool = findTool(tools, "computer_open");
      const observeTool = findTool(tools, "computer_observe");

      const opened = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/settings",
          viewport: { width: 1000, height: 1000 },
        },
        { turn: 1, toolCallId: "tc-open-g" },
      )) as ToolResult<{ realmId: string }>;
      const realmId = opened.details!.realmId;

      // Observe with a GroundCascade crop (200..600 x 200..600) and `locate: "Save button"`
      const observed = (await observeTool.execute(
        {
          realmId,
          crop: { x: 200, y: 200, width: 400, height: 400, unit: "normalized" },
          locate: "Save button",
        },
        { turn: 2, toolCallId: "tc-obs-locate" },
      )) as ToolResult<{
        grounded?: {
          modelId: string;
          localNormalized?: { x: number; y: number };
          viewportNormalized?: { x: number; y: number };
        };
      }>;

      expect(observed.isError).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.images).toBe(1);
      expect(observed.details?.grounded).toMatchObject({
        modelId: "grounder:ui-tars-fast",
        localNormalized: { x: 500, y: 500 },
        // Center of [200..600, 200..600] crop in full viewport is (400, 400)
        viewportNormalized: { x: 400, y: 400 },
      });

      // Verify usage was recorded in the usage callback and SQLite `usage` table
      expect(recordedCalls).toHaveLength(1);
      const usageRows = db
        .query("SELECT * FROM usage WHERE session_id = ?")
        .all("sess_grounder") as Record<string, unknown>[];
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]).toMatchObject({
        session_id: "sess_grounder",
        agent_id: "agent_ada",
        conversation_id: "conv_grounder",
        provider: "grounder",
        model: "ui-tars-fast",
        input: 340,
        output: 18,
        total: 358,
        cost: 0.0025,
        status: "ok",
      });

      await harness.dispose();
      db.close();
    });
  });

  describe("4. FileBrokerPolicy out-of-workspace approval routing via ask / Inbox", () => {
    it("allows in-workspace paths silently, prompts ask/Inbox for out-of-workspace paths (succeeding on allow, failing on deny), and hard-blocks secrets", async () => {
      const workspaceDir = path.resolve(process.cwd(), ".eta-test-ws");
      const outsideDir = path.resolve(process.cwd(), "..", "eta-outside-ws");
      const homeDir = path.resolve(process.cwd(), "..", "eta-home-ws");

      const { models } = scriptedModels(() => say("ok"), { vision: true });
      const service = new ComputerService({
        models,
        fileBrokerOptions: {
          projectDir: workspaceDir,
          homeDir,
          etaHomeDir: path.join(homeDir, ".eta"),
        },
      });

      const meta: SessionMeta = {
        id: "sess_file_broker",
        createdAt: Date.now(),
        cwd: workspaceDir,
        model: "fake:vision-model",
      };

      const askedQuestions: { questionId: string; question: string }[] = [];
      let nextDecision: "allow" | "deny" = "allow";

      const askRegistry = new AskRegistry({
        headless: async (payload) => {
          askedQuestions.push({
            questionId: payload.questionId,
            question: payload.question,
          });
          return {
            kind: "selection",
            selections: [nextDecision],
          };
        },
      });

      const tools = computerSessionTools({
        service,
        models: () => models,
      })({
        meta,
        session: { ask: askRegistry, models } as never,
      });

      const openTool = findTool(tools, "computer_open");
      const stageTool = findTool(tools, "computer_stage_files");

      const opened = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/upload",
        },
        { turn: 1, toolCallId: "tc-open-fb" },
      )) as ToolResult<{ realmId: string }>;
      const realmId = opened.details!.realmId;

      // Case A: In-workspace file is allowed silently without asking
      const insideFile = path.join(workspaceDir, "report.pdf");
      const insideRes = (await stageTool.execute(
        {
          realmId,
          files: [insideFile],
        },
        { turn: 2, toolCallId: "tc-stage-inside" },
      )) as ToolResult<{
        picker: ComputerPickerState;
        asked: boolean;
      }>;
      expect(insideRes.isError).toBeUndefined();
      expect(insideRes.details?.asked).toBe(false);
      expect(insideRes.details?.picker).toMatchObject({
        status: "armed",
        files: ["report.pdf"],
      });
      expect(askedQuestions).toHaveLength(0);

      // Case B: Out-of-workspace file triggers ask/Inbox and succeeds when user answers "allow"
      const outsideFile = path.join(outsideDir, "invoice.csv");
      nextDecision = "allow";
      const outsideAllowRes = (await stageTool.execute(
        {
          realmId,
          files: [outsideFile],
        },
        { turn: 3, toolCallId: "tc-stage-outside-allow" },
      )) as ToolResult<{
        picker: ComputerPickerState;
        asked: boolean;
      }>;
      expect(outsideAllowRes.isError).toBeUndefined();
      expect(outsideAllowRes.details?.asked).toBe(true);
      expect(outsideAllowRes.details?.picker).toMatchObject({
        status: "armed",
        files: ["invoice.csv"],
      });
      expect(askedQuestions).toHaveLength(1);
      expect(askedQuestions[0]!.question).toContain("invoice.csv");

      // Case C: Out-of-workspace file fails with file_broker_rejected_by_user when user answers "deny"
      nextDecision = "deny";
      const outsideDenyRes = (await stageTool.execute(
        {
          realmId,
          files: [outsideFile],
        },
        { turn: 4, toolCallId: "tc-stage-outside-deny" },
      )) as ToolResult;
      expect(outsideDenyRes.isError).toBe(true);
      expect(outsideDenyRes.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("file_broker_rejected_by_user"),
      });
      expect(askedQuestions).toHaveLength(2);

      // Case D: Sensitive secret file (.eta/secret.key) is hard-denied without even asking the user
      const secretFile = path.join(homeDir, ".eta", "secret.key");
      const secretRes = (await stageTool.execute(
        {
          realmId,
          files: [secretFile],
        },
        { turn: 5, toolCallId: "tc-stage-secret" },
      )) as ToolResult;
      expect(secretRes.isError).toBe(true);
      expect(secretRes.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("file_broker_denied"),
      });
      expect(askedQuestions).toHaveLength(2);
    });
  });
});
