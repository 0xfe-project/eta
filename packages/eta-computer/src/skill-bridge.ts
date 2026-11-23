import type {
  ComputerIsolationTier,
  ComputerMicroAction,
  ComputerPickerState,
  ComputerRealmKind,
  CoordinateUnit,
  CropBox,
  ViewportSize,
} from "@eta/client-contracts";
import type { VirtualClipboard } from "./clipboard";
import type {
  FileBrokerApprovalCallback,
  FileBrokerMode,
  FileBrokerPolicyOptions,
} from "./file-broker";
import type {
  ManagedRealm,
  RealmDriver,
  RealmManager,
  RealmObservation,
  RealmStepResult,
} from "./manager";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { MAX_MICRO_ACTIONS, resolveCropRect } from "@eta/client-contracts";
import { FileBrokerPolicy } from "./file-broker";
import { createSolidPngBuffer } from "./windows/hidden-desktop";
import { checkProcessTargetAllowed } from "./windows/probe";

export const COMPUTER_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

export const COMPUTER_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const COMPUTER_USE_SKILL_NAME = "computer-use";

export const COMPUTER_USE_SKILL_DESCRIPTION =
  "Operate web browsers and desktop applications inside isolated Computer Use realms using the Observe -> Act -> Verify loop, GroundCascade selective zoom, silent file pickers, and virtual clipboards.";

/**
 * Built-in Agent Skills 1.0.0 `SKILL.md` for `computer-use`.
 */
