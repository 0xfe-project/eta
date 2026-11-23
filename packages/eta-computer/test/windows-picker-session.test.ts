import type { ComputerPickerState, ViewportSize } from "@eta/client-contracts";
import type {
  ChildSessionBackend,
  ChildSessionRdpConfig,
} from "../src/windows/child-session";
import type {
  HiddenDesktopBackend,
  HiddenDesktopDispatchedMessage,
} from "../src/windows/hidden-desktop";
import type {
  UiaDialogBackend,
  UiaDialogCompleteRequest,
  UiaFileDialogInfo,
} from "../src/windows/uia-dialog-watcher";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBrokerError, FileBrokerPolicy } from "../src/file-broker";
import { ManagedRealm } from "../src/manager";
import {
  ChildSessionError,
  ChildSessionHost,
  ChildSessionPool,
  enforceChildSessionRdpInvariants,
  WindowsAppRealmDriver,
} from "../src/windows/child-session";
import { createPaintedPngBuffer } from "../src/windows/hidden-desktop";
import {
  buildPowerShellUiaCompleteScript,
  UiaDialogWatcher,
  Win32PowerShellUiaDialogBackend,
} from "../src/windows/uia-dialog-watcher";

const createdDirs: string[] = [];

function createWorkspaceSandbox(): {
  rootDir: string;
  projectDir: string;
  homeDir: string;
  etaHomeDir: string;
} {
  const baseDir = path.join(process.cwd(), ".eta-test-win-picker-sandbox");
  fs.mkdirSync(baseDir, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(baseDir, "run-"));
  createdDirs.push(rootDir);

  const projectDir = path.join(rootDir, "workspace");
  const homeDir = path.join(rootDir, "home");
  const etaHomeDir = path.join(homeDir, ".eta");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(etaHomeDir, { recursive: true });
  fs.writeFileSync(
    path.join(etaHomeDir, "secret.key"),
    "TOP_SECRET_ETA_KEY",
    "utf8",
  );

  return { rootDir, projectDir, homeDir, etaHomeDir };
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const baseDir = path.join(process.cwd(), ".eta-test-win-picker-sandbox");
  if (fs.existsSync(baseDir)) {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race if any
    }
  }
});

interface MockUiaDialogHarness {
  backend: UiaDialogBackend;
  completedRequests: UiaDialogCompleteRequest[];
  mainDesktopPopupsCount: () => number;
  openModalDialog: (
    dialog: UiaFileDialogInfo,
    onSaveWriteContent?: string,
  ) => void;
}

function createMockUiaDialogHarness(): MockUiaDialogHarness {
  let activeDialog: UiaFileDialogInfo | null = null;
  let pendingFileContent: string | undefined;
  const completedRequests: UiaDialogCompleteRequest[] = [];
  const mainDesktopPopups = 0;

  const backend: UiaDialogBackend = {
    findModalFileDialog: async (query) => {
      if (!activeDialog) {
        return null;
      }
      if (query.rootPid !== undefined && activeDialog.pid !== query.rootPid) {
        return null;
      }
      return { ...activeDialog };
    },
    completeFileDialog: async (request) => {
      completedRequests.push(request);
      // Simulate the native Common Item Dialog (#32770) saving the file when ValuePattern + InvokePattern(1) execute
      if (pendingFileContent !== undefined && request.paths[0]) {
        const outPath = request.paths[0];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, pendingFileContent, "utf8");
      }
      activeDialog = null;
      pendingFileContent = undefined;
      return {
        completed: true,
        overwriteConfirmed: request.autoConfirmOverwrite,
      };
    },
  };

  return {
    backend,
    completedRequests,
    mainDesktopPopupsCount: () => mainDesktopPopups,
    openModalDialog: (dialog, onSaveWriteContent) => {
      activeDialog = { ...dialog };
      pendingFileContent = onSaveWriteContent;
    },
  };
}

