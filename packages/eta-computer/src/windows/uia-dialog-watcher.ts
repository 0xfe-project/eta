import type {
  ComputerPickerMode,
  ComputerPickerState,
} from "@eta/client-contracts";
import type { FileBrokerMode, FileBrokerPolicy } from "../file-broker";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { FileBrokerError } from "../file-broker";

const execFileAsync = promisify(execFile);

/**
 * Snapshot of a Windows `#32770` Common File Dialog (`GetOpenFileName` / `GetSaveFileName` /
 * modern Common Item Dialog `IFileOpenDialog` / `IFileSaveDialog`) owned by a realm's process tree.
 */
export interface UiaFileDialogInfo {
  /** Native HWND or unique dialog identifier inside the isolated desktop/session. */
  hwnd: string | number;
  /** Process ID owning the modal file dialog. */
  pid: number;
  /** Dialog caption / window title (e.g. `"Save As"`, `"Open"`, `"另存为"`). */
  title: string;
  /** Win32 class name (normally `"#32770"`). */
  className?: string | undefined;
  /** Detected picker mode; if omitted, inferred from `title` and button labels. */
  mode?: ComputerPickerMode | undefined;
  /** File type filter list or current filter combo text (e.g. `["*.txt", "*.*"]`). */
  accept?: string[] | undefined;
  /** AutomationId of the filename Edit box (defaults to `"1148"` or `"FileNameControlHost"`). */
  fileNameEditAutomationId?: string | undefined;
  /** AutomationId / CommandId of the primary Open/Save button (defaults to `"1"`). */
  confirmButtonAutomationId?: string | undefined;
}

export interface UiaDialogCompleteRequest {
  dialog: UiaFileDialogInfo;
  /** Canonical authorized file paths to fill into the dialog's filename control. */
  paths: readonly string[];
  /** Formatted string written via `ValuePattern.SetValue` into the filename edit control. */
  valueText: string;
  /** File-name edit control AutomationId (`"1148"` / `"FileNameControlHost"`). */
  editAutomationId: string;
  /** Confirm (Open / Save) button CommandId (`"1"`). */
  confirmButtonAutomationId: string;
  /** Whether overwrite confirmation sub-dialogs (`#32770` Confirm Save As) should be auto-accepted. */
  autoConfirmOverwrite: boolean;
}

export interface UiaDialogCompleteResult {
  completed: boolean;
  overwriteConfirmed?: boolean | undefined;
}

/**
 * Injectable backend for `UiaDialogWatcher`.
 *
 * Allows deterministic unit/integration testing of `#32770` dialog detection, `ValuePattern`
 * path injection, and `InvokePattern` confirmation without popping up windows on the host's
 * main desktop, while providing `Win32PowerShellUiaDialogBackend` for real Windows sessions.
 */
export interface UiaDialogBackend {
  /**
   * Scan the isolated desktop/session for an active top-level `#32770` file dialog belonging to
   * `rootPid` (or its child processes). Returns `null` when no file dialog is present.
   */
  findModalFileDialog: (query: {
    rootPid?: number | undefined;
    desktopName?: string | undefined;
    sessionId?: number | undefined;
  }) => Promise<UiaFileDialogInfo | null>;

  /**
   * Populate the filename edit box via UIA `ValuePattern` (`AutomationId = "1148"` /
   * `"FileNameControlHost"` / `ControlType.Edit`), invoke the Open/Save button (`CommandId = "1"`)
   * via `InvokePattern`, and optionally confirm any overwrite prompt.
   */
  completeFileDialog: (
    request: UiaDialogCompleteRequest,
  ) => Promise<UiaDialogCompleteResult>;
}

/**
 * Infer whether a `#32770` dialog is a Save dialog or an Open dialog from its title or explicit mode.
 */
export function inferUiaDialogPickerMode(
  dialog: Pick<UiaFileDialogInfo, "title" | "mode">,
): ComputerPickerMode {
  if (dialog.mode) {
    return dialog.mode;
  }
  const titleLower = dialog.title.trim().toLowerCase();
  if (
    titleLower.includes("save") ||
    titleLower.includes("export") ||
    titleLower.includes("另存为") ||
    titleLower.includes("保存")
  ) {
    return "save";
  }
  if (
    titleLower.includes("folder") ||
    titleLower.includes("directory") ||
    titleLower.includes("文件夹") ||
    titleLower.includes("目录")
  ) {
    return "open_directory";
  }
  return "open_single";
}