export const COMPUTER_USE_SKILL_MD = `---
name: ${COMPUTER_USE_SKILL_NAME}
description: ${COMPUTER_USE_SKILL_DESCRIPTION}
---

# Computer Use (\`computer-use\`)

Operate web pages and Windows desktop applications inside **isolated realms** without ever moving the user's physical mouse cursor, stealing window focus, popping up blocking OS file dialogs, or touching the host OS clipboard.

## 1. The Observe -> Act -> Verify Loop

Always follow a strict closed-loop discipline inside an isolated realm (\`BrowserRealm\` over CDP or \`WindowsAppRealm\` via Windows Child Session / Hidden Desktop):

1. **Open / Reuse**: Call \`computer_open\` with \`kind: "browser"\` (URL target) or \`kind: "app"\` (executable target) to acquire a \`realmId\`.
   - For Windows desktop apps, pass the bare executable name directly (e.g. \`"notepad.exe"\`, \`"blender.exe"\`) — it auto-resolves via PATH, App Paths registry, and Program Files. Never launch \`explorer.exe\` just to search for an application, and never open duplicate realms for an app that is already open (reuse the existing \`realmId\`).
   - **Scriptable pro apps (Blender, etc.)**: For complex modeling, materials, lighting, keyframe animation, or rendering that is tedious or fragile via mouse clicks, pass the Python code directly in \`computer_open(kind="app", target="blender.exe", script={ content: "import bpy\\n..." })\`. The host writes the staged script file and launches Blender with \`--python <scriptPath>\` in one step — **never open Notepad or a browser just to write or save a script file**. Then verify the resulting live viewport via \`computer_observe\`.
   - **Never end the app.** The realm's app may hold work nobody saved. \`computer_close\` only releases the realm and leaves the program running; that is deliberate, so do not look for another way to kill it (no \`Stop-Process\`, no \`taskkill\`, no killing the \`powershell\` worker). If a launch replies that the target is already open in another realm, ask the user to close that window — ending a Computer Use app is their decision alone.
2. **Observe**: Call \`computer_observe\` with \`realmId\` to capture a clean screenshot frame and inspect the realm's \`viewport\`, \`controller\`, \`epoch\`, \`cursor\`, and \`picker\` state.
3. **Act**: Call \`computer_act\` with 1..8 micro-actions (\`move\`, \`click\`, \`double_click\`, \`right_click\`, \`drag\`, \`scroll\`, \`type\`, \`key\`, \`wait\`).
   - All coordinates default to **\`0..1000\` normalized viewport space** (\`(0, 0)\` is top-left, \`(500, 500)\` is center, \`(1000, 1000)\` is bottom-right).
   - Keep micro-action batches short and coherent; batches automatically stop early if a modal dialog, navigation, or user takeover interrupts execution.
4. **Verify**: Re-observe with \`computer_observe\` (or inspect filesystem/DOM output) after every state-changing action batch before proceeding.

## 2. GroundCascade Selective Zoom (\`crop\`)

For dense UI layouts, small toolbar icons, data tables, or high-DPI targets where full-viewport screenshots are ambiguous:

1. Call \`computer_observe\` with a selective zoom window:
   \`\`\`json
   {
     "realmId": "<realmId>",
     "crop": { "x": 200, "y": 150, "width": 300, "height": 250, "unit": "normalized" }
   }
   \`\`\`
2. Verify the target control inside the zoomed crop before clicking.
3. When acting on coordinates measured relative to that cropped observation, pass the same \`crop\` box to \`computer_act\` so crop-local normalized coordinates are mapped back to the full viewport with sub-pixel precision.

## 3. Silent File Picker Discipline

Never attempt to click native OS file dialog coordinates (\`comdlg32\` / \`#32770\`) blindly:

- **Before clicking an Upload, Open, Import, or Save As button**: always pre-arm the silent file broker with \`computer_stage_files\`:
  \`\`\`json
  {
    "realmId": "<realmId>",
    "files": ["reports/q4-summary.csv"],
    "mode": "read"
  }
  \`\`\`
- **If a file picker is already open (\`picker.status === "pending_input"\`)**: call \`computer_resolve_picker\` with the target \`files\` and \`mode\` (\`"read"\` for uploads/opens, \`"write"\` for Save As).
- Paths inside the project workspace, worktree, uploads, or staging directories resolve silently with zero main-desktop popups. Paths outside the workspace automatically pause for user approval via the Inbox gate, and sensitive paths (such as \`~/.eta/secret.key\`) are hard-denied.

## 4. Isolated Virtual Clipboard

Each realm has its own in-memory \`VirtualClipboard\` completely isolated from the host OS clipboard:

- Synthesized \`Control+C\` / \`Control+V\` shortcuts inside the realm read and write only the realm's \`VirtualClipboard\`.
- Use \`computer_clipboard\` (\`action: "read" | "write" | "clear"\`) to seed text/HTML into the realm before pasting or to inspect text copied inside the realm.

## 5. Objective Completion Judge

Never assume a click or keystroke succeeded merely because \`computer_act\` returned without error:

- **File saves / downloads**: verify the target file exists on disk and has a non-zero byte size matching expected content.
- **Web / form submissions**: verify via \`computer_observe\` that the resulting DOM state, confirmation banner, or URL/title reflects completion.
- **Desktop app workflows**: verify window title changes, status bar indicators, or saved output files before closing the realm with \`computer_close\`.
`;

export const COMPUTER_TOOL_NAMES = [
  "computer_open",
  "computer_observe",
  "computer_act",
  "computer_stage_files",
  "computer_resolve_picker",
  "computer_clipboard",
  "computer_close",
] as const;

export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

export interface ComputerMcpToolDefinition {
  name: ComputerToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
}

export type ComputerMcpContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      data: string;
    };

export interface ComputerMcpToolCallResult<
  TDetails extends Record<string, unknown> = Record<string, unknown>,
> {
  content: ComputerMcpContentBlock[];
  isError?: boolean | undefined;
  details: TDetails;
}

export interface ComputerMcpDriverFactoryRequest {
  kind: ComputerRealmKind;
  target: string;
  title?: string | undefined;
  viewport?: ViewportSize | undefined;
  fileBroker: FileBrokerPolicy;
}

export interface ComputerMcpToolCallOptions {
  sessionId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  conversationId?: string | undefined;
  taskId?: string | undefined;
  machineId?: string | undefined;
  cwd?: string | undefined;
  fileBroker?: FileBrokerPolicy | undefined;
  fileBrokerOptions?: FileBrokerPolicyOptions | undefined;
  askApproval?: FileBrokerApprovalCallback | undefined;
  driverFactory?:
    | ((
        request: ComputerMcpDriverFactoryRequest,
      ) => Promise<RealmDriver> | RealmDriver)
    | undefined;
}

