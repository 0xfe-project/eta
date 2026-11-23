import type {
  ComputerFrameEvent,
  ComputerPickerState,
} from "@eta/client-contracts";
import type {
  CdpEventListener,
  CdpSendOptions,
  CdpTransport,
} from "../src/browser/cdp-pipe";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserRealmDriver,
  DEFAULT_BROWSER_VIEWPORT,
} from "../src/browser/browser-realm";
import {
  buildCdpPipeLaunchArgs,
  CdpPipeConnection,
  findLocalBrowserExecutable,
  REQUIRED_CDP_PIPE_FLAGS,
} from "../src/browser/cdp-pipe";
import { FileBrokerError, FileBrokerPolicy } from "../src/file-broker";
import { ManagedRealm } from "../src/manager";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface RecordedCdpCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | undefined;
}

class MockCdpTransport implements CdpTransport {
  readonly calls: RecordedCdpCall[] = [];
  isClosed = false;

  private readonly listeners = new Map<
    string,
    Set<CdpEventListener<Record<string, unknown>>>
  >();
  private readonly handlers = new Map<
    string,
    (
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>
  >();

  on<TParams = Record<string, unknown>>(
    event: string,
    listener: CdpEventListener<TParams>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const typed = listener as CdpEventListener<Record<string, unknown>>;
    set.add(typed);
    return () => {
      set?.delete(typed);
    };
  }

  emit(
    event: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of [...set]) {
        listener(params, sessionId);
      }
    }
  }

  setHandler(
    method: string,
    handler: (
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void {
    this.handlers.set(method, handler);
  }

  async send<TResult = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options?: CdpSendOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params, sessionId: options?.sessionId });
    const handler = this.handlers.get(method);
    if (handler) {
      const result = await handler(params, options?.sessionId);
      return result as TResult;
    }
    if (method === "Page.captureScreenshot") {
      return {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      } as TResult;
    }
    return {} as TResult;
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

