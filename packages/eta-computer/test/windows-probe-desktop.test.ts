import type { ViewportSize } from "@eta/client-contracts";
import type {
  HiddenDesktopBackend,
  HiddenDesktopDispatchedMessage,
  HiddenDesktopFrameCapture,
} from "../src/windows/hidden-desktop";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ManagedRealm } from "../src/manager";
import {
  createPaintedPngBuffer,
  createSolidPngBuffer,
  decodeImageToRgba,
  HiddenDesktopDriver,
  HiddenDesktopError,
} from "../src/windows/hidden-desktop";
import {
  checkProcessTargetAllowed,
  probeWindowsCapabilities,
  SENSITIVE_PROCESS_DENYLIST,
} from "../src/windows/probe";

interface MockHiddenDesktopHarness {
  backend: HiddenDesktopBackend;
  launchedRequests: Array<{ desktopName: string; target: string }>;
  dispatchedMessages: HiddenDesktopDispatchedMessage[];
  setNextFrame: (frame: HiddenDesktopFrameCapture) => void;
  isClosed: () => boolean;
}

function createMockHiddenDesktopHarness(
  viewport: ViewportSize = { width: 200, height: 100, scaleFactor: 1 },
): MockHiddenDesktopHarness {
  const launchedRequests: Array<{ desktopName: string; target: string }> = [];
  const dispatchedMessages: HiddenDesktopDispatchedMessage[] = [];
  let closed = false;
  // Not one flat colour: a blank-frame check reads a uniform surface as "no picture".
  let nextFrame: HiddenDesktopFrameCapture = {
    buffer: createPaintedPngBuffer(viewport.width, viewport.height),
    mimeType: "image/png",
    viewport,
  };

  const backend: HiddenDesktopBackend = {
    launch: async (req) => {
      launchedRequests.push({
        desktopName: req.desktopName,
        target: req.target,
      });
      return {
        desktopName: req.desktopName,
        pid: 4242,
        title: () => req.title ?? req.target,
        viewport: () => viewport,
        captureFrame: async () => nextFrame,
        dispatchMessage: async (msg) => {
          dispatchedMessages.push(msg);
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };

  return {
    backend,
    launchedRequests,
    dispatchedMessages,
    setNextFrame: (frame) => {
      nextFrame = frame;
    },
    isClosed: () => closed,
  };
}

describe("windows Capability Probe & Sensitive Process Denylist (T6)", () => {
  it("reports windowsChildSession: 'unsupported_edition' and windowsHiddenDesktop: 'ready' on Windows Home (Edition: Core)", () => {
    const result = probeWindowsCapabilities({
      machineId: "win-home-26300",
      platform: "win32",
      queryRegistryEdition: () => "Core",
      queryChildSessionsEnabled: () => false,
      isServiceSession: () => false,
      findBrowserExecutable: () =>
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    });

    expect(result.machineId).toBe("win-home-26300");
    expect(result.os).toBe("win32");
    expect(result.edition).toBe("Core");
    expect(result.windowsChildSession).toBe("unsupported_edition");
    expect(result.windowsHiddenDesktop).toBe("ready");
    expect(result.browser).toBe("ready");
    expect(result.diagnostics).toContain(
      "windows_home_edition_no_child_session",
    );
    expect(result.diagnostics).toContain("windows_hidden_desktop_ready");
  });

  it("reports windowsChildSession: 'ready' on Windows Pro when WTSIsChildSessionsEnabled is true, and 'disabled' when false", () => {
    const readyPro = probeWindowsCapabilities({
      machineId: "win-pro-ready",
      platform: "win32",
      queryRegistryEdition: () => "Professional",
      queryChildSessionsEnabled: () => true,
      isServiceSession: () => false,
      findBrowserExecutable: () =>
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });

    expect(readyPro.windowsChildSession).toBe("ready");
    expect(readyPro.windowsHiddenDesktop).toBe("ready");
    expect(readyPro.diagnostics).toContain("windows_child_session_ready");

    const disabledPro = probeWindowsCapabilities({
      machineId: "win-pro-disabled",
      platform: "win32",
      queryRegistryEdition: () => "Enterprise",
      queryChildSessionsEnabled: () => false,
      isServiceSession: () => false,
      findBrowserExecutable: () => undefined,
    });

    expect(disabledPro.windowsChildSession).toBe("disabled");
    expect(disabledPro.windowsHiddenDesktop).toBe("ready");
    expect(disabledPro.browser).toBe("missing_binary");
    expect(disabledPro.diagnostics).toContain("windows_child_session_disabled");
    expect(disabledPro.diagnostics).toContain("browser_missing_binary");
  });

  it("detects Session 0 service sessions and non-Windows platforms", () => {
    const service0 = probeWindowsCapabilities({
      platform: "win32",
      queryRegistryEdition: () => "ServerStandard",
      isServiceSession: () => true,
      findBrowserExecutable: () => undefined,
    });
    expect(service0.windowsChildSession).toBe("service_session");
    expect(service0.windowsHiddenDesktop).toBe("service_session");
    expect(service0.diagnostics).toContain("windows_service_session_0");

    const mac = probeWindowsCapabilities({
      platform: "darwin",
      findBrowserExecutable: () =>
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    expect(mac.windowsChildSession).toBe("unsupported_os");
    expect(mac.windowsHiddenDesktop).toBe("unsupported_os");
    expect(mac.browser).toBe("ready");
  });

  it("blocks WeChat.exe, weixin.exe, consent.exe, and 1Password.exe with sensitive_target_blocked", () => {
    expect(SENSITIVE_PROCESS_DENYLIST).toContain("wechat.exe");
    expect(SENSITIVE_PROCESS_DENYLIST).toContain("1password.exe");

    for (const blockedTarget of [
      "WeChat.exe",
      "C:\\Program Files\\Tencent\\Weixin\\weixin.exe",
      "consent.exe",
      "1Password.exe",
      "com.tencent.mm",
      "Bitwarden.exe",
      "lsass.exe",
    ]) {
      const check = checkProcessTargetAllowed(blockedTarget);
      expect(check.allowed).toBe(false);
      if (!check.allowed) {
        expect(check.code).toBe("sensitive_target_blocked");
        expect(check.target).toBe(blockedTarget);
      }

      expect(
        () => new HiddenDesktopDriver({ target: blockedTarget }),
      ).toThrowError(HiddenDesktopError);
    }

    const allowedCheck = checkProcessTargetAllowed("notepad.exe");
    expect(allowedCheck).toEqual({
      allowed: true,
      target: "notepad.exe",
    });
  });
});

describe("hiddenDesktopDriver (Tier B Windows Isolation)", () => {
  it("executes lifecycle, click/type/key steps, and isolates copy/paste inside VirtualClipboard with 0 host clipboard calls", async () => {
    const harness = createMockHiddenDesktopHarness({
      width: 1000,
      height: 500,
    });
    const driver = new HiddenDesktopDriver({
      id: "home_notepad",
      target: "notepad.exe",
      title: "Untitled - Notepad",
      viewport: { width: 1000, height: 500 },
      backend: harness.backend,
    });

    const realm = new ManagedRealm(driver, { id: "realm_hidden_notepad" });
    expect(realm.view().tier).toBe("hidden_desktop");
    expect(realm.view().kind).toBe("app");
    expect(driver.desktopName).toBe("eta_cu_home_notepad");

    const actResult = await realm.act([
      { kind: "click", x: 500, y: 500 },
      { kind: "type", text: "isolated-hidden-desktop-secret", submit: true },
      { kind: "key", key: "Ctrl+C" },
    ]);

    expect(actResult.completedSteps).toBe(3);
    expect(actResult.aborted).toBe(false);
    expect(harness.launchedRequests).toEqual([
      { desktopName: "eta_cu_home_notepad", target: "notepad.exe" },
    ]);

    // Verify VirtualClipboard received the copied text without touching host clipboard
    expect(realm.clipboard.readText()).toBe("isolated-hidden-desktop-secret");

    // Verify Ctrl+V reads from VirtualClipboard and dispatches char_text
    realm.clipboard.writeText("pasted-from-virtual-clipboard");
    await realm.act([{ kind: "key", key: "Ctrl+V" }]);

    expect(harness.dispatchedMessages).toEqual([
      {
        type: "mouse_click",
        button: "left",
        doubleClick: false,
        x: 500,
        y: 250,
      },
      {
        type: "char_text",
        text: "isolated-hidden-desktop-secret",
        submit: true,
      },
      {
        type: "key",
        key: "Ctrl+C",
      },
      {
        type: "char_text",
        text: "pasted-from-virtual-clipboard",
        submit: false,
      },
    ]);

    await realm.close();
    expect(harness.isClosed()).toBe(true);
  });

  it("detects blank PrintWindow frames and throws black_frame_detected diagnostic error", async () => {
    const harness = createMockHiddenDesktopHarness({ width: 64, height: 64 });
    const driver = new HiddenDesktopDriver({
      id: "black_frame_test",
      target: "hwaccel-app.exe",
      viewport: { width: 64, height: 64 },
      backend: harness.backend,
    });
    const realm = new ManagedRealm(driver, { id: "realm_black_frame" });

    // Non-blank frame succeeds
    const validObs = await realm.observe();
    expect(validObs.mimeType).toBe("image/png");
    expect(validObs.viewport).toEqual({ width: 64, height: 64 });

    // All-black PNG buffer triggers black_frame_detected
    harness.setNextFrame({
      buffer: createSolidPngBuffer(64, 64, [0, 0, 0, 255]),
      mimeType: "image/png",
      viewport: { width: 64, height: 64 },
    });

    await expect(realm.observe()).rejects.toMatchObject({
      name: "HiddenDesktopError",
      code: "black_frame_detected",
    });
  });

  it("treats a flat charcoal frame as blank but leaves a flat white one observable", async () => {
    const harness = createMockHiddenDesktopHarness({ width: 64, height: 64 });
    const driver = new HiddenDesktopDriver({
      id: "flat_frame_test",
      target: "blender.exe",
      viewport: { width: 64, height: 64 },
      backend: harness.backend,
    });
    const realm = new ManagedRealm(driver, { id: "realm_flat_frame" });

    // Blender on a non-active desktop hands back #333333 rather than black.
    harness.setNextFrame({
      buffer: createSolidPngBuffer(64, 64, [51, 51, 51, 255]),
      mimeType: "image/png",
      viewport: { width: 64, height: 64 },
    });
    await expect(realm.observe()).rejects.toMatchObject({
      name: "HiddenDesktopError",
      code: "black_frame_detected",
    });

    // A blank page is empty, not unreadable.
    harness.setNextFrame({
      buffer: createSolidPngBuffer(64, 64, [255, 255, 255, 255]),
      mimeType: "image/png",
      viewport: { width: 64, height: 64 },
    });
    const white = await realm.observe();
    expect(white.mimeType).toBe("image/png");
    expect(decodeImageToRgba(Buffer.from(white.data, "base64"))?.width).toBe(
      64,
    );
  });

  it("supports GroundCascade CropBox zoomed observation on PNG buffers", async () => {
    const harness = createMockHiddenDesktopHarness({ width: 100, height: 80 });
    const driver = new HiddenDesktopDriver({
      id: "crop_test",
      target: "calc.exe",
      viewport: { width: 100, height: 80 },
      backend: harness.backend,
    });
    const realm = new ManagedRealm(driver, { id: "realm_crop_test" });

    const croppedObs = await realm.observe({
      crop: {
        x: 200,
        y: 250,
        width: 500,
        height: 500,
        unit: "normalized",
      },
    });

    expect(croppedObs.cropRect).toEqual({
      x: 20,
      y: 20,
      width: 50,
      height: 40,
    });
    expect(croppedObs.viewport.width).toBe(50);
    expect(croppedObs.viewport.height).toBe(40);

    const decoded = decodeImageToRgba(Buffer.from(croppedObs.data, "base64"));
    expect(decoded).toBeDefined();
    expect(decoded?.width).toBe(50);
    expect(decoded?.height).toBe(40);
  });

  /**
   * The real thing, on the machine that can run it: a desktop made by `CreateDesktopW`, Notepad
   * launched onto it, captured through `PrintWindow`, typed into, captured again. Nothing on the
   * user's own desktop is focused, moved or pasted.
   */
  it.skipIf(process.platform !== "win32")(
    "runs a real Notepad on a non-active desktop: real pixels, type via UI Automation or WM_CHAR, no focus stolen",
    async () => {
      const driver = new HiddenDesktopDriver({
        id: "real_hidden_desktop",
        target: "C:\\Windows\\System32\\notepad.exe",
        viewport: { width: 1280, height: 800, scaleFactor: 1 },
      });
      const realm = new ManagedRealm(driver, {
        id: "realm_real_hidden_desktop",
      });
      try {
        const before = await realm.observe({ format: "png" });
        const beforeBytes = Buffer.from(before.data, "base64");
        expect(beforeBytes.length).toBeGreaterThan(1_000);
        // A window that paints is not one flat colour.
        expect(new Set(beforeBytes.subarray(0, 4_096)).size).toBeGreaterThan(8);

        const steps = await realm.act([
          { kind: "click", x: 400, y: 200, unit: "pixel" },
          { kind: "type", text: "eta hidden desktop live" },
        ]);
        expect(steps.completedSteps).toBe(2);
        expect(steps.aborted).toBe(false);

        const after = await realm.observe({ format: "png" });
        expect(Buffer.from(after.data, "base64").length).not.toBe(
          beforeBytes.length,
        );

        // Ctrl+A -> Backspace clears the document cleanly and lets new text replace it.
        const replaceSteps = await realm.act([
          { kind: "key", key: "Control+a" },
          { kind: "key", key: "Backspace" },
          { kind: "type", text: "replaced-cleanly" },
        ]);
        expect(replaceSteps.completedSteps).toBe(3);
        expect(replaceSteps.aborted).toBe(false);
        const replaced = await realm.observe({ format: "png" });
        expect(Buffer.from(replaced.data, "base64").length).not.toBe(
          Buffer.from(after.data, "base64").length,
        );
        expect(driver.tier).toBe("hidden_desktop");
      } finally {
        await realm.close();
      }
    },
    60_000,
  );

  /**
   * Requests and replies cross two encodings before they reach a window: UTF-8 into the worker's
   * stdin, UIA out to the target, then the target's own rendering back out of the worker's stdout.
   * The stdin side is invisible to a frame comparison, so it is covered by
   * `docs/architecture/computer-use.md` ("UTF-8 on both pipes") and by the demo that types CJK text
   * into Notepad; a red frame would look the same whether the bytes arrived intact or mangled.
   */
});