/**
 * Default lightweight in-memory `RealmDriver` used by the MCP bridge when no custom
 * `driverFactory` is injected.
 */
class DefaultBridgeRealmDriver implements RealmDriver {
  readonly kind: ComputerRealmKind;
  readonly tier: ComputerIsolationTier;
  readonly fileBroker: FileBrokerPolicy;
  #title: string;
  #target: string;
  #viewport: ViewportSize;
  #watched = false;
  #closed = false;
  #picker: ComputerPickerState;
  readonly #pngCache = new Map<string, string>();

  constructor(options: {
    kind: ComputerRealmKind;
    target: string;
    title?: string | undefined;
    viewport?: ViewportSize | undefined;
    fileBroker: FileBrokerPolicy;
  }) {
    this.kind = options.kind;
    this.tier = options.kind === "browser" ? "cdp" : "hidden_desktop";
    this.fileBroker = options.fileBroker;
    this.#target = options.target;
    this.#title =
      options.title ??
      (options.kind === "browser"
        ? `Browser (${options.target})`
        : `App (${options.target})`);
    this.#viewport = {
      width: options.viewport?.width ?? 1280,
      height: options.viewport?.height ?? 800,
      scaleFactor: options.viewport?.scaleFactor ?? 1,
    };
    this.#picker = {
      status: "idle",
      files: [],
      updatedAt: Date.now(),
    };
  }

  title(): string {
    return this.#title;
  }

  target(): string {
    return this.#target;
  }

  viewport(): ViewportSize {
    return { ...this.#viewport };
  }

  get isWatched(): boolean {
    return this.#watched;
  }

  #renderPngBase64(width: number, height: number): string {
    const sampleW = Math.max(1, Math.min(32, width));
    const sampleH = Math.max(1, Math.min(32, height));
    const key = `${String(sampleW)}x${String(sampleH)}`;
    const cached = this.#pngCache.get(key);
    if (cached !== undefined) return cached;
    const png = createSolidPngBuffer(
      sampleW,
      sampleH,
      [32, 44, 64, 255],
    ).toString("base64");
    this.#pngCache.set(key, png);
    return png;
  }

  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    if (this.#closed) {
      throw new Error("Realm driver is closed");
    }
    if (options?.crop !== undefined) {
      const cropRect = resolveCropRect(options.crop, this.#viewport);
      return {
        mimeType: "image/png",
        data: this.#renderPngBase64(cropRect.width, cropRect.height),
        viewport: {
          width: cropRect.width,
          height: cropRect.height,
          scaleFactor: this.#viewport.scaleFactor,
        },
        cropRect,
      };
    }
    return {
      mimeType: "image/png",
      data: this.#renderPngBase64(this.#viewport.width, this.#viewport.height),
      viewport: { ...this.#viewport },
    };
  }

  async step(
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ): Promise<RealmStepResult | void> {
    if (ctx.signal.aborted) return;
    if (action.kind === "type") {
      return {
        summary: `Typed "${action.text}"${action.submit ? " + Enter" : ""}`,
      };
    }
    if (action.kind === "key") {
      const lower = action.key.toLowerCase();
      if (lower === "control+c" || lower === "ctrl+c" || lower === "meta+c") {
        if (ctx.clipboard.readText() === "") {
          ctx.clipboard.writeText(this.#title);
        }
      }
      return { summary: `Pressed key ${action.key}` };
    }
    return undefined;
  }

  async stageFiles(files: string[]): Promise<ComputerPickerState> {
    this.#picker = {
      status: files.length > 0 ? "armed" : "idle",
      files: files.map((f) => path.basename(f)),
      updatedAt: Date.now(),
    };
    return { ...this.#picker, files: [...this.#picker.files] };
  }

  async resolvePicker(files: string[]): Promise<ComputerPickerState> {
    this.#picker = {
      status: "intercepted_silent",
      files: files.map((f) => path.basename(f)),
      updatedAt: Date.now(),
    };
    return { ...this.#picker, files: [...this.#picker.files] };
  }

  setWatched(watched: boolean): void {
    this.#watched = watched;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#watched = false;
  }
}

const CROP_BOX_JSON_SCHEMA = {
  type: "object",
  properties: {
    x: {
      type: "number",
      minimum: 0,
      description:
        "Left coordinate of the crop box (default unit: normalized 0..1000).",
    },
    y: {
      type: "number",
      minimum: 0,
      description:
        "Top coordinate of the crop box (default unit: normalized 0..1000).",
    },
    width: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Width of the crop box.",
    },
    height: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Height of the crop box.",
    },
    unit: {
      type: "string",
      enum: ["normalized", "percent", "pixel"],
    },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
} as const;