describe("cdpPipeConnection & BrowserRealmDriver (T4 + T5)", () => {
  let fixtureRoot = "";
  let projectDir = "";
  let uploadsDir = "";
  let downloadDir = "";
  let homeDir = "";
  let policy: FileBrokerPolicy;

  beforeEach(() => {
    const baseTmp = path.join(PACKAGE_ROOT, ".test-fixtures");
    fs.mkdirSync(baseTmp, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(baseTmp, "browser-realm-"));
    projectDir = path.join(fixtureRoot, "project");
    uploadsDir = path.join(fixtureRoot, "uploads");
    downloadDir = path.join(fixtureRoot, "downloads");
    homeDir = path.join(fixtureRoot, "home");

    for (const dir of [projectDir, uploadsDir, downloadDir, homeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    policy = new FileBrokerPolicy({
      projectDir,
      uploadsDir,
      stagingDir: downloadDir,
      homeDir,
    });
  });

  afterEach(() => {
    if (fixtureRoot && fs.existsSync(fixtureRoot)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
    const baseTmp = path.join(PACKAGE_ROOT, ".test-fixtures");
    if (fs.existsSync(baseTmp) && fs.readdirSync(baseTmp).length === 0) {
      fs.rmdirSync(baseTmp);
    }
  });

  it("builds zero-port CDP pipe launch arguments and rejects --remote-debugging-port", () => {
    const args = buildCdpPipeLaunchArgs({
      userDataDir: projectDir,
      initialUrl: "https://example.test",
    });

    for (const flag of REQUIRED_CDP_PIPE_FLAGS) {
      expect(args).toContain(flag);
    }
    expect(args).toContain(`--user-data-dir=${projectDir}`);
    expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(
      false,
    );

    expect(() =>
      buildCdpPipeLaunchArgs({
        userDataDir: projectDir,
        extraArgs: ["--remote-debugging-port=9222"],
      }),
    ).toThrow(/prohibited/);
  });

  it("frames null-delimited JSON-RPC over fd 3 and fd 4 across fragmented chunks", async () => {
    const fd3Write = new PassThrough();
    const fd4Read = new PassThrough();

    const connection = new CdpPipeConnection({
      writeStream: fd3Write,
      readStream: fd4Read,
    });

    const receivedEvents: Array<Record<string, unknown>> = [];
    connection.on("Page.fileChooserOpened", (params) => {
      receivedEvents.push(params);
    });

    let outboundRaw = "";
    fd3Write.on("data", (chunk: Buffer) => {
      outboundRaw += chunk.toString("utf8");
      const frames = outboundRaw.split("\0");
      outboundRaw = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const req = JSON.parse(frame) as { id: number; method: string };
        if (req.method === "Browser.getVersion") {
          const eventJson = JSON.stringify({
            method: "Page.fileChooserOpened",
            params: { mode: "selectSingle", backendNodeId: 42 },
          });
          const resJson = JSON.stringify({
            id: req.id,
            result: { product: "HeadlessChrome/157.0" },
          });
          const combined = `${eventJson}\0${resJson}\0`;
          // Split across two arbitrary chunks to test streaming frame reassembly
          fd4Read.write(Buffer.from(combined.slice(0, 19), "utf8"));
          fd4Read.write(Buffer.from(combined.slice(19), "utf8"));
        }
      }
    });

    const version = await connection.send<{ product: string }>(
      "Browser.getVersion",
    );
    expect(version.product).toBe("HeadlessChrome/157.0");
    expect(receivedEvents).toEqual([
      { mode: "selectSingle", backendNodeId: 42 },
    ]);

    await connection.close();
    expect(connection.isClosed).toBe(true);
  });

  it("handles armed silent file picker (<input type='file'> and dynamic onclick input) and pending resolvePicker flow", async () => {
    const transport = new MockCdpTransport();
    const pickerHistory: ComputerPickerState[] = [];

    const sampleUploadA = path.join(uploadsDir, "invoice-a.txt");
    const sampleUploadB = path.join(uploadsDir, "dynamic-b.txt");
    const sampleUploadC = path.join(uploadsDir, "resolved-c.txt");
    fs.writeFileSync(sampleUploadA, "invoice-a-body", "utf8");
    fs.writeFileSync(sampleUploadB, "dynamic-b-body", "utf8");
    fs.writeFileSync(sampleUploadC, "resolved-c-body", "utf8");

    const uploadedInputs: Array<{
      backendNodeId: number;
      files: string[];
      filename: string;
      contents: string;
    }> = [];

    transport.setHandler("DOM.setFileInputFiles", (params) => {
      const backendNodeId = params.backendNodeId as number;
      const files = params.files as string[];
      const firstFile = files[0] ?? "";
      uploadedInputs.push({
        backendNodeId,
        files,
        filename: path.basename(firstFile),
        contents: fs.readFileSync(firstFile, "utf8"),
      });
      return {};
    });

    let clickCounter = 0;
    transport.setHandler("Input.dispatchMouseEvent", (params) => {
      if (params.type === "mouseReleased") {
        clickCounter += 1;
        if (clickCounter === 1) {
          // 1. Plain static <input type="file">
          transport.emit("Page.fileChooserOpened", {
            frameId: "main",
            mode: "selectSingle",
            backendNodeId: 101,
          });
        } else if (clickCounter === 2) {
          // 2. Dynamic onclick-created <input type="file">
          transport.emit("Page.fileChooserOpened", {
            frameId: "main",
            mode: "selectSingle",
            backendNodeId: 202,
          });
        } else if (clickCounter === 3) {
          // 3. Unarmed click -> transitions to pending_input for resolvePicker
          transport.emit("Page.fileChooserOpened", {
            frameId: "main",
            mode: "selectSingle",
            backendNodeId: 303,
          });
        }
      }
      return {};
    });

    const driver = new BrowserRealmDriver({
      transport,
      fileBroker: policy,
      downloadPath: downloadDir,
      clickSettleMs: 0,
      onPickerChange: (state) => {
        pickerHistory.push(state);
      },
    });
    const realm = new ManagedRealm(driver, { id: "realm_picker_flow" });
    driver.bindRealm(realm);

    await driver.attach();

    // Verify attach configured silent file chooser interception and silent downloads
    expect(
      transport.calls.some(
        (c) =>
          c.method === "Page.setInterceptFileChooserDialog" &&
          c.params.enabled === true,
      ),
    ).toBe(true);
    expect(
      transport.calls.some(
        (c) =>
          c.method === "Browser.setDownloadBehavior" &&
          c.params.behavior === "allowAndName" &&
          c.params.downloadPath === downloadDir,
      ),
    ).toBe(true);

    // Case 1: Armed silent picker on plain <input type="file">
    const armedA = await realm.stageFiles([sampleUploadA]);
    expect(armedA.status).toBe("armed");

    const stepResultA = await realm.act([{ kind: "click", x: 200, y: 200 }]);
    expect(stepResultA.interruptedByModalOrNavigation).toBe(true);
    expect(realm.picker.status).toBe("intercepted_silent");
    expect(uploadedInputs[0]).toEqual({
      backendNodeId: 101,
      files: [policy.resolvePath(sampleUploadA)],
      filename: "invoice-a.txt",
      contents: "invoice-a-body",
    });

    // Case 2: Armed silent picker on dynamic onclick-created <input type="file">
    await realm.stageFiles([sampleUploadB]);
    expect(realm.picker.status).toBe("armed");

    await realm.act([{ kind: "click", x: 300, y: 300 }]);
    expect(realm.picker.status).toBe("intercepted_silent");
    expect(uploadedInputs[1]).toEqual({
      backendNodeId: 202,
      files: [policy.resolvePath(sampleUploadB)],
      filename: "dynamic-b.txt",
      contents: "dynamic-b-body",
    });

    // Case 3: Unarmed click -> pending_input -> resolvePicker(paths)
    await realm.act([{ kind: "click", x: 400, y: 400 }]);
    expect(realm.picker.status).toBe("pending_input");
    expect(realm.picker.mode).toBe("open_single");
    expect(uploadedInputs).toHaveLength(2);

    const resolvedState = await realm.resolvePicker([sampleUploadC]);
    expect(resolvedState.status).toBe("intercepted_silent");
    expect(realm.picker.status).toBe("intercepted_silent");
    expect(uploadedInputs[2]).toEqual({
      backendNodeId: 303,
      files: [policy.resolvePath(sampleUploadC)],
      filename: "resolved-c.txt",
      contents: "resolved-c-body",
    });

    expect(pickerHistory.map((p) => p.status)).toContain("armed");
    expect(pickerHistory.map((p) => p.status)).toContain("pending_input");
    expect(pickerHistory.map((p) => p.status)).toContain("intercepted_silent");

    await realm.close();
  });

  it("blocks unauthorized secret.key paths via FileBrokerPolicy before DOM.setFileInputFiles is ever called", async () => {
    const transport = new MockCdpTransport();
    const etaSecretDir = path.join(homeDir, ".eta");
    fs.mkdirSync(etaSecretDir, { recursive: true });
    const secretKeyPath = path.join(etaSecretDir, "secret.key");
    fs.writeFileSync(secretKeyPath, "private-eta-secret-key", "utf8");

    const projectSecretKey = path.join(projectDir, "secret.key");
    fs.writeFileSync(projectSecretKey, "disguised-secret-key", "utf8");

    const driver = new BrowserRealmDriver({
      transport,
      fileBroker: policy,
      downloadPath: downloadDir,
      clickSettleMs: 0,
    });
    await driver.attach();

    // 1. stageFiles rejects secret.key and transitions picker to denied
    await expect(driver.stageFiles([secretKeyPath])).rejects.toThrowError(
      FileBrokerError,
    );
    expect(driver.pickerState().status).toBe("denied");

    // 2. Open an unarmed chooser (pending_input) and attempt resolvePicker with secret.key
    transport.emit("Page.fileChooserOpened", {
      frameId: "main",
      mode: "selectSingle",
      backendNodeId: 777,
    });
    expect(driver.pickerState().status).toBe("pending_input");

    await expect(
      driver.resolvePicker([projectSecretKey]),
    ).rejects.toMatchObject({
      code: "file_broker_denied",
    });
    expect(driver.pickerState().status).toBe("denied");

    // Verify DOM.setFileInputFiles was NEVER called
    const setFilesCalls = transport.calls.filter(
      (c) => c.method === "DOM.setFileInputFiles",
    );
    expect(setFilesCalls).toHaveLength(0);

    await driver.close();
  });

  it("copies and pastes via isolated VirtualClipboard without touching the host OS clipboard", async () => {
    const transport = new MockCdpTransport();
    let simulatedDomInputValue = "initial-dom-selection";

    transport.setHandler("Runtime.evaluate", (params) => {
      const expr = String(params.expression ?? "");
      if (expr.includes("window.getSelection")) {
        return {
          result: { value: simulatedDomInputValue },
        };
      }
      if (expr.includes("dispatchEvent")) {
        const match = /\}\)\((.+)\)$/.exec(expr.trim());
        if (match?.[1]) {
          simulatedDomInputValue = JSON.parse(match[1]) as string;
        }
        return {
          result: { value: simulatedDomInputValue },
        };
      }
      return {
        result: {
          value: { title: "Clipboard Page", url: "https://clip.test" },
        },
      };
    });

    const driver = new BrowserRealmDriver({
      transport,
      fileBroker: policy,
      downloadPath: downloadDir,
      clickSettleMs: 0,
    });
    const realm = new ManagedRealm(driver, { id: "realm_clipboard" });
    driver.bindRealm(realm);

    // 1. Copy from DOM into realm.clipboard using Control+c
    await realm.act([{ kind: "key", key: "Control+c" }]);
    expect(realm.clipboard.readText()).toBe("initial-dom-selection");

    // 2. Mutate realm.clipboard directly and paste into DOM using Control+v
    realm.clipboard.writeText("isolated-paste-payload-42");
    await realm.act([{ kind: "key", key: "Control+v" }]);
    expect(simulatedDomInputValue).toBe("isolated-paste-payload-42");

    // Ensure no native keyDown/keyUp was sent for Control+c / Control+v
    const keyEvents = transport.calls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(0);

    await realm.close();
  });

  it("emits 0 frames when unwatched and emits clean frames when watched (warm-on-subscribe)", async () => {
    const transport = new MockCdpTransport();
    const frames: ComputerFrameEvent[] = [];

    const driver = new BrowserRealmDriver({
      transport,
      fileBroker: policy,
      downloadPath: downloadDir,
      screencastFps: 6,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });
    const realm = new ManagedRealm(driver, { id: "realm_screencast" });
    driver.bindRealm(realm);

    await driver.attach();

    // Wait 120ms while unwatched -> 0 frames captured or emitted
    await new Promise((r) => setTimeout(r, 120));
    expect(frames).toHaveLength(0);
    expect(
      transport.calls.filter((c) => c.method === "Page.captureScreenshot"),
    ).toHaveLength(0);

    // Subscribe a watcher -> warm-on-subscribe starts screencast and emits frames
    const unsub = realm.watch(() => {});
    await new Promise((r) => setTimeout(r, 220));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(
      transport.calls.some((c) => c.method === "Page.startScreencast"),
    ).toBe(true);

    // Unsubscribe -> stops screencast and emits 0 additional frames afterwards
    unsub();
    const countAfterUnsub = frames.length;
    await new Promise((r) => setTimeout(r, 220));
    expect(frames.length).toBe(countAfterUnsub);
    expect(
      transport.calls.some((c) => c.method === "Page.stopScreencast"),
    ).toBe(true);

    await realm.close();
  });

  it("passes resolved GroundCascade CropBox clip rectangle to Page.captureScreenshot", async () => {
    const transport = new MockCdpTransport();
    const driver = new BrowserRealmDriver({
      transport,
      viewport: { width: 1280, height: 800, scaleFactor: 1 },
      fileBroker: policy,
      downloadPath: downloadDir,
    });
    await driver.attach();

    const observation = await driver.observe({
      crop: {
        x: 250,
        y: 500,
        width: 500,
        height: 250,
        unit: "normalized",
      },
      format: "png",
    });

    expect(observation.cropRect).toEqual({
      x: 320,
      y: 400,
      width: 640,
      height: 200,
    });

    const captureCall = transport.calls.find(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(captureCall?.params).toEqual({
      format: "png",
      fromSurface: true,
      clip: {
        x: 320,
        y: 400,
        width: 640,
        height: 200,
        scale: 1,
      },
    });
    expect(observation.viewport).toEqual(DEFAULT_BROWSER_VIEWPORT);

    await driver.close();
  });

  const localBrowserBinary = findLocalBrowserExecutable();

  it.skipIf(!localBrowserBinary)(
    "runs end-to-end headless Chromium over zero-port --remote-debugging-pipe (click, type, silent file upload, clipboard, clean shutdown)",
    async () => {
      const profileBaseDir = path.join(fixtureRoot, "profiles");
      const sampleFile = path.join(uploadsDir, "e2e-upload.txt");
      fs.writeFileSync(sampleFile, "e2e-silent-upload-verified", "utf8");

      const driver = await BrowserRealmDriver.launch({
        executablePath: localBrowserBinary,
        profileBaseDir,
        downloadPath: downloadDir,
        fileBroker: policy,
        viewport: { width: 1280, height: 800, scaleFactor: 1 },
      });

      const connection = driver.transport as CdpPipeConnection;
      const profileDir = connection.userDataDir;
      expect(profileDir).toBeDefined();
      expect(fs.existsSync(profileDir!)).toBe(true);

      const realm = new ManagedRealm(driver, { id: "realm_e2e_pipe" });
      driver.bindRealm(realm);

      const html = `<!doctype html>
<html>
<head><title>ETA CDP Pipe E2E</title></head>
<body style="margin:0;padding:0">
  <input id="textInput" type="text" value="" style="position:fixed;left:20px;top:20px;width:240px;height:40px" />
  <input id="staticFile" type="file" style="position:fixed;left:20px;top:100px;width:240px;height:50px"
    onchange="this.files[0].text().then(t => { window.__staticUploaded = this.files[0].name + ':' + t; })" />
  <button id="dynFileBtn" style="position:fixed;left:20px;top:180px;width:240px;height:50px"
    onclick="const inp = document.createElement('input'); inp.type = 'file'; inp.onchange = () => inp.files[0].text().then(t => { window.__dynUploaded = inp.files[0].name + ':' + t; }); inp.click();">
    Dynamic Upload
  </button>
</body>
</html>`;

      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      const nav = await driver.navigate(dataUrl);
      expect(nav.title).toBe("ETA CDP Pipe E2E");
      expect(driver.title()).toBe("ETA CDP Pipe E2E");

      // 1. Click text input at pixel (80, 40) and type text, then copy & paste via VirtualClipboard
      await realm.act([
        { kind: "click", x: 80, y: 40, unit: "pixel" },
        { kind: "type", text: "hello-cdp" },
        { kind: "key", key: "Control+c" },
      ]);
      expect(realm.clipboard.readText()).toBe("hello-cdp");

      realm.clipboard.writeText("-pasted");
      await realm.act([{ kind: "key", key: "Control+v" }]);

      // 2. Armed silent file upload on static <input type="file"> at pixel (80, 125)
      await realm.stageFiles([sampleFile]);
      expect(realm.picker.status).toBe("armed");
      await realm.act([{ kind: "click", x: 80, y: 125, unit: "pixel" }]);
      expect(realm.picker.status).toBe("intercepted_silent");

      // 3. Armed silent file upload on dynamic onclick-created <input type="file"> at pixel (80, 205)
      await realm.stageFiles([sampleFile]);
      expect(realm.picker.status).toBe("armed");
      await realm.act([{ kind: "click", x: 80, y: 205, unit: "pixel" }]);
      expect(realm.picker.status).toBe("intercepted_silent");

      // Wait briefly for File.text() promises inside the page to settle
      await new Promise((r) => setTimeout(r, 100));

      const pageState = await driver.transport.send<{
        result?: {
          value?: {
            textValue: string;
            staticUploaded: string;
            dynUploaded: string;
          };
        };
      }>(
        "Runtime.evaluate",
        {
          expression: `({
            textValue: document.getElementById("textInput").value,
            staticUploaded: window.__staticUploaded || "",
            dynUploaded: window.__dynUploaded || ""
          })`,
          returnByValue: true,
        },
        { sessionId: (driver as unknown as { sessionId?: string }).sessionId },
      );

      expect(pageState.result?.value).toEqual({
        textValue: "hello-cdp-pasted",
        staticUploaded: "e2e-upload.txt:e2e-silent-upload-verified",
        dynUploaded: "e2e-upload.txt:e2e-silent-upload-verified",
      });

      // 4. Clean screenshot observation (full + cropped)
      const fullShot = await realm.observe();
      expect(fullShot.mimeType).toBe("image/png");
      expect(fullShot.data.length).toBeGreaterThan(100);

      const croppedShot = await realm.observe({
        crop: { x: 0, y: 0, width: 500, height: 500, unit: "normalized" },
      });
      expect(croppedShot.cropRect).toEqual({
        x: 0,
        y: 0,
        width: 640,
        height: 400,
      });
      expect(croppedShot.data.length).toBeGreaterThan(100);

      // 5. Clean teardown removes isolated userDataDir and exits browser process
      await realm.close();
      expect(connection.isClosed).toBe(true);
      expect(fs.existsSync(profileDir!)).toBe(false);
    },
    25_000,
  );
});