function createMockHiddenDesktopBackend(
  pid = 4242,
  viewport: ViewportSize = { width: 1280, height: 720, scaleFactor: 1 },
): {
  backend: HiddenDesktopBackend;
  dispatched: HiddenDesktopDispatchedMessage[];
} {
  const dispatched: HiddenDesktopDispatchedMessage[] = [];
  const frameBuffer = createPaintedPngBuffer(64, 64);

  const backend: HiddenDesktopBackend = {
    launch: async (req) => ({
      desktopName: req.desktopName,
      pid,
      title: () => req.title ?? req.target,
      viewport: () => viewport,
      captureFrame: async () => ({
        buffer: frameBuffer,
        mimeType: "image/png",
        viewport,
      }),
      dispatchMessage: async (msg) => {
        dispatched.push(msg);
      },
      close: async () => {},
    }),
  };

  return { backend, dispatched };
}

function createMockChildSessionBackend(
  pid = 7788,
  viewport: ViewportSize = { width: 1280, height: 720, scaleFactor: 1 },
): {
  backend: ChildSessionBackend;
  enabledCalls: () => number;
  connectCalls: () => number;
  lastRdpConfig: () => ChildSessionRdpConfig | null;
  dispatched: HiddenDesktopDispatchedMessage[];
} {
  let enabledCount = 0;
  let connectCount = 0;
  let capturedConfig: ChildSessionRdpConfig | null = null;
  const dispatched: HiddenDesktopDispatchedMessage[] = [];
  const frameBuffer = createPaintedPngBuffer(64, 64);

  const backend: ChildSessionBackend = {
    enableChildSessions: async () => {
      enabledCount += 1;
    },
    connectLoopback: async (req) => {
      connectCount += 1;
      capturedConfig = req.rdpConfig;
      let currentTitle = "Child Session Desktop";
      return {
        childSessionId: 3,
        rdpConfig: req.rdpConfig,
        pid,
        title: () => currentTitle,
        viewport: () => viewport,
        launchTarget: async (launchReq) => {
          currentTitle = launchReq.title ?? launchReq.target;
          return { pid };
        },
        captureFrame: async () => ({
          buffer: frameBuffer,
          mimeType: "image/png",
          viewport,
        }),
        dispatchInput: async (msg) => {
          dispatched.push(msg);
        },
        close: async () => {},
      };
    },
  };

  return {
    backend,
    enabledCalls: () => enabledCount,
    connectCalls: () => connectCount,
    lastRdpConfig: () => capturedConfig,
    dispatched,
  };
}