/**
 * Return standard MCP tool definitions for the 7 Computer Use tools so external runtimes
 * (Claude Code, Codex, OpenCode) or an MCP stdio wrapper can expose the exact same contract.
 */
export function createComputerMcpToolDefinitions(): ComputerMcpToolDefinition[] {
  return [
    {
      name: "computer_open",
      description:
        "Open or reuse an isolated Computer Use realm (`browser` via headless Chromium CDP pipe " +
        "or `app` via Windows Child Session / Hidden Desktop). Never touches the user's physical " +
        "mouse cursor, foreground focus, or OS clipboard.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["browser", "app"],
            description:
              '`"browser"` for an isolated headless Chromium tab or `"app"` for an isolated desktop application.',
          },
          target: {
            type: "string",
            minLength: 1,
            description:
              'Initial URL (e.g. `"https://example.com"`) for `"browser"`, or executable name/path (e.g. `"notepad.exe"`) for `"app"`.',
          },
          title: {
            type: "string",
            description: "Optional human-readable window or tab title.",
          },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer", minimum: 64, maximum: 7680 },
              height: { type: "integer", minimum: 64, maximum: 4320 },
              scaleFactor: { type: "number", minimum: 0.5, maximum: 4 },
            },
            required: ["width", "height"],
            additionalProperties: false,
          },
          reuse: {
            type: "boolean",
            description:
              "Reuse an existing open realm with the same kind and target (defaults to true).",
          },
        },
        required: ["kind", "target"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_observe",
      description:
        "Capture a clean screenshot from an isolated Computer Use realm (never painted with a " +
        "synthetic cursor). Supports GroundCascade selective zoom via `crop: { x, y, width, height, unit }` " +
        "(normalized 0..1000 by default) for dense UI inspection.",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID returned by computer_open.",
          },
          crop: CROP_BOX_JSON_SCHEMA,
          format: {
            type: "string",
            enum: ["png", "jpeg", "webp"],
          },
          locate: {
            type: "string",
            description:
              "Optional UI element description to localize with a fast groundingModel if configured.",
          },
        },
        required: ["realmId"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_act",
      description:
        `Execute 1..${String(MAX_MICRO_ACTIONS)} micro-actions (\`move\`, \`click\`, \`double_click\`, ` +
        "`right_click`, `drag`, `scroll`, `type`, `key`, `wait`) in normalized `0..1000` " +
        "(or `percent`/`pixel`) coordinates. Respects the single-writer lock (`agent` vs `user` takeover).",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID returned by computer_open.",
          },
          actions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_MICRO_ACTIONS,
            description: `Ordered list of 1..${String(MAX_MICRO_ACTIONS)} micro-actions to perform.`,
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "move",
                    "click",
                    "double_click",
                    "right_click",
                    "drag",
                    "scroll",
                    "type",
                    "key",
                    "wait",
                  ],
                },
                x: { type: "number" },
                y: { type: "number" },
                fromX: { type: "number" },
                fromY: { type: "number" },
                toX: { type: "number" },
                toY: { type: "number" },
                deltaX: { type: "number" },
                deltaY: { type: "number" },
                unit: {
                  type: "string",
                  enum: ["normalized", "percent", "pixel"],
                },
                button: {
                  type: "string",
                  enum: ["left", "right", "middle"],
                },
                text: { type: "string" },
                submit: { type: "boolean" },
                key: { type: "string" },
                durationMs: { type: "number", minimum: 0, maximum: 30_000 },
              },
              required: ["kind"],
            },
          },
          expectedEpoch: {
            type: "integer",
            minimum: 1,
            description:
              "Optional lock epoch guard; rejects immediately if the realm epoch has advanced.",
          },
          crop: CROP_BOX_JSON_SCHEMA,
        },
        required: ["realmId", "actions"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_stage_files",
      description:
        "Pre-arm the realm's silent file picker broker with one or more file paths before clicking " +
        "an upload button or triggering a file dialog. Workspace paths are allowed silently; " +
        "out-of-workspace paths trigger an approval gate; secret paths are hard-denied.",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID returned by computer_open.",
          },
          files: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "File paths to authorize and arm for the next file picker.",
          },
          mode: {
            type: "string",
            enum: ["read", "write"],
          },
        },
        required: ["realmId", "files"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_resolve_picker",
      description:
        "Resolve a pending silent file picker dialog on the realm with one or more file paths, " +
        "authorizing them through FileBrokerPolicy.",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID returned by computer_open.",
          },
          files: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description: "File paths to inject into the pending file picker.",
          },
          mode: {
            type: "string",
            enum: ["read", "write"],
          },
        },
        required: ["realmId", "files"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_clipboard",
      description:
        "Read, write, or clear the realm's isolated VirtualClipboard without ever touching the " +
        "host OS clipboard.",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID returned by computer_open.",
          },
          action: {
            type: "string",
            enum: ["read", "write", "clear"],
          },
          text: {
            type: "string",
            description: "Plain text to write when action is `write`.",
          },
          html: {
            type: "string",
            description: "Optional HTML representation when action is `write`.",
          },
        },
        required: ["realmId", "action"],
        additionalProperties: false,
      },
    },
    {
      name: "computer_close",
      description:
        "Close an isolated Computer Use realm and release its browser or desktop resources.",
      inputSchema: {
        type: "object",
        properties: {
          realmId: {
            type: "string",
            minLength: 1,
            description: "The realm ID to close.",
          },
          reason: {
            type: "string",
            description: "Optional reason for closing the realm.",
          },
        },
        required: ["realmId"],
        additionalProperties: false,
      },
    },
  ];
}