/**
 * Format one or more authorized paths for the Win32 Common Item Dialog filename edit control.
 * Single file: raw path. Multiple files: `"path1" "path2"`.
 */
export function formatUiaDialogFileValue(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }
  if (paths.length === 1) {
    return paths[0] ?? "";
  }
  return paths.map((p) => `"${p}"`).join(" ");
}

/**
 * Build the PowerShell UIA script that locates a `#32770` Common Item Dialog for a given PID,
 * sets the target path via `ValuePattern` on AutomationId `"1148"` / `"FileNameControlHost"` /
 * `ControlType.Edit`, invokes CommandId `"1"` via `InvokePattern`, and confirms overwrite prompts.
 */
export function buildPowerShellUiaCompleteScript(
  request: UiaDialogCompleteRequest,
): string {
  const escapedHwnd = String(request.dialog.hwnd).replace(/[^0-9a-fx-]/gi, "");
  const escapedValue = request.valueText.replace(/'/g, "''");
  const escapedEditId = request.editAutomationId.replace(/'/g, "''");
  const escapedBtnId = request.confirmButtonAutomationId.replace(/'/g, "''");
  const autoOverwrite = request.autoConfirmOverwrite ? "$true" : "$false";

  return [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    `$hwnd = [IntPtr]::new([int64]'${escapedHwnd || "0"}')`,
    "$dialog = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)",
    "if ($null -eq $dialog) { throw 'UIA dialog window not found' }",
    `$editCond1 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${escapedEditId}')`,
    "$editCond2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'FileNameControlHost')",
    "$editCond3 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)",
    "$edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond1)",
    "if ($null -eq $edit) { $edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond2) }",
    "if ($null -eq $edit) { $edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond3) }",
    "if ($null -eq $edit) { throw 'UIA filename Edit control (1148 / FileNameControlHost) not found' }",
    "$valPattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)",
    `$valPattern.SetValue('${escapedValue}')`,
    `$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${escapedBtnId}')`,
    "$btn = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)",
    "if ($null -eq $btn) { throw 'UIA confirm button (CommandId 1) not found' }",
    "$invPattern = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "$invPattern.Invoke()",
    `if (${autoOverwrite}) {`,
    "  Start-Sleep -Milliseconds 120",
    "  $subCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')",
    "  $subDialog = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Children, $subCond)",
    "  if ($null -ne $subDialog) {",
    "    $yesCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CommandButton_6')",
    "    $yesBtn = $subDialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $yesCond)",
    "    if ($null -eq $yesBtn) {",
    "      $yesCond2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '6')",
    "      $yesBtn = $subDialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $yesCond2)",
    "    }",
    "    if ($null -ne $yesBtn) {",
    "      $yesInv = $yesBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "      $yesInv.Invoke()",
    "    }",
    "  }",
    "}",
    "Write-Output 'COMPLETED'",
  ].join("; ");
}

/**
 * Real Windows UIA backend using PowerShell and `System.Windows.Automation.AutomationElement`
 * to locate `#32770` modal file dialogs owned by a realm's process tree, set the file path via
 * `ValuePattern`, and invoke Open/Save (`CommandId = "1"`) via `InvokePattern`.
 */
export class Win32PowerShellUiaDialogBackend implements UiaDialogBackend {
  private readonly runCommand: (script: string) => Promise<string>;

  constructor(options?: {
    runCommand?: ((script: string) => Promise<string>) | undefined;
  }) {
    this.runCommand =
      options?.runCommand ??
      (async (script: string): Promise<string> => {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
          },
        );
        return stdout.trim();
      });
  }

  async findModalFileDialog(query: {
    rootPid?: number | undefined;
    desktopName?: string | undefined;
    sessionId?: number | undefined;
  }): Promise<UiaFileDialogInfo | null> {
    if (process.platform !== "win32") {
      return null;
    }

    const pidFilter =
      query.rootPid !== undefined && query.rootPid > 0
        ? `$targetPid = ${String(query.rootPid)}`
        : "$targetPid = 0";

    const script = [
      "Add-Type -AssemblyName UIAutomationClient",
      "Add-Type -AssemblyName UIAutomationTypes",
      pidFilter,
      "$root = [System.Windows.Automation.AutomationElement]::RootElement",
      "$classCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')",
      "$dialogs = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $classCond)",
      "foreach ($d in $dialogs) {",
      "  $pidVal = $d.Current.ProcessId",
      "  if ($targetPid -eq 0 -or $pidVal -eq $targetPid) {",
      "    $obj = @{ hwnd = $d.Current.NativeWindowHandle; pid = $pidVal; title = $d.Current.Name; className = $d.Current.ClassName }",
      "    $obj | ConvertTo-Json -Compress",
      "    break",
      "  }",
      "}",
    ].join("; ");

    try {
      const output = await this.runCommand(script);
      if (!output) {
        return null;
      }
      const parsed = JSON.parse(output) as {
        hwnd?: number | string;
        pid?: number;
        title?: string;
        className?: string;
      };
      if (parsed.hwnd === undefined || !parsed.title) {
        return null;
      }
      const info: UiaFileDialogInfo = {
        hwnd: parsed.hwnd,
        pid: parsed.pid ?? query.rootPid ?? 0,
        title: parsed.title,
        className: parsed.className ?? "#32770",
      };
      info.mode = inferUiaDialogPickerMode(info);
      return info;
    } catch {
      return null;
    }
  }

  async completeFileDialog(
    request: UiaDialogCompleteRequest,
  ): Promise<UiaDialogCompleteResult> {
    const script = buildPowerShellUiaCompleteScript(request);
    const out = await this.runCommand(script);
    return {
      completed: out.includes("COMPLETED"),
      overwriteConfirmed: request.autoConfirmOverwrite,
    };
  }
}

export type UiaDialogStateListener = (state: ComputerPickerState) => void;

export interface UiaDialogWatcherOptions {
  /** File broker policy used to authorize staged and resolved file paths (`allow | ask | deny`). */
  fileBroker: FileBrokerPolicy;
  /** Injectable UIA dialog backend (defaults to `Win32PowerShellUiaDialogBackend`). */
  backend?: UiaDialogBackend | undefined;
  /** Root process ID of the isolated application inside the realm. */
  rootPid?: number | undefined;
  /** Optional isolated Win32 desktop name (`eta_cu_<id>`) when attached to Tier B Hidden Desktop. */
  desktopName?: string | undefined;
  /** Optional Windows session ID when attached to Tier A Child Session. */
  sessionId?: number | undefined;
  /** Poll interval in milliseconds when background polling is active (defaults to `150`). */
  pollIntervalMs?: number | undefined;
}

/**
 * Monitors top-level modal file dialogs (`#32770` Common File Dialog / `IFileOpenDialog` /
 * `IFileSaveDialog`) belonging to a realm's process tree inside an isolated Windows desktop/session.
 *
 * - **`stageFiles(paths, mode)`**: validates paths through `FileBrokerPolicy.authorizeFiles(paths, mode)`
 *   and arms the watcher (`status: "armed"`).
 * - **When a `#32770` file dialog is detected**:
 *   - If armed, immediately fills the path via `ValuePattern` + `InvokePattern` within the isolated
 *     realm (100% silent to the user's main desktop), transitions `ComputerPickerState` to
 *     `status: "intercepted_silent"`, and notifies listeners.
 *   - If not armed, transitions `ComputerPickerState` to `status: "pending_input"` with the dialog's
 *     title, detected mode (`open_single` / `save`), and filter so `resolvePicker(paths)` can
 *     authorize and complete it on demand.
 */
export class UiaDialogWatcher {
  readonly fileBroker: FileBrokerPolicy;
  readonly backend: UiaDialogBackend;

  private rootPid: number | undefined;
  private desktopName: string | undefined;
  private sessionId: number | undefined;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private closed = false;

  private armedPaths: string[] = [];
  private armedMode: FileBrokerMode = "read";
  private pendingDialog: UiaFileDialogInfo | null = null;
  private pickerState: ComputerPickerState = {
    status: "idle",
    files: [],
    updatedAt: Date.now(),
  };
  private readonly listeners = new Set<UiaDialogStateListener>();

  constructor(options: UiaDialogWatcherOptions) {
    this.fileBroker = options.fileBroker;
    this.backend = options.backend ?? new Win32PowerShellUiaDialogBackend();
    this.rootPid = options.rootPid;
    this.desktopName = options.desktopName;
    this.sessionId = options.sessionId;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
  }

  /** Current immutable snapshot of the realm's file picker state. */
  get state(): ComputerPickerState {
    return {
      ...this.pickerState,
      files: [...this.pickerState.files],
      ...(this.pickerState.accept
        ? { accept: [...this.pickerState.accept] }
        : {}),
    };
  }

  /** Currently pending un-armed dialog awaiting `resolvePicker(paths)`, if any. */
  get activePendingDialog(): UiaFileDialogInfo | null {
    return this.pendingDialog ? { ...this.pendingDialog } : null;
  }

  /** Update the target process context (PID, desktop name, or child session ID). */
  setProcessContext(ctx: {
    rootPid?: number | undefined;
    desktopName?: string | undefined;
    sessionId?: number | undefined;
  }): void {
    if (ctx.rootPid !== undefined) {
      this.rootPid = ctx.rootPid;
    }
    if (ctx.desktopName !== undefined) {
      this.desktopName = ctx.desktopName;
    }
    if (ctx.sessionId !== undefined) {
      this.sessionId = ctx.sessionId;
    }
  }

  /** Subscribe to `ComputerPickerState` transitions (`armed`, `intercepted_silent`, `pending_input`, `denied`). */
  onStateChange(listener: UiaDialogStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Authorize `paths` through `FileBrokerPolicy.authorizeFiles(paths, mode)` and arm the watcher.
   *
   * If any path is denied (e.g. `~/.eta/secret.key`), transitions state to `status: "denied"`,
   * notifies listeners, and rethrows `FileBrokerError` before touching any dialog.
   */
  async stageFiles(
    paths: readonly string[],
    mode: FileBrokerMode = "read",
  ): Promise<ComputerPickerState> {
    this.assertNotClosed();
    if (paths.length === 0) {
      this.armedPaths = [];
      this.updateState({
        status: "idle",
        files: [],
        updatedAt: Date.now(),
      });
      return this.state;
    }

    try {
      const auth = await this.fileBroker.authorizeFiles(paths, mode);
      this.armedPaths = [...auth.allowed];
      this.armedMode = mode;

      const pickerMode: ComputerPickerMode =
        mode === "write"
          ? "save"
          : auth.allowed.length > 1
            ? "open_multiple"
            : "open_single";

      this.updateState({
        status: "armed",
        mode: pickerMode,
        files: [...auth.allowed],
        updatedAt: Date.now(),
      });

      // If a dialog was already waiting in pending_input, complete it immediately!
      if (this.pendingDialog) {
        const dialog = this.pendingDialog;
        this.pendingDialog = null;
        await this.injectAndConfirmDialog(dialog, this.armedPaths, mode);
      }

      return this.state;
    } catch (err) {
      if (err instanceof FileBrokerError) {
        this.armedPaths = [];
        this.updateState({
          status: "denied",
          files: [],
          reason: err.message,
          updatedAt: Date.now(),
        });
      }
      throw err;
    }
  }

  /**
   * Resolve a pending (`status: "pending_input"`) or active modal file dialog with `paths`.
   *
   * Validates `paths` through `FileBrokerPolicy.authorizeFiles(paths, mode)` using the pending
   * dialog's mode (`"write"` for `"save"`, `"read"` otherwise) before touching the dialog.
   */
  async resolvePicker(
    paths: readonly string[],
    explicitMode?: FileBrokerMode,
  ): Promise<ComputerPickerState> {
    this.assertNotClosed();
    if (paths.length === 0) {
      throw new FileBrokerError(
        "file_broker_invalid_path",
        "resolvePicker requires at least one file path",
      );
    }

    // Check if there is a pending dialog or poll once to discover one
    let dialog = this.pendingDialog;
    if (!dialog) {
      dialog = await this.backend.findModalFileDialog({
        rootPid: this.rootPid,
        desktopName: this.desktopName,
        sessionId: this.sessionId,
      });
    }

    const detectedPickerMode = dialog
      ? inferUiaDialogPickerMode(dialog)
      : (this.pickerState.mode ?? "open_single");
    const brokerMode: FileBrokerMode =
      explicitMode ?? (detectedPickerMode === "save" ? "write" : "read");

    let authorizedPaths: string[];
    try {
      const auth = await this.fileBroker.authorizeFiles(paths, brokerMode);
      authorizedPaths = auth.allowed;
    } catch (err) {
      if (err instanceof FileBrokerError) {
        this.updateState({
          status: "denied",
          mode: detectedPickerMode,
          files: [],
          ...(dialog?.title ? { title: dialog.title } : {}),
          ...(dialog?.accept ? { accept: [...dialog.accept] } : {}),
          reason: err.message,
          updatedAt: Date.now(),
        });
      }
      throw err;
    }

    if (dialog) {
      this.pendingDialog = null;
      await this.injectAndConfirmDialog(dialog, authorizedPaths, brokerMode);
      return this.state;
    }

    // No dialog currently open yet: keep the resolved files armed/intercepted
    this.armedPaths = [];
    this.updateState({
      status: "intercepted_silent",
      mode: detectedPickerMode,
      files: authorizedPaths,
      updatedAt: Date.now(),
    });
    return this.state;
  }

  /**
   * Poll the backend once for a top-level `#32770` file dialog in the realm.
   *
   * - If a dialog is found and the watcher is **armed**, silently fills the authorized path via
   *   `ValuePattern` and invokes Open/Save (`CommandId = "1"`) via `InvokePattern`, transitioning
   *   `armed -> intercepted_silent`.
   * - If a dialog is found and the watcher is **not armed**, transitions to `status: "pending_input"`
   *   with the dialog's title, detected mode (`open_single` / `save`), and accept filter.
   */
  async pollOnce(): Promise<ComputerPickerState | null> {
    if (this.closed || this.pollInFlight) {
      return null;
    }
    this.pollInFlight = true;
    try {
      const dialog = await this.backend.findModalFileDialog({
        rootPid: this.rootPid,
        desktopName: this.desktopName,
        sessionId: this.sessionId,
      });
      if (!dialog) {
        return null;
      }
      return await this.handleDetectedDialog(dialog);
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Handle a detected `#32770` file dialog directly (callable from event hooks or `pollOnce()`).
   */
  async handleDetectedDialog(
    dialog: UiaFileDialogInfo,
  ): Promise<ComputerPickerState> {
    this.assertNotClosed();
    const detectedMode = inferUiaDialogPickerMode(dialog);

    if (this.pickerState.status === "armed" && this.armedPaths.length > 0) {
      const pathsToInject = [...this.armedPaths];
      const brokerMode = this.armedMode;
      this.armedPaths = [];
      this.pendingDialog = null;
      await this.injectAndConfirmDialog(
        { ...dialog, mode: detectedMode },
        pathsToInject,
        brokerMode,
      );
      return this.state;
    }

    this.pendingDialog = { ...dialog, mode: detectedMode };
    const isSamePending =
      this.pickerState.status === "pending_input" &&
      this.pickerState.title === dialog.title &&
      this.pickerState.mode === detectedMode;

    if (!isSamePending) {
      this.updateState({
        status: "pending_input",
        mode: detectedMode,
        files: [],
        title: dialog.title,
        ...(dialog.accept ? { accept: [...dialog.accept] } : {}),
        updatedAt: Date.now(),
      });
    }

    return this.state;
  }

  /** Start background polling for modal `#32770` dialogs inside the isolated realm. */
  start(): void {
    if (this.closed || this.pollTimer !== null) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  /** Stop background polling. */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Stop polling and release listeners. */
  close(): void {
    this.closed = true;
    this.stop();
    this.armedPaths = [];
    this.pendingDialog = null;
    this.listeners.clear();
  }

  private async injectAndConfirmDialog(
    dialog: UiaFileDialogInfo,
    authorizedPaths: readonly string[],
    brokerMode: FileBrokerMode,
  ): Promise<void> {
    const detectedMode = inferUiaDialogPickerMode(dialog);
    const editAutomationId = dialog.fileNameEditAutomationId ?? "1148";
    const confirmButtonAutomationId = dialog.confirmButtonAutomationId ?? "1";
    const valueText = formatUiaDialogFileValue(authorizedPaths);

    // Ensure target parent directory exists in path validation; pass full canonical path to ValuePattern
    await this.backend.completeFileDialog({
      dialog: {
        ...dialog,
        mode: detectedMode,
        className: dialog.className ?? "#32770",
      },
      paths: authorizedPaths,
      valueText,
      editAutomationId,
      confirmButtonAutomationId,
      autoConfirmOverwrite: detectedMode === "save" || brokerMode === "write",
    });

    this.updateState({
      status: "intercepted_silent",
      mode: detectedMode,
      files: authorizedPaths.map((p) => p),
      title: dialog.title,
      ...(dialog.accept ? { accept: [...dialog.accept] } : {}),
      reason: `Silently completed ${dialog.title || "#32770"} via UIA ValuePattern (${editAutomationId}) + InvokePattern (${confirmButtonAutomationId}) for ${authorizedPaths.map((p) => path.basename(p)).join(", ")}`,
      updatedAt: Date.now(),
    });
  }

  private updateState(next: ComputerPickerState): void {
    this.pickerState = {
      ...next,
      files: [...next.files],
      ...(next.accept ? { accept: [...next.accept] } : {}),
    };
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error("UiaDialogWatcher is closed");
    }
  }
}