describe("uiaDialogWatcher & FileBrokerPolicy (T7 Silent Win32 Common Item Dialog Broker)", () => {
  it("armed mode: silently fills #32770 Save As dialog via ValuePattern (1148) + InvokePattern (1), writes the file with 0 main-desktop popups, and transitions armed -> intercepted_silent", async () => {
    const sandbox = createWorkspaceSandbox();
    const policy = new FileBrokerPolicy({
      projectDir: sandbox.projectDir,
      homeDir: sandbox.homeDir,
      etaHomeDir: sandbox.etaHomeDir,
    });
    const uiaHarness = createMockUiaDialogHarness();
    const states: ComputerPickerState[] = [];

    const watcher = new UiaDialogWatcher({
      fileBroker: policy,
      backend: uiaHarness.backend,
      rootPid: 4242,
      desktopName: "eta_cu_notepad_save",
    });
    watcher.onStateChange((state) => {
      states.push(state);
    });

    const targetSavePath = path.join(
      sandbox.projectDir,
      "notes-saved-silently.txt",
    );

    // 1. Arm the watcher for write mode
    const armedState = await watcher.stageFiles([targetSavePath], "write");
    expect(armedState.status).toBe("armed");
    expect(armedState.mode).toBe("save");
    expect(armedState.files).toEqual([policy.resolvePath(targetSavePath)]);

    // 2. A #32770 Save As dialog opens inside the isolated realm for PID 4242
    uiaHarness.openModalDialog(
      {
        hwnd: "0x001204A0",
        pid: 4242,
        title: "Save As",
        className: "#32770",
        accept: ["*.txt", "*.*"],
      },
      "Hello from isolated Notepad Save As!",
    );

    // 3. Poll detects the #32770 dialog and completes it silently via ValuePattern + InvokePattern
    const completedState = await watcher.pollOnce();
    expect(completedState).not.toBeNull();
    expect(completedState?.status).toBe("intercepted_silent");
    expect(completedState?.mode).toBe("save");
    expect(completedState?.title).toBe("Save As");
    expect(completedState?.files).toEqual([policy.resolvePath(targetSavePath)]);

    // Verify ValuePattern (1148) + InvokePattern (1) + overwrite confirmation were invoked
    expect(uiaHarness.completedRequests).toHaveLength(1);
    const req = uiaHarness.completedRequests[0]!;
    expect(req.editAutomationId).toBe("1148");
    expect(req.confirmButtonAutomationId).toBe("1");
    expect(req.valueText).toBe(policy.resolvePath(targetSavePath));
    expect(req.autoConfirmOverwrite).toBe(true);
    expect(uiaHarness.mainDesktopPopupsCount()).toBe(0);

    // Verify the file was actually written to disk
    expect(fs.existsSync(targetSavePath)).toBe(true);
    expect(fs.readFileSync(targetSavePath, "utf8")).toBe(
      "Hello from isolated Notepad Save As!",
    );

    // Verify state transition history: armed -> intercepted_silent
    expect(states.map((s) => s.status)).toEqual([
      "armed",
      "intercepted_silent",
    ]);
    watcher.close();
  });

  it("un-armed mode: transitions to pending_input when a #32770 dialog opens, and completes when resolvePicker([targetPath]) is called", async () => {
    const sandbox = createWorkspaceSandbox();
    const policy = new FileBrokerPolicy({
      projectDir: sandbox.projectDir,
      homeDir: sandbox.homeDir,
      etaHomeDir: sandbox.etaHomeDir,
    });
    const uiaHarness = createMockUiaDialogHarness();
    const states: ComputerPickerState[] = [];

    const watcher = new UiaDialogWatcher({
      fileBroker: policy,
      backend: uiaHarness.backend,
      rootPid: 9001,
    });
    watcher.onStateChange((s) => states.push(s));

    const targetOpenFile = path.join(sandbox.projectDir, "input-document.txt");
    fs.writeFileSync(targetOpenFile, "document content", "utf8");

    // 1. Dialog appears while watcher is idle (un-armed)
    uiaHarness.openModalDialog({
      hwnd: "0x00440010",
      pid: 9001,
      title: "Open File",
      className: "#32770",
      accept: ["*.txt", "*.md"],
    });

    const pendingState = await watcher.pollOnce();
    expect(pendingState?.status).toBe("pending_input");
    expect(pendingState?.mode).toBe("open_single");
    expect(pendingState?.title).toBe("Open File");
    expect(pendingState?.accept).toEqual(["*.txt", "*.md"]);
    expect(uiaHarness.completedRequests).toHaveLength(0);

    // 2. Caller resolves the picker on demand with targetOpenFile
    const resolvedState = await watcher.resolvePicker([targetOpenFile]);
    expect(resolvedState.status).toBe("intercepted_silent");
    expect(resolvedState.mode).toBe("open_single");
    expect(resolvedState.files).toEqual([policy.resolvePath(targetOpenFile)]);

    expect(uiaHarness.completedRequests).toHaveLength(1);
    expect(uiaHarness.completedRequests[0]?.valueText).toBe(
      policy.resolvePath(targetOpenFile),
    );
    expect(states.map((s) => s.status)).toEqual([
      "pending_input",
      "intercepted_silent",
    ]);
    watcher.close();
  });

  it("blocks attempting to arm or resolve a denied path (~/.eta/secret.key) before touching the dialog", async () => {
    const sandbox = createWorkspaceSandbox();
    const policy = new FileBrokerPolicy({
      projectDir: sandbox.projectDir,
      homeDir: sandbox.homeDir,
      etaHomeDir: sandbox.etaHomeDir,
    });
    const uiaHarness = createMockUiaDialogHarness();

    const watcher = new UiaDialogWatcher({
      fileBroker: policy,
      backend: uiaHarness.backend,
      rootPid: 4242,
    });

    // 1. Attempting to arm ~/.eta/secret.key is blocked immediately
    await expect(
      watcher.stageFiles(["~/.eta/secret.key"], "read"),
    ).rejects.toThrowError(FileBrokerError);
    expect(watcher.state.status).toBe("denied");
    expect(uiaHarness.completedRequests).toHaveLength(0);

    // 2. Open a #32770 dialog and attempt to resolve it with ~/.eta/secret.key
    uiaHarness.openModalDialog({
      hwnd: "0x00881122",
      pid: 4242,
      title: "Open",
      className: "#32770",
    });
    await watcher.pollOnce();
    expect(watcher.state.status).toBe("pending_input");

    const explicitSecretPath = path.join(sandbox.etaHomeDir, "secret.key");
    await expect(
      watcher.resolvePicker([explicitSecretPath]),
    ).rejects.toMatchObject({
      name: "FileBrokerError",
      code: "file_broker_denied",
    });

    // Dialog was NEVER touched or completed
    expect(uiaHarness.completedRequests).toHaveLength(0);
    expect(watcher.state.status).toBe("denied");
    watcher.close();
  });

  it("generates PowerShell UIA script using ValuePattern (1148 / FileNameControlHost) and InvokePattern (CommandId 1)", async () => {
    const executedScripts: string[] = [];
    const psBackend = new Win32PowerShellUiaDialogBackend({
      runCommand: async (script) => {
        executedScripts.push(script);
        return "COMPLETED";
      },
    });

    const request: UiaDialogCompleteRequest = {
      dialog: {
        hwnd: 123456,
        pid: 4242,
        title: "Save As",
        className: "#32770",
        mode: "save",
      },
      paths: ["C:\\workspace\\eta\\output.txt"],
      valueText: "C:\\workspace\\eta\\output.txt",
      editAutomationId: "1148",
      confirmButtonAutomationId: "1",
      autoConfirmOverwrite: true,
    };

    const script = buildPowerShellUiaCompleteScript(request);
    expect(script).toContain("System.Windows.Automation.AutomationElement");
    expect(script).toContain("1148");
    expect(script).toContain("FileNameControlHost");
    expect(script).toContain("ValuePattern");
    expect(script).toContain("InvokePattern");

    const res = await psBackend.completeFileDialog(request);
    expect(res.completed).toBe(true);
    expect(executedScripts).toHaveLength(1);
  });
});