function mcpTextResult<TDetails extends Record<string, unknown>>(
  message: string,
  details: TDetails,
): ComputerMcpToolCallResult<TDetails> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function mcpErrorResult(error: unknown): ComputerMcpToolCallResult<{
  error: string;
}> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { error: message },
  };
}

function parseCropArg(raw: unknown): CropBox | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.x !== "number" ||
    typeof obj.y !== "number" ||
    typeof obj.width !== "number" ||
    typeof obj.height !== "number"
  ) {
    throw new TypeError(
      "crop must contain numeric x, y, width, and height fields",
    );
  }
  const unit =
    obj.unit === "normalized" || obj.unit === "percent" || obj.unit === "pixel"
      ? (obj.unit as CoordinateUnit)
      : undefined;
  return {
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
    ...(unit === undefined ? {} : { unit }),
  };
}

function resolveFileBrokerForRealm(
  realm: ManagedRealm | undefined,
  options?: ComputerMcpToolCallOptions,
): FileBrokerPolicy {
  if (options?.fileBroker !== undefined) {
    return options.fileBroker;
  }
  if (
    options?.fileBrokerOptions !== undefined ||
    options?.askApproval !== undefined ||
    options?.cwd !== undefined
  ) {
    return new FileBrokerPolicy({
      projectDir:
        options.fileBrokerOptions?.projectDir ?? options.cwd ?? process.cwd(),
      ...options.fileBrokerOptions,
      ...(options.askApproval === undefined
        ? {}
        : { askApproval: options.askApproval }),
    });
  }
  const driverPolicy = (
    realm?.driver as { fileBroker?: FileBrokerPolicy | undefined } | undefined
  )?.fileBroker;
  if (driverPolicy instanceof FileBrokerPolicy) {
    return driverPolicy;
  }
  return new FileBrokerPolicy({
    projectDir: process.cwd(),
  });
}

