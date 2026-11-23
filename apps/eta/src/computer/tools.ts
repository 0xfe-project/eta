import type {
  ComputerMicroAction,
  CoordinateUnit,
  CropBox,
  ViewportSize,
} from "@eta/client-contracts";
import type { KernelModels, KernelTool } from "@eta/core";
import type {
  AskRegistry,
  OpenSession,
  ToolResult,
  ToolRun,
} from "@eta/harness";
import type { SessionMeta } from "@eta/server";
import type { SessionHooks } from "../session-hooks";
import type { ComputerAskUserCallback, ComputerService } from "./service";
/**
 * Computer Use session tools (`apps/eta/src/computer/tools.ts`):
 *
 * - `computer_open`: opens or reuses an isolated `browser` or `app` realm, checking vision
 *   capability first (`computer_model_lacks_vision`).
 * - `computer_observe`: captures a clean screenshot (never painted with a fake cursor!) from the
 *   realm, supporting `GroundCascade` `crop: { x, y, width, height, unit }` zoomed observation
 *   and optional fast `locate` grounding via `groundingModel`. Returns the `{ type: "image",
 *   mimeType, data }` block in `ToolResult.content` (which `@eta/harness`'s `view.ts`
 *   automatically strips to `{ type: "image", mimeType, data: "", bytes }` in `sessions.<id>`
 *   snapshots and serves on demand via `sessions.image`) plus structured metadata.
 * - `computer_act`: executes 1..8 micro-actions (`move`, `click`, `double_click`, `right_click`,
 *   `drag`, `scroll`, `type`, `key`, `wait`) in normalized `0..1000` (or `percent`/`pixel`)
 *   coordinates, respecting the single-writer lock (`agent` vs `user` takeover) and stopping
 *   early if a modal or navigation interrupts the batch.
 * - `computer_stage_files` and `computer_resolve_picker`: arms or resolves the silent file picker
 *   through `FileBrokerPolicy` (triggering the Inbox/ask approval gate when outside allowed
 *   project/upload/staging directories).
 * - `computer_clipboard`: reads, writes, or clears the realm's isolated `VirtualClipboard`
 *   without touching the host OS clipboard.
 * - `computer_close`: closes the realm and releases resources.
 */
import { MAX_MICRO_ACTIONS } from "@eta/client-contracts";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

interface ComputerToolContext {
  ask?: AskRegistry | undefined;
  askUser?: ComputerAskUserCallback | undefined;
}

export interface ComputerSessionToolsDeps {
  service: ComputerService;
  models?: (() => KernelModels | undefined) | undefined;
  agentName?: ((agentId: string) => string | undefined) | undefined;
  taskOfSession?: ((meta: SessionMeta) => string | undefined) | undefined;
  machineOfSession?: ((meta: SessionMeta) => string | undefined) | undefined;
  askUser?: ComputerAskUserCallback | undefined;
}

const coordinateUnitSchema = Type.Optional(
  Type.Union([
    Type.Literal("normalized"),
    Type.Literal("percent"),
    Type.Literal("pixel"),
  ]),
);

const cropBoxSchema = Type.Object({
  x: Type.Number({
    minimum: 0,
    description:
      "Left coordinate of the crop box (default unit: normalized 0..1000).",
  }),
  y: Type.Number({
    minimum: 0,
    description:
      "Top coordinate of the crop box (default unit: normalized 0..1000).",
  }),
  width: Type.Number({
    exclusiveMinimum: 0,
    description: "Width of the crop box.",
  }),
  height: Type.Number({
    exclusiveMinimum: 0,
    description: "Height of the crop box.",
  }),
  unit: coordinateUnitSchema,
});

const viewportSchema = Type.Object({
  width: Type.Integer({ minimum: 64, maximum: 7680 }),
  height: Type.Integer({ minimum: 64, maximum: 4320 }),
  scaleFactor: Type.Optional(Type.Number({ minimum: 0.5, maximum: 4 })),
});

const microActionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("move"),
    x: Type.Number(),
    y: Type.Number(),
    unit: coordinateUnitSchema,
  }),
  Type.Object({
    kind: Type.Union([
      Type.Literal("click"),
      Type.Literal("double_click"),
      Type.Literal("right_click"),
    ]),
    x: Type.Number(),
    y: Type.Number(),
    unit: coordinateUnitSchema,
    button: Type.Optional(
      Type.Union([
        Type.Literal("left"),
        Type.Literal("right"),
        Type.Literal("middle"),
      ]),
    ),
  }),
  Type.Object({
    kind: Type.Literal("drag"),
    fromX: Type.Number(),
    fromY: Type.Number(),
    toX: Type.Number(),
    toY: Type.Number(),
    unit: coordinateUnitSchema,
  }),
  Type.Object({
    kind: Type.Literal("scroll"),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    deltaX: Type.Optional(Type.Number()),
    deltaY: Type.Number(),
    unit: coordinateUnitSchema,
  }),
  Type.Object({
    kind: Type.Literal("type"),
    text: Type.String(),
    submit: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal("key"),
    key: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("wait"),
    durationMs: Type.Number({ minimum: 0, maximum: 30_000 }),
  }),
]);

function extractToolContext(
  rawToolContext: unknown,
  session: OpenSession | undefined,
  defaultAskUser: ComputerAskUserCallback | undefined,
): ComputerToolContext {
  const ctxRecord =
    typeof rawToolContext === "object" && rawToolContext !== null
      ? (rawToolContext as {
          ask?: unknown;
          askUser?: unknown;
        })
      : undefined;

  let ask = session?.ask;
  let askUser = defaultAskUser;

  if (ctxRecord?.ask !== undefined) {
    if (typeof ctxRecord.ask === "function") {
      const fn = ctxRecord.ask as ComputerAskUserCallback;
      askUser = fn;
    } else if (
      typeof ctxRecord.ask === "object" &&
      ctxRecord.ask !== null &&
      "ask" in ctxRecord.ask &&
      typeof (ctxRecord.ask as AskRegistry).ask === "function"
    ) {
      ask = ctxRecord.ask as AskRegistry;
    }
  }
  if (typeof ctxRecord?.askUser === "function") {
    askUser = ctxRecord.askUser as ComputerAskUserCallback;
  }

  return { ask, askUser };
}

function resolveSessionVisionGate(
  service: ComputerService,
  meta: SessionMeta,
  session: OpenSession | undefined,
  modelsOverride: KernelModels | undefined,
) {
  const models = session?.models ?? modelsOverride;
  let sessionModel:
    | {
        provider?: string | undefined;
        modelId?: string | undefined;
        id?: string | undefined;
        input?: readonly ("text" | "image")[] | undefined;
      }
    | string
    | undefined;

  const kernelModel = session?.kernel?.config?.read?.("model");
  if (
    kernelModel !== undefined &&
    typeof kernelModel.provider === "string" &&
    typeof kernelModel.modelId === "string"
  ) {
    sessionModel = {
      provider: kernelModel.provider,
      modelId: kernelModel.modelId,
    };
  } else if (typeof meta.model === "string" && meta.model.trim() !== "") {
    sessionModel = meta.model;
  }

  return service.verifyVisionForSession({
    sessionModel,
    models,
  });
}

function formatError(error: unknown): ToolResult {
  return toolError(error instanceof Error ? error.message : String(error));
}