describe("childSessionHost & WindowsAppRealmDriver (T7 Tier A Child Session + Tier B Fallback)", () => {
  it("enforces RedirectClipboard: false and ManualClipboardSyncEnabled: true as an invariant", () => {
    const validConfig = enforceChildSessionRdpInvariants();
    expect(validConfig.ConnectToChildSession).toBe(true);
    expect(validConfig.RedirectClipboard).toBe(false);
    expect(validConfig.ManualClipboardSyncEnabled).toBe(true);

    // Attempting to enable RedirectClipboard throws clipboard_sharing_violation
    expect(() =>
      enforceChildSessionRdpInvariants({ RedirectClipboard: true }),
    ).toThrowError(ChildSessionError);
    expect(
      () => new ChildSessionHost({ rdpConfig: { RedirectClipboard: true } }),
    ).toThrow(/RedirectClipboard must be false/);

    // Attempting to disable ManualClipboardSyncEnabled throws clipboard_sharing_violation
    expect(() =>
      enforceChildSessionRdpInvariants({ ManualClipboardSyncEnabled: false }),
    ).toThrowError(ChildSessionError);
    expect(
      () =>
        new ChildSessionHost({
          rdpConfig: { ManualClipboardSyncEnabled: false },
        }),
    ).toThrow(/ManualClipboardSyncEnabled must be true/);
  });

  it("serializes concurrent child-session leases (1 active connected child session per machine at a time) and reuses the warm session", async () => {
    const csHarness = createMockChildSessionBackend(5500);
    const pool = new ChildSessionPool();
    const host = new ChildSessionHost({
      backend: csHarness.backend,
      pool,
    });

    const events: string[] = [];

    // Acquire Lease 1
    const lease1 = await host.acquireSession({
      target: "notepad.exe",
      title: "Lease 1 - Notepad",
    });
    events.push("lease1:acquired");
    expect(pool.hasActiveLease).toBe(true);
    expect(lease1.reusedWarmSession).toBe(false);
    expect(lease1.rdpConfig.RedirectClipboard).toBe(false);
    expect(lease1.rdpConfig.ManualClipboardSyncEnabled).toBe(true);

    // Start Lease 2 and Lease 3 concurrently while Lease 1 is active
    const lease2Promise = host
      .acquireSession({
        target: "calc.exe",
        title: "Lease 2 - Calculator",
      })
      .then((lease) => {
        events.push("lease2:acquired");
        return lease;
      });

    const lease3Promise = host
      .acquireSession({
        target: "mspaint.exe",
        title: "Lease 3 - Paint",
      })
      .then((lease) => {
        events.push("lease3:acquired");
        return lease;
      });

    // Give microtasks a tick to confirm lease2 and lease3 are queued behind lease1
    await new Promise((r) => setTimeout(r, 15));
    expect(pool.pendingCount).toBe(2);
    expect(events).toEqual(["lease1:acquired"]);

    // Release Lease 1 -> Lease 2 should acquire immediately and reuse the warm session
    events.push("lease1:releasing");
    await lease1.release();

    const lease2 = await lease2Promise;
    expect(lease2.reusedWarmSession).toBe(true);
    expect(pool.pendingCount).toBe(1);
    expect(events).toEqual([
      "lease1:acquired",
      "lease1:releasing",
      "lease2:acquired",
    ]);

    // Release Lease 2 -> Lease 3 should acquire immediately and reuse the warm session
    events.push("lease2:releasing");
    await lease2.release();

    const lease3 = await lease3Promise;
    expect(lease3.reusedWarmSession).toBe(true);
    expect(pool.pendingCount).toBe(0);
    expect(events).toEqual([
      "lease1:acquired",
      "lease1:releasing",
      "lease2:acquired",
      "lease2:releasing",
      "lease3:acquired",
    ]);

    await lease3.release();
    expect(pool.hasActiveLease).toBe(false);
    expect(pool.warmReuseCount).toBe(2);
    // WTSEnableChildSessions + loopback connect only ran once across all 3 serialized leases
    expect(csHarness.enabledCalls()).toBe(1);
    expect(csHarness.connectCalls()).toBe(1);

    await host.shutdown();
  });

  it("automatically falls back to Tier B (hidden_desktop) on Windows Home (Core) and attaches UiaDialogWatcher so stageFiles and resolvePicker work seamlessly", async () => {
    const sandbox = createWorkspaceSandbox();
    const policy = new FileBrokerPolicy({
      projectDir: sandbox.projectDir,
      homeDir: sandbox.homeDir,
      etaHomeDir: sandbox.etaHomeDir,
    });
    const uiaHarness = createMockUiaDialogHarness();
    const hiddenHarness = createMockHiddenDesktopBackend(4242);

    // Simulate Windows 11 Home (Edition: Core) where Child Sessions return unsupported_edition
    const homeDriver = new WindowsAppRealmDriver({
      id: "win_home_notepad",
      target: "notepad.exe",
      title: "Untitled - Notepad",
      probeOptions: {
        machineId: "win11-home-26300",
        platform: "win32",
        queryRegistryEdition: () => "Core",
        queryChildSessionsEnabled: () => false,
        isServiceSession: () => false,
      },
      hiddenDesktopBackend: hiddenHarness.backend,
      fileBroker: policy,
      uiaBackend: uiaHarness.backend,
      defaultStageMode: "write",
    });

    expect(homeDriver.tier).toBe("hidden_desktop");
    expect(homeDriver.capabilities.windowsChildSession).toBe(
      "unsupported_edition",
    );
    expect(homeDriver.capabilities.windowsHiddenDesktop).toBe("ready");

    const realm = new ManagedRealm(homeDriver, { id: "realm_win_home_app" });
    expect(realm.view().tier).toBe("hidden_desktop");

    // Stage a save target path on the realm before triggering Ctrl+S
    const saveFile = path.join(sandbox.projectDir, "home-tier-b-output.txt");
    const staged = await realm.stageFiles([saveFile]);
    expect(staged.status).toBe("armed");

    // Trigger Save As dialog (#32770) inside the isolated Hidden Desktop process
    uiaHarness.openModalDialog(
      {
        hwnd: "0x00330011",
        pid: 4242,
        title: "Save As",
        className: "#32770",
      },
      "Saved silently on Windows Home Tier B Hidden Desktop!",
    );

    await realm.act([
      {
        kind: "type",
        text: "Saved silently on Windows Home Tier B Hidden Desktop!",
      },
      { kind: "key", key: "Ctrl+S" },
    ]);

    expect(homeDriver.dialogWatcher.state.status).toBe("intercepted_silent");
    expect(fs.existsSync(saveFile)).toBe(true);
    expect(fs.readFileSync(saveFile, "utf8")).toBe(
      "Saved silently on Windows Home Tier B Hidden Desktop!",
    );

    await realm.close();
  });

  it("selects Tier A (child_session) when windowsChildSession === 'ready' and supports UiaDialogWatcher silent picker interception", async () => {
    const sandbox = createWorkspaceSandbox();
    const policy = new FileBrokerPolicy({
      projectDir: sandbox.projectDir,
      homeDir: sandbox.homeDir,
      etaHomeDir: sandbox.etaHomeDir,
    });
    const uiaHarness = createMockUiaDialogHarness();
    const csHarness = createMockChildSessionBackend(7788);

    const proDriver = new WindowsAppRealmDriver({
      id: "win_pro_notepad",
      target: "notepad.exe",
      title: "Untitled - Notepad",
      probeOptions: {
        machineId: "win11-pro",
        platform: "win32",
        queryRegistryEdition: () => "Professional",
        queryChildSessionsEnabled: () => true,
        isServiceSession: () => false,
      },
      childSessionBackend: csHarness.backend,
      fileBroker: policy,
      uiaBackend: uiaHarness.backend,
    });

    expect(proDriver.tier).toBe("child_session");
    expect(proDriver.capabilities.windowsChildSession).toBe("ready");

    const realm = new ManagedRealm(proDriver, { id: "realm_win_pro_app" });
    expect(realm.view().tier).toBe("child_session");

    const obs = await realm.observe();
    expect(obs.mimeType).toBe("image/png");
    expect(csHarness.lastRdpConfig()?.RedirectClipboard).toBe(false);
    expect(csHarness.lastRdpConfig()?.ManualClipboardSyncEnabled).toBe(true);

    // Un-armed dialog opens in Tier A Child Session -> resolvePicker completes it
    const openFile = path.join(sandbox.projectDir, "pro-child-session.txt");
    fs.writeFileSync(openFile, "pro data", "utf8");

    uiaHarness.openModalDialog({
      hwnd: "0x009900AA",
      pid: 7788,
      title: "Open",
      className: "#32770",
    });

    await realm.act([{ kind: "key", key: "Ctrl+O" }]);
    expect(proDriver.dialogWatcher.state.status).toBe("pending_input");

    const resolved = await realm.resolvePicker([openFile]);
    expect(resolved.status).toBe("intercepted_silent");
    expect(uiaHarness.completedRequests).toHaveLength(1);
    expect(uiaHarness.completedRequests[0]?.valueText).toBe(
      policy.resolvePath(openFile),
    );

    await realm.close();
  });
});