/**
 * Execute an MCP tool call (`computer_open`, `computer_observe`, `computer_act`,
 * `computer_stage_files`, `computer_resolve_picker`, `computer_clipboard`, `computer_close`)
 * directly against a `RealmManager`.
 */
export async function handleComputerMcpToolCall(
  manager: RealmManager,
  name: string,
  args: Record<string, unknown> = {},
  options?: ComputerMcpToolCallOptions,
): Promise<ComputerMcpToolCallResult> {
  try {
    switch (name) {
      case "computer_open": {
        const kind = args.kind;
        if (kind !== "browser" && kind !== "app") {
          return mcpErrorResult(
            'computer_open: "kind" must be "browser" or "app"',
          );
        }
        const target =
          typeof args.target === "string" ? args.target.trim() : "";
        if (!target) {
          return mcpErrorResult(
            'computer_open: "target" must be a non-empty string',
          );
        }
        if (kind === "app") {
          const allowed = checkProcessTargetAllowed(target);
          if (!allowed.allowed) {
            return mcpErrorResult(
              `${allowed.code}: target "${target}" is blocked by the sensitive process denylist (${allowed.matchedEntry})`,
            );
          }
        }

        const reuse = args.reuse !== false;
        const sessionId = options?.sessionId ?? "default";
        if (reuse && typeof args.id !== "string") {
          const existing = manager
            .list()
            .find(
              (candidate) =>
                candidate.controller !== "closed" &&
                (options?.sessionId === undefined ||
                  candidate.sessionId === sessionId) &&
                candidate.driver.kind === kind &&
                candidate.driver.target() === target,
            );
          if (existing !== undefined) {
            const view = existing.view();
            return mcpTextResult(
              `Reused ${view.kind} realm "${view.id}" (${view.target}, tier=${view.tier}, viewport=${String(view.viewport.width)}x${String(view.viewport.height)}, controller=${view.controller}, epoch=${String(view.epoch)}).`,
              {
                realmId: view.id,
                reused: true,
                realm: view,
              },
            );
          }
        }

        const rawViewport =
          typeof args.viewport === "object" &&
          args.viewport !== null &&
          !Array.isArray(args.viewport)
            ? (args.viewport as Record<string, unknown>)
            : undefined;
        const viewport: ViewportSize | undefined =
          rawViewport !== undefined &&
          typeof rawViewport.width === "number" &&
          typeof rawViewport.height === "number"
            ? {
                width: rawViewport.width,
                height: rawViewport.height,
                ...(typeof rawViewport.scaleFactor === "number"
                  ? { scaleFactor: rawViewport.scaleFactor }
                  : {}),
              }
            : undefined;

        const title =
          typeof args.title === "string" && args.title.trim() !== ""
            ? args.title
            : undefined;
        const fileBroker = resolveFileBrokerForRealm(undefined, options);
        const driver =
          options?.driverFactory !== undefined
            ? await options.driverFactory({
                kind,
                target,
                title,
                viewport,
                fileBroker,
              })
            : new DefaultBridgeRealmDriver({
                kind,
                target,
                title,
                viewport,
                fileBroker,
              });

        const realm = manager.register(driver, {
          id: typeof args.id === "string" ? args.id : undefined,
          sessionId,
          agentId: options?.agentId,
          agentName: options?.agentName,
          conversationId: options?.conversationId,
          taskId: options?.taskId,
          machineId: options?.machineId ?? manager.machineId,
        });
        const view = realm.view();
        return mcpTextResult(
          `Opened ${view.kind} realm "${view.id}" (${view.target}, tier=${view.tier}, viewport=${String(view.viewport.width)}x${String(view.viewport.height)}, controller=${view.controller}, epoch=${String(view.epoch)}).`,
          {
            realmId: view.id,
            reused: false,
            realm: view,
          },
        );
      }

      case "computer_observe": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult('computer_observe: "realmId" is required');
        }
        const realm = manager.require(realmId);
        const crop = parseCropArg(args.crop);
        const format =
          args.format === "png" ||
          args.format === "jpeg" ||
          args.format === "webp"
            ? args.format
            : undefined;
        const observation = await realm.observe({ crop, format });
        const view = realm.view();

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
      }

      case "computer_act": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult('computer_act: "realmId" is required');
        }
        if (!Array.isArray(args.actions) || args.actions.length === 0) {
          return mcpErrorResult(
            'computer_act: "actions" must be a non-empty array of micro-actions',
          );
        }
        const realm = manager.require(realmId);
        const crop = parseCropArg(args.crop);
        const expectedEpoch =
          typeof args.expectedEpoch === "number"
            ? args.expectedEpoch
            : undefined;
        const result = await realm.act(args.actions as ComputerMicroAction[], {
          expectedEpoch,
          crop,
        });
        const view = realm.view();
        return mcpTextResult(
          `Executed ${String(result.completedSteps)}/${String(result.totalSteps)} action(s) on realm "${realmId}": ${result.summary}. Cursor is at (${String(result.cursor.x)}, ${String(result.cursor.y)}), picker=${view.picker.status}, epoch=${String(result.epoch)}.`,
          {
            realmId,
            ...result,
            picker: view.picker,
          },
        );
      }

      case "computer_stage_files": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult('computer_stage_files: "realmId" is required');
        }
        if (
          !Array.isArray(args.files) ||
          args.files.length === 0 ||
          !args.files.every((f) => typeof f === "string" && f.trim().length > 0)
        ) {
          return mcpErrorResult(
            'computer_stage_files: "files" must be a non-empty array of file paths',
          );
        }
        const realm = manager.require(realmId);
        const mode: FileBrokerMode = args.mode === "write" ? "write" : "read";
        const policy = resolveFileBrokerForRealm(realm, options);
        const auth = await policy.authorizeFiles(args.files as string[], mode);
        const picker = await realm.stageFiles(auth.allowed);
        return mcpTextResult(
          `Armed file picker on realm "${realmId}" with ${String(auth.allowed.length)} file(s): ${picker.files.join(", ")} (status=${picker.status}${auth.asked ? ", approved by user" : ""}).`,
          {
            realmId,
            picker,
            allowedPaths: auth.allowed,
            asked: auth.asked,
          },
        );
      }

      case "computer_resolve_picker": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult(
            'computer_resolve_picker: "realmId" is required',
          );
        }
        if (
          !Array.isArray(args.files) ||
          args.files.length === 0 ||
          !args.files.every((f) => typeof f === "string" && f.trim().length > 0)
        ) {
          return mcpErrorResult(
            'computer_resolve_picker: "files" must be a non-empty array of file paths',
          );
        }
        const realm = manager.require(realmId);
        const mode: FileBrokerMode = args.mode === "write" ? "write" : "read";
        const policy = resolveFileBrokerForRealm(realm, options);
        const auth = await policy.authorizeFiles(args.files as string[], mode);
        const picker = await realm.resolvePicker(auth.allowed);
        return mcpTextResult(
          `Resolved file picker on realm "${realmId}" with ${String(auth.allowed.length)} file(s): ${picker.files.join(", ")} (status=${picker.status}${auth.asked ? ", approved by user" : ""}).`,
          {
            realmId,
            picker,
            allowedPaths: auth.allowed,
            asked: auth.asked,
          },
        );
      }

      case "computer_clipboard": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult('computer_clipboard: "realmId" is required');
        }
        const action = args.action;
        if (action !== "read" && action !== "write" && action !== "clear") {
          return mcpErrorResult(
            'computer_clipboard: "action" must be "read", "write", or "clear"',
          );
        }
        const realm = manager.require(realmId);
        if (action === "write") {
          const text = typeof args.text === "string" ? args.text : undefined;
          const html = typeof args.html === "string" ? args.html : undefined;
          if (text === undefined && html === undefined) {
            return mcpErrorResult(
              'computer_clipboard: action "write" requires text or html',
            );
          }
          const snap = realm.clipboard.write({
            text: text ?? "",
            html,
          });
          return mcpTextResult(
            `Wrote ${String(snap.byteLength)} byte(s) to virtual clipboard of realm "${realmId}" (revision ${String(snap.revision)}).`,
            {
              realmId,
              text: snap.text,
              html: snap.html,
              byteLength: snap.byteLength,
              revision: snap.revision,
            },
          );
        }
        if (action === "clear") {
          const snap = realm.clipboard.clear();
          return mcpTextResult(
            `Cleared virtual clipboard of realm "${realmId}" (revision ${String(snap.revision)}).`,
            {
              realmId,
              text: snap.text,
              byteLength: snap.byteLength,
              revision: snap.revision,
            },
          );
        }
        const snap = realm.clipboard.snapshot();
        return mcpTextResult(
          snap.text === ""
            ? `(Virtual clipboard of realm "${realmId}" is empty)`
            : snap.text,
          {
            realmId,
            text: snap.text,
            html: snap.html,
            byteLength: snap.byteLength,
            revision: snap.revision,
          },
        );
      }

      case "computer_close": {
        const realmId =
          typeof args.realmId === "string" ? args.realmId.trim() : "";
        if (!realmId) {
          return mcpErrorResult('computer_close: "realmId" is required');
        }
        const reason =
          typeof args.reason === "string" && args.reason.trim() !== ""
            ? args.reason
            : undefined;
        const realm = manager.require(realmId);
        const view = await realm.close(reason);
        return mcpTextResult(
          `Closed ${view.kind} realm "${view.id}" (controller=${view.controller}, epoch=${String(view.epoch)}).`,
          {
            realmId: view.id,
            realm: view,
          },
        );
      }

      default:
        return mcpErrorResult(`Unknown Computer Use MCP tool: "${name}"`);
    }
  } catch (error) {
    return mcpErrorResult(error);
  }
}