export function computerSessionTools(
  deps: ComputerSessionToolsDeps,
): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta, session }) => {
    const { service } = deps;
    // Track consecutive identical full-frame observations per realm to break blind retry loops.
    const stagnantFrames = new Map<string, { sig: string; count: number }>();
    const contextOf = (rawToolContext: unknown): ComputerToolContext =>
      extractToolContext(rawToolContext, session, deps.askUser);

    const open = defineTool({
      name: "computer_open",
      label: "computer_open",
      description:
        "Open or reuse an isolated Computer Use realm (`browser` via headless Chromium CDP pipe " +
        "or `app` via Windows Child Session / Hidden Desktop). Never touches the user's physical " +
        "mouse cursor, foreground focus, or OS clipboard. Requires a vision-capable model.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("browser"), Type.Literal("app")], {
          description:
            '`"browser"` for an isolated headless Chromium tab or `"app"` for an isolated desktop application.',
        }),
        target: Type.String({
          minLength: 1,
          description:
            'Initial URL (e.g. `"https://example.com"` or `"about:blank"`) for `"browser"`, or executable name/path (e.g. `"notepad.exe"`, `"blender.exe"`) for `"app"`. Bare names are automatically resolved via PATH, Windows App Paths registry, and Program Files — call `computer_open` directly without searching the filesystem or registry first.',
        }),
        args: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Optional CLI arguments when launching an `"app"` realm (e.g. `["scene.blend"]`).',
          }),
        ),
        script: Type.Optional(
          Type.Object(
            {
              content: Type.String({
                minLength: 1,
                description:
                  "Inline script source (e.g. Blender Python `bpy` script). The host writes it to a staged file automatically and passes `[flag, scriptPath]` to the app — never open Notepad just to create a script file.",
              }),
              extension: Type.Optional(
                Type.String({
                  description:
                    'File extension for the staged script (defaults to `".py"`).',
                }),
              ),
              flag: Type.Optional(
                Type.String({
                  description:
                    'CLI flag preceding the staged script path (defaults to `"--python"`).',
                }),
              ),
            },
            {
              description:
                'Inline script to materialize and pass to a scriptable `"app"` (such as Blender). Implies `reuse: false` unless overridden.',
            },
          ),
        ),
        title: Type.Optional(
          Type.String({
            description: "Optional human-readable window or tab title.",
          }),
        ),
        viewport: Type.Optional(viewportSchema),
        reuse: Type.Optional(
          Type.Boolean({
            description:
              "Reuse an existing open realm in this session with the same kind and target (defaults to true).",
          }),
        ),
      }),
      async execute(args, run: ToolRun<ComputerToolContext>) {
        const vision = resolveSessionVisionGate(
          service,
          meta,
          session,
          deps.models?.(),
        );
        if (!vision.ok) {
          return toolError(vision.message);
        }

        try {
          const agentName =
            meta.agentId !== undefined
              ? deps.agentName?.(meta.agentId)
              : undefined;
          const taskId = deps.taskOfSession?.(meta);
          const machineId = deps.machineOfSession?.(meta);
          const viewport: ViewportSize | undefined =
            args.viewport === undefined
              ? undefined
              : {
                  width: args.viewport.width,
                  height: args.viewport.height,
                  ...(args.viewport.scaleFactor === undefined
                    ? {}
                    : { scaleFactor: args.viewport.scaleFactor }),
                };

          const hasLaunchOverrides =
            (args.args !== undefined && args.args.length > 0) ||
            args.script !== undefined;

          const { realm, reused } = await service.openRealm({
            kind: args.kind,
            target: args.target,
            args: args.args,
            script: args.script,
            title: args.title,
            viewport,
            reuse: args.reuse ?? (hasLaunchOverrides ? false : undefined),
            sessionId: meta.id,
            agentId: meta.agentId,
            agentName,
            conversationId: meta.conversationId,
            taskId,
            machineId,
            cwd: meta.cwd,
            meta,
            ask: run.context.ask,
            askUser: run.context.askUser,
          });
          const view = realm.view();
          return text(
            `${reused ? "Reused" : "Opened"} ${view.kind} realm "${view.id}" (${view.target}, tier=${view.tier}, viewport=${String(view.viewport.width)}x${String(view.viewport.height)}, controller=${view.controller}, epoch=${String(view.epoch)}).`,
            {
              realmId: view.id,
              reused,
              realm: view,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const observe = defineTool({
      name: "computer_observe",
      label: "computer_observe",
      description:
        "Capture a clean screenshot from an isolated Computer Use realm (never painted with a " +
        "synthetic cursor). Supports GroundCascade zoomed observation via `crop: { x, y, width, " +
        "height, unit }` (normalized 0..1000 by default) for dense UI inspection, and optional " +
        "`locate` prompt to run the configured fast `groundingModel` on the captured image.",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID returned by computer_open.",
        }),
        crop: Type.Optional(cropBoxSchema),
        format: Type.Optional(
          Type.Union([
            Type.Literal("png"),
            Type.Literal("jpeg"),
            Type.Literal("webp"),
          ]),
        ),
        locate: Type.Optional(
          Type.String({
            description:
              "Optional UI element description to localize with the fast groundingModel if configured.",
          }),
        ),
      }),
      async execute(args, run) {
        const vision = resolveSessionVisionGate(
          service,
          meta,
          session,
          deps.models?.(),
        );
        if (!vision.ok) {
          return toolError(vision.message);
        }

        try {
          const crop: CropBox | undefined =
            args.crop === undefined
              ? undefined
              : {
                  x: args.crop.x,
                  y: args.crop.y,
                  width: args.crop.width,
                  height: args.crop.height,
                  ...(args.crop.unit === undefined
                    ? {}
                    : { unit: args.crop.unit as CoordinateUnit }),
                };

          const { observation, view } = await service.observe(args.realmId, {
            crop,
            format: args.format,
          });

          // Detect stagnant observations (2+ consecutive identical frames on the same realm) so the
          // model stops repeating ineffective clicks/shortcuts and adjusts strategy early.
          let stagnantHint: string | undefined;
          if (crop === undefined) {
            const sig = `${String(observation.data.length)}:${observation.data.slice(0, 96)}:${observation.data.slice(-96)}`;
            const prev = stagnantFrames.get(args.realmId);
            const count = prev?.sig === sig ? prev.count + 1 : 1;
            stagnantFrames.set(args.realmId, { sig, count });
            if (count >= 3) {
              stagnantHint =
                "Hint: the screen has not changed across 3 consecutive observations. " +
                "Avoid repeating the same click/shortcut; verify coordinates, try menu/keyboard " +
                "alternatives, or use the app's CLI/script interface if available.";
            }
          }

          let grounded:
            | {
                modelId: string;
                rawText: string;
                localNormalized?: { x: number; y: number } | undefined;
                viewportNormalized?: { x: number; y: number } | undefined;
                viewportPixel?: { x: number; y: number } | undefined;
              }
            | undefined;

          if (
            args.locate !== undefined &&
            args.locate.trim() !== "" &&
            service.groundingModel() !== null
          ) {
            const loc = await service.locateWithGrounder({
              realmId: args.realmId,
              prompt: args.locate,
              image: {
                mimeType: observation.mimeType,
                data: observation.data,
              },
              viewport: view.viewport,
              crop,
              meta,
              models: session?.models ?? deps.models?.(),
              signal: run.call.signal,
            });
            grounded = {
              modelId: loc.modelId,
              rawText: loc.rawText,
              localNormalized: loc.localNormalized,
              viewportNormalized: loc.viewportNormalized,
              viewportPixel: loc.viewportPixel,
            };
          }

          const lines = [
            `Realm: ${view.id} (${view.kind}, tier=${view.tier})`,
            `Title: ${view.title}`,
            `Target: ${view.target}`,
            `Viewport: ${String(view.viewport.width)}x${String(view.viewport.height)}`,
            ...(observation.cropRect === undefined
              ? []
              : [
                  `CropRect (px): x=${String(observation.cropRect.x)}, y=${String(observation.cropRect.y)}, width=${String(observation.cropRect.width)}, height=${String(observation.cropRect.height)}`,
                ]),
            `Controller: ${view.controller} (epoch=${String(view.epoch)})`,
            `Cursor (normalized 0..1000): (${String(view.cursor.x)}, ${String(view.cursor.y)}) [${view.cursor.kind}]`,
            `Picker: ${view.picker.status}${view.picker.files.length > 0 ? ` (${view.picker.files.join(", ")})` : ""}`,
            ...(grounded?.viewportNormalized === undefined
              ? []
              : [
                  `Grounded "${args.locate}" (${grounded.modelId}): normalized (${String(grounded.viewportNormalized.x)}, ${String(grounded.viewportNormalized.y)})`,
                ]),
            ...(stagnantHint === undefined ? [] : [stagnantHint]),
          ];

          const details = {
            realmId: view.id,
            title: view.title,
            target: view.target,
            viewport: view.viewport,
            observationViewport: observation.viewport,
            ...(observation.cropRect === undefined
              ? {}
              : { cropRect: observation.cropRect }),
            controller: view.controller,
            epoch: view.epoch,
            cursor: view.cursor,
            picker: view.picker,
            ...(grounded === undefined ? {} : { grounded }),
          };

          return {
            content: [
              {
                type: "image",
                mimeType: observation.mimeType,
                data: observation.data,
              },
              {
                type: "text",
                text: lines.join("\n"),
              },
            ],
            details,
          };
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const act = defineTool({
      name: "computer_act",
      label: "computer_act",
      description:
        `Execute 1..${String(MAX_MICRO_ACTIONS)} micro-actions (\`move\`, \`click\`, \`double_click\`, ` +
        "`right_click`, `drag`, `scroll`, `type`, `key`, `wait`) in normalized `0..1000` " +
        "(or `percent`/`pixel`) coordinates. Respects the single-writer lock (`agent` vs `user` " +
        "takeover) and stops early if a modal dialog or navigation interrupts the batch.",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID returned by computer_open.",
        }),
        actions: Type.Array(microActionSchema, {
          minItems: 1,
          maxItems: MAX_MICRO_ACTIONS,
          description: `Ordered list of 1..${String(MAX_MICRO_ACTIONS)} micro-actions to perform.`,
        }),
        expectedEpoch: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Optional lock epoch guard; rejects immediately if the realm epoch has advanced.",
          }),
        ),
        crop: Type.Optional(cropBoxSchema),
      }),
      async execute(args) {
        try {
          const crop: CropBox | undefined =
            args.crop === undefined
              ? undefined
              : {
                  x: args.crop.x,
                  y: args.crop.y,
                  width: args.crop.width,
                  height: args.crop.height,
                  ...(args.crop.unit === undefined
                    ? {}
                    : { unit: args.crop.unit as CoordinateUnit }),
                };

          const result = await service.act(
            args.realmId,
            args.actions as ComputerMicroAction[],
            {
              expectedEpoch: args.expectedEpoch,
              crop,
            },
          );
          const realm = service.requireLocalRealm(args.realmId);
          const view = realm.view();

          const statusNotes: string[] = [];
          if (result.aborted) statusNotes.push("aborted by controller change");
          if (result.interruptedByModalOrNavigation) {
            statusNotes.push("interrupted early by modal or navigation");
          }

          return text(
            `Executed ${String(result.completedSteps)}/${String(result.totalSteps)} action(s) on realm "${args.realmId}"` +
              `${statusNotes.length > 0 ? ` (${statusNotes.join("; ")})` : ""}: ${result.summary}. ` +
              `Cursor is at (${String(result.cursor.x)}, ${String(result.cursor.y)}), picker=${view.picker.status}, epoch=${String(result.epoch)}.`,
            {
              realmId: args.realmId,
              ...result,
              picker: view.picker,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const stageFiles = defineTool({
      name: "computer_stage_files",
      label: "computer_stage_files",
      description:
        "Pre-arm the realm's silent file picker broker with one or more file paths before clicking " +
        "an upload button or triggering a file dialog. Workspace/upload/staging paths are allowed " +
        "silently; paths outside the workspace trigger an Inbox user approval prompt; secret paths " +
        "are hard-denied.",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID returned by computer_open.",
        }),
        files: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description:
            "File paths to authorize and arm for the next file picker.",
        }),
        mode: Type.Optional(
          Type.Union([Type.Literal("read"), Type.Literal("write")]),
        ),
      }),
      async execute(args, run: ToolRun<ComputerToolContext>) {
        try {
          const result = await service.stageFiles(args.realmId, args.files, {
            mode: args.mode,
            cwd: meta.cwd,
            meta,
            ask: run.context.ask,
            askUser: run.context.askUser,
            signal: run.call.signal,
          });
          return text(
            `Armed file picker on realm "${args.realmId}" with ${String(result.allowedPaths.length)} file(s): ${result.picker.files.join(", ")} (status=${result.picker.status}${result.asked ? ", approved by user" : ""}).`,
            {
              realmId: args.realmId,
              picker: result.picker,
              allowedPaths: result.allowedPaths,
              asked: result.asked,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const resolvePicker = defineTool({
      name: "computer_resolve_picker",
      label: "computer_resolve_picker",
      description:
        "Resolve a pending silent file picker dialog on the realm with one or more file paths, " +
        "authorizing them through FileBrokerPolicy (triggering an Inbox approval prompt if outside " +
        "allowed workspace directories).",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID returned by computer_open.",
        }),
        files: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description: "File paths to inject into the pending file picker.",
        }),
        mode: Type.Optional(
          Type.Union([Type.Literal("read"), Type.Literal("write")]),
        ),
      }),
      async execute(args, run: ToolRun<ComputerToolContext>) {
        try {
          const result = await service.resolvePicker(args.realmId, args.files, {
            mode: args.mode,
            cwd: meta.cwd,
            meta,
            ask: run.context.ask,
            askUser: run.context.askUser,
            signal: run.call.signal,
          });
          return text(
            `Resolved file picker on realm "${args.realmId}" with ${String(result.allowedPaths.length)} file(s): ${result.picker.files.join(", ")} (status=${result.picker.status}${result.asked ? ", approved by user" : ""}).`,
            {
              realmId: args.realmId,
              picker: result.picker,
              allowedPaths: result.allowedPaths,
              asked: result.asked,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const clipboard = defineTool({
      name: "computer_clipboard",
      label: "computer_clipboard",
      description:
        "Read, write, or clear the realm's isolated VirtualClipboard without ever touching the " +
        "host OS clipboard.",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID returned by computer_open.",
        }),
        action: Type.Union([
          Type.Literal("read"),
          Type.Literal("write"),
          Type.Literal("clear"),
        ]),
        text: Type.Optional(
          Type.String({
            description: "Plain text to write when action is `write`.",
          }),
        ),
        html: Type.Optional(
          Type.String({
            description: "Optional HTML representation when action is `write`.",
          }),
        ),
      }),
      async execute(args) {
        try {
          if (args.action === "write") {
            if (args.text === undefined && args.html === undefined) {
              return toolError(
                'computer_clipboard: action "write" requires text or html',
              );
            }
            const snap = service.clipboard(args.realmId, {
              action: "write",
              payload: {
                text: args.text ?? "",
                html: args.html,
              },
            });
            return text(
              `Wrote ${String(snap.byteLength)} byte(s) to virtual clipboard of realm "${args.realmId}" (revision ${String(snap.revision)}).`,
              {
                realmId: args.realmId,
                text: snap.text,
                html: snap.html,
                byteLength: snap.byteLength,
                revision: snap.revision,
              },
            );
          }

          if (args.action === "clear") {
            const snap = service.clipboard(args.realmId, { action: "clear" });
            return text(
              `Cleared virtual clipboard of realm "${args.realmId}" (revision ${String(snap.revision)}).`,
              {
                realmId: args.realmId,
                text: snap.text,
                byteLength: snap.byteLength,
                revision: snap.revision,
              },
            );
          }

          const snap = service.clipboard(args.realmId, { action: "read" });
          return text(
            snap.text === ""
              ? `(Virtual clipboard of realm "${args.realmId}" is empty)`
              : snap.text,
            {
              realmId: args.realmId,
              text: snap.text,
              html: snap.html,
              byteLength: snap.byteLength,
              revision: snap.revision,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    const close = defineTool({
      name: "computer_close",
      label: "computer_close",
      description:
        "Release an isolated Computer Use realm and its browser or desktop resources. The app the realm was showing is left running: a Computer Use app may hold unsaved work, and only the user may decide to end it.",
      parameters: Type.Object({
        realmId: Type.String({
          minLength: 1,
          description: "The realm ID to close.",
        }),
        reason: Type.Optional(
          Type.String({
            description: "Optional reason for closing the realm.",
          }),
        ),
      }),
      async execute(args) {
        try {
          const view = await service.closeRealm(args.realmId, args.reason);
          return text(
            `Released ${view.kind} realm "${view.id}" (controller=${view.controller}, epoch=${String(view.epoch)}). The app it was showing is still running — ending a Computer Use app is the user's decision, so ask them if it should be closed.`,
            {
              realmId: view.id,
              realm: view,
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    return [
      toKernelTool(open, contextOf),
      toKernelTool(observe, contextOf),
      toKernelTool(act, contextOf),
      toKernelTool(stageFiles, contextOf),
      toKernelTool(resolvePicker, contextOf),
      toKernelTool(clipboard, contextOf),
      toKernelTool(close, contextOf),
    ] as KernelTool[];
  };
}