export interface WriteComputerPluginBundleOptions {
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  mcpServers?: Record<string, unknown> | undefined;
}

export interface ComputerPluginBundleResult {
  root: string;
  pluginJsonPath: string;
  skillMdPath: string;
  mcpJsonPath?: string | undefined;
  manifest: {
    $schema: string;
    name: string;
    version: string;
    description: string;
  };
}

/**
 * Materialize a spec-valid Agent Plugins 1.0.0 directory (`plugin.json`,
 * `skills/computer-use/SKILL.md`, and optional `mcp.json`) at `targetDir`
 * that passes `loadPlugin` validation with zero reports.
 */
export async function writeComputerPluginBundle(
  targetDir: string,
  options: WriteComputerPluginBundleOptions = {},
): Promise<ComputerPluginBundleResult> {
  const root = path.resolve(targetDir);
  const manifest = {
    $schema: COMPUTER_PLUGIN_SCHEMA,
    name: options.name ?? COMPUTER_USE_SKILL_NAME,
    version: options.version ?? "1.0.0",
    description: options.description ?? COMPUTER_USE_SKILL_DESCRIPTION,
  };

  const skillDir = path.join(root, "skills", COMPUTER_USE_SKILL_NAME);
  fs.mkdirSync(skillDir, { recursive: true });

  const pluginJsonPath = path.join(root, "plugin.json");
  fs.writeFileSync(
    pluginJsonPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const skillMdPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, COMPUTER_USE_SKILL_MD, "utf8");

  let mcpJsonPath: string | undefined;
  if (options.mcpServers !== undefined) {
    mcpJsonPath = path.join(root, "mcp.json");
    const mcpDoc = {
      $schema: COMPUTER_MCP_SCHEMA,
      mcpServers: options.mcpServers,
    };
    fs.writeFileSync(
      mcpJsonPath,
      `${JSON.stringify(mcpDoc, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    root,
    pluginJsonPath,
    skillMdPath,
    ...(mcpJsonPath === undefined ? {} : { mcpJsonPath }),
    manifest,
  };
}
