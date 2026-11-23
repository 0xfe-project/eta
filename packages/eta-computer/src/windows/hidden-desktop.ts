import type {
  ComputerMicroAction,
  ComputerPickerState,
  ComputerUserInput,
  CropBox,
  PixelRect,
  Point2D,
  ViewportSize,
} from "@eta/client-contracts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { VirtualClipboard } from "../clipboard";
import type {
  ManagedRealm,
  RealmDriver,
  RealmObservation,
  RealmStepResult,
} from "../manager";
import type { DesktopOverlayPaths } from "./desktop-overlay";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { resolveCropRect, toViewportPixels } from "@eta/client-contracts";
import { prepareDesktopOverlay } from "./desktop-overlay";
import { HIDDEN_DESKTOP_WORKER_SCRIPT } from "./hidden-desktop-worker";
import { checkProcessTargetAllowed } from "./probe";

export type HiddenDesktopDiagnosticCode =
  | "sensitive_target_blocked"
  | "black_frame_detected"
  | "desktop_closed";

export class HiddenDesktopError extends Error {
  readonly code: HiddenDesktopDiagnosticCode;
  readonly target: string | undefined;

  constructor(
    code: HiddenDesktopDiagnosticCode,
    message: string,
    target?: string | undefined,
  ) {
    super(message);
    this.name = "HiddenDesktopError";
    this.code = code;
    this.target = target;
  }
}

export type HiddenDesktopDispatchedMessage =
  | {
      type: "mouse_move";
      x: number;
      y: number;
    }
  | {
      type: "mouse_click";
      button: "left" | "right" | "middle";
      doubleClick: boolean;
      x: number;
      y: number;
    }
  | {
      type: "mouse_drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
    }
  | {
      type: "mouse_wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      type: "char_text";
      text: string;
      submit: boolean;
    }
  | {
      type: "key";
      key: string;
    };

export interface HiddenDesktopFrameCapture {
  /** PNG or 24/32-bit BMP image bytes captured via `PrintWindow` / GDI bitmap. */
  buffer: Buffer;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | undefined;
  viewport?: ViewportSize | undefined;
  /** Optional explicit RGBA/RGB pixel samples or precomputed black-frame flag from backend. */
  isAllBlack?: boolean | undefined;
}

export interface HiddenDesktopBackendSession {
  desktopName: string;
  readonly pid?: number | undefined;
  title: () => string;
  viewport: () => ViewportSize;
  captureFrame: () => Promise<HiddenDesktopFrameCapture>;
  dispatchMessage: (message: HiddenDesktopDispatchedMessage) => Promise<void>;
  /** Bring this desktop onto the user's screen (`SwitchDesktop`). */
  switchTo?: () => Promise<void>;
  /** Hand the screen back to the desktop the user was on. */
  switchBack?: () => Promise<void>;
  /** Show the in-realm overlay (switch back + quick chat) on this desktop. */
  openOverlay?: (options: HiddenDesktopOverlayOptions) => Promise<void>;
  /** Tear the overlay down. */
  closeOverlay?: () => Promise<void>;
  /** End the launched app. Only for a user-confirmed clear: it may hold unsaved work. */
  terminateApp?: () => Promise<void>;
  close: () => Promise<void>;
}

/** Where the in-realm overlay writes chat and reads status. */
export interface HiddenDesktopOverlayOptions {
  /** Absolute path of a PowerShell script to run on the realm desktop. */
  script: string;
  chatFile: string;
  statusFile: string;
  readyFile: string;
  title: string;
}

export interface HiddenDesktopLaunchRequest {
  desktopName: string;
  target: string;
  args: readonly string[];
  viewport: ViewportSize;
  title?: string | undefined;
}

/**
 * Injectable execution backend for `HiddenDesktopDriver`.
 *
 * Allows deterministic cross-platform unit tests while providing a real Win32 / PowerShell
 * implementation (`CreateDesktopW` + `STARTUPINFOW.lpDesktop` + `PrintWindow` + `PostMessageW`)
 * on Windows hosts. Never calls `SwitchDesktop` or global `SendInput`.
 */
export interface HiddenDesktopBackend {
  launch: (
    request: HiddenDesktopLaunchRequest,
  ) => Promise<HiddenDesktopBackendSession>;
  /** Adopt a desktop and the app already running on it, instead of creating both. */
  attach?: (
    request: HiddenDesktopLaunchRequest,
  ) => Promise<HiddenDesktopBackendSession>;
}

export interface HiddenDesktopDriverOptions {
  id?: string | undefined;
  target: string;
  args?: readonly string[] | undefined;
  title?: string | undefined;
  viewport?: ViewportSize | undefined;
  extraDenylist?: readonly string[] | undefined;
  backend?: HiddenDesktopBackend | undefined;
  /**
   * Adopt this existing desktop instead of creating a new one. Used when a realm is rebuilt for an
   * app that is still running after the host that launched it went away: nothing is started and
   * nothing is ended.
   */
  attachTo?: string | undefined;
  /** Default text selected when a `Ctrl+C` shortcut is synthesized inside the realm. */
  getSelectedText?: (() => string | undefined) | undefined;
}

/* ------------------------------------------------------------------ PNG / BMP helpers & black-frame detection */

/** Wait for a file to exist, polling: the overlay signals readiness by creating one. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return existsSync(path);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGBA pixel buffer (`width * height * 4` bytes) into a valid PNG buffer.
 */
export function encodeRgbaToPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    const srcOffset = y * stride;
    Buffer.from(rgba.buffer, rgba.byteOffset + srcOffset, stride).copy(
      raw,
      rowStart + 1,
    );
  }

  const compressed = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", compressed),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Create a solid-color RGBA PNG buffer for testing or synthetic frames.
 */
export function createSolidPngBuffer(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = rgba[3];
  }
  return encodeRgbaToPng(width, height, pixels);
}

/**
 * A two-tone RGBA PNG for testing or synthetic frames. Unlike {@link createSolidPngBuffer} it is
 * not one flat colour, so {@link isBlankImageBuffer} reads it as a real picture.
 */
export function createPaintedPngBuffer(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const dark = (x + y) % 2 === 0;
      pixels[offset] = dark ? 32 : 240;
      pixels[offset + 1] = dark ? 64 : 240;
      pixels[offset + 2] = dark ? 128 : 240;
      pixels[offset + 3] = 255;
    }
  }
  return encodeRgbaToPng(width, height, pixels);
}

interface DecodedRgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode an 8-bit RGB or RGBA PNG or 24/32-bit uncompressed BMP into raw RGBA pixels.
 * Returns `undefined` if the format is unrecognized.
 */
export function decodeImageToRgba(
  buffer: Buffer,
): DecodedRgbaImage | undefined {
  // Check PNG signature
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatParts: Buffer[] = [];

    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;

      const chunkData = buffer.subarray(dataStart, dataEnd);
      if (type === "IHDR" && chunkData.length >= 13) {
        width = chunkData.readUInt32BE(0);
        height = chunkData.readUInt32BE(4);
        bitDepth = chunkData[8] ?? 0;
        colorType = chunkData[9] ?? 0;
      } else if (type === "IDAT") {
        idatParts.push(chunkData);
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }

    if (
      width <= 0 ||
      height <= 0 ||
      bitDepth !== 8 ||
      (colorType !== 6 && colorType !== 2) ||
      idatParts.length === 0
    ) {
      return undefined;
    }

    try {
      const decompressed = inflateSync(Buffer.concat(idatParts));
      const bpp = colorType === 6 ? 4 : 3;
      const stride = width * bpp;
      if (decompressed.length < (stride + 1) * height) {
        return undefined;
      }

      const unfiltered = new Uint8Array(width * height * bpp);
      for (let y = 0; y < height; y += 1) {
        const filterType = decompressed[y * (stride + 1)] ?? 0;
        const srcRowStart = y * (stride + 1) + 1;
        const dstRowStart = y * stride;

        for (let x = 0; x < stride; x += 1) {
          const rawByte = decompressed[srcRowStart + x] ?? 0;
          const left = x >= bpp ? (unfiltered[dstRowStart + x - bpp] ?? 0) : 0;
          const up = y > 0 ? (unfiltered[dstRowStart - stride + x] ?? 0) : 0;
          const upLeft =
            y > 0 && x >= bpp
              ? (unfiltered[dstRowStart - stride + x - bpp] ?? 0)
              : 0;

          let recon = rawByte;
          if (filterType === 1) {
            recon = (rawByte + left) & 0xff;
          } else if (filterType === 2) {
            recon = (rawByte + up) & 0xff;
          } else if (filterType === 3) {
            recon = (rawByte + ((left + up) >> 1)) & 0xff;
          } else if (filterType === 4) {
            recon = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
          }
          unfiltered[dstRowStart + x] = recon;
        }
      }

      if (colorType === 6) {
        return { width, height, rgba: unfiltered };
      }

      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        rgba[i * 4] = unfiltered[i * 3] ?? 0;
        rgba[i * 4 + 1] = unfiltered[i * 3 + 1] ?? 0;
        rgba[i * 4 + 2] = unfiltered[i * 3 + 2] ?? 0;
        rgba[i * 4 + 3] = 255;
      }
      return { width, height, rgba };
    } catch {
      return undefined;
    }
  }

  // Check uncompressed 24/32-bit BMP ('BM')
  if (buffer.length >= 54 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const pixelOffset = buffer.readUInt32LE(10);
    const width = buffer.readInt32LE(18);
    const rawHeight = buffer.readInt32LE(22);
    const bpp = buffer.readUInt16LE(28);
    const compression = buffer.readUInt32LE(30);
    const height = Math.abs(rawHeight);
    const topDown = rawHeight < 0;

    if (
      width <= 0 ||
      height <= 0 ||
      (bpp !== 24 && bpp !== 32) ||
      compression !== 0
    ) {
      return undefined;
    }

    const bytesPerPixel = bpp / 8;
    const rowStride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
    if (pixelOffset + rowStride * height > buffer.length) {
      return undefined;
    }

    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const srcY = topDown ? y : height - 1 - y;
      const srcRow = pixelOffset + srcY * rowStride;
      for (let x = 0; x < width; x += 1) {
        const srcIdx = srcRow + x * bytesPerPixel;
        const dstIdx = (y * width + x) * 4;
        rgba[dstIdx] = buffer[srcIdx + 2] ?? 0; // R
        rgba[dstIdx + 1] = buffer[srcIdx + 1] ?? 0; // G
        rgba[dstIdx + 2] = buffer[srcIdx] ?? 0; // B
        rgba[dstIdx + 3] =
          bytesPerPixel === 4 ? (buffer[srcIdx + 3] ?? 255) : 255;
      }
    }
    return { width, height, rgba };
  }

  return undefined;
}

/** How far one channel may drift from the frame's first pixel and still count as the same shade. */
const FLAT_CHANNEL_TOLERANCE = 3;
/** Pixels allowed to differ before a frame stops being "one flat colour" (0.1% of the surface). */
const FLAT_DIFFERING_RATIO = 0.001;
/** Above this luminance a flat frame is a genuinely light surface (a blank page), not a dead one. */
const DEAD_FRAME_LUMINANCE = 150;

/**
 * Returns `true` for a frame with no picture in it: one flat, dark colour across the whole
 * surface. `PrintWindow` answers exactly that for a DirectX / Vulkan / GPU-composited window on a
 * non-active desktop, and the colour is not always black — Blender, for one, hands back charcoal
 * `#333333`, which a black-only check would pass on to the agent as a real screenshot.
 *
 * A flat light surface is left alone: a blank white page is an empty but real observation.
 */
export function isBlankImageBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const decoded = decodeImageToRgba(buffer);
  if (!decoded) return false;
  const { rgba } = decoded;
  const red = rgba[0] ?? 0;
  const green = rgba[1] ?? 0;
  const blue = rgba[2] ?? 0;
  const allowed = (rgba.length / 4) * FLAT_DIFFERING_RATIO;
  let differing = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs((rgba[i] ?? 0) - red) > FLAT_CHANNEL_TOLERANCE ||
      Math.abs((rgba[i + 1] ?? 0) - green) > FLAT_CHANNEL_TOLERANCE ||
      Math.abs((rgba[i + 2] ?? 0) - blue) > FLAT_CHANNEL_TOLERANCE
    ) {
      differing += 1;
      if (differing > allowed) return false;
    }
  }
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance < DEAD_FRAME_LUMINANCE;
}

/**
 * Crop a PNG/BMP buffer to `rect` (`PixelRect`) and return a PNG buffer of dimensions
 * `rect.width x rect.height`.
 */
export function cropImageBufferToPng(buffer: Buffer, rect: PixelRect): Buffer {
  const decoded = decodeImageToRgba(buffer);
  if (!decoded) {
    return buffer;
  }
  const cropX = Math.max(0, Math.min(decoded.width - 1, rect.x));
  const cropY = Math.max(0, Math.min(decoded.height - 1, rect.y));
  const cropW = Math.max(1, Math.min(decoded.width - cropX, rect.width));
  const cropH = Math.max(1, Math.min(decoded.height - cropY, rect.height));

  const cropped = new Uint8Array(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const srcRowOffset = ((cropY + y) * decoded.width + cropX) * 4;
    const dstRowOffset = y * cropW * 4;
    cropped.set(
      decoded.rgba.subarray(srcRowOffset, srcRowOffset + cropW * 4),
      dstRowOffset,
    );
  }
  return encodeRgbaToPng(cropW, cropH, cropped);
}

/* ------------------------------------------------------------------ Win32 backend */

interface WorkerReply {
  ok?: boolean | undefined;
  error?: string | undefined;
  code?: number | undefined;
  message?: string | undefined;
  pid?: number | undefined;
  hwnd?: number | undefined;
  className?: string | undefined;
  title?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  base64?: string | undefined;
  painted?: boolean | undefined;
  how?: string | undefined;
  vk?: number | undefined;
}

/**
 * The real Windows execution backend: one PowerShell worker per realm, holding the created
 * desktop and the target's window.
 *
 * Verified on this machine (Windows 11 Home, build 26300): a Notepad launched onto a desktop made
 * by `CreateDesktopW` renders into `PrintWindow` with its real pixels, and its editor answers UI
 * Automation's `ValuePattern`. Nothing is switched, focused or pasted: the user's desktop never
 * sees the window, and the OS clipboard is not touched.
 */
export class Win32PowerShellHiddenDesktopBackend
  implements HiddenDesktopBackend
{
  async launch(
    request: HiddenDesktopLaunchRequest,
  ): Promise<HiddenDesktopBackendSession> {
    return await this.#open(request, "launch");
  }

  /** Adopt an existing desktop whose app is still running (after a host restart, say). */
  async attach(
    request: HiddenDesktopLaunchRequest,
  ): Promise<HiddenDesktopBackendSession> {
    return await this.#open(request, "attach");
  }

  async #open(
    request: HiddenDesktopLaunchRequest,
    mode: "launch" | "attach",
  ): Promise<HiddenDesktopBackendSession> {
    const check = checkProcessTargetAllowed(request.target);
    if (!check.allowed) {
      throw new HiddenDesktopError(
        check.code,
        `Target "${request.target}" is blocked by the sensitive process denylist (${check.matchedEntry})`,
        request.target,
      );
    }

    const worker = new HiddenDesktopWorker();
    let currentTitle = request.title ?? request.target;
    const currentViewport: ViewportSize = { ...request.viewport };
    let closed = false;

    const launched = await worker.call(
      mode === "launch"
        ? {
            cmd: "launch",
            desktop: request.desktopName,
            target: request.target,
            args: [...request.args],
            width: currentViewport.width,
            height: currentViewport.height,
          }
        : {
            cmd: "attach",
            desktop: request.desktopName,
            width: currentViewport.width,
            height: currentViewport.height,
          },
    );
    if (launched.ok !== true) {
      await worker.close();
      throw new HiddenDesktopError(
        launched.error === "window_not_found"
          ? "black_frame_detected"
          : "desktop_closed",
        launched.error === "window_not_found"
          ? `"${request.target}" started on desktop "${request.desktopName}" but opened no window; a packaged app may refuse a non-active desktop`
          : mode === "attach"
            ? `Nothing is running on desktop "${request.desktopName}" any more: ${launched.error ?? "unknown"}`
            : `Could not open desktop "${request.desktopName}" for "${request.target}": ${launched.error ?? "unknown"}${launched.code === undefined ? "" : ` (Win32 ${String(launched.code)})`}`,
        request.target,
      );
    }
    if (typeof launched.title === "string" && launched.title !== "") {
      currentTitle = launched.title;
    }

    const session: HiddenDesktopBackendSession = {
      desktopName: request.desktopName,
      pid: launched.pid,
      title: () => currentTitle,
      viewport: () => currentViewport,
      captureFrame: async () => {
        if (closed) {
          throw new HiddenDesktopError(
            "desktop_closed",
            "Hidden desktop session is closed",
          );
        }
        const captured = await worker.call({ cmd: "capture" });
        if (captured.ok !== true || typeof captured.base64 !== "string") {
          throw new HiddenDesktopError(
            captured.error === "window_gone"
              ? "desktop_closed"
              : "black_frame_detected",
            `Capturing "${request.target}" on desktop "${request.desktopName}" failed: ${captured.error ?? "no frame"}`,
            request.target,
          );
        }
        const buffer = Buffer.from(captured.base64, "base64");
        if (typeof captured.title === "string" && captured.title !== "") {
          currentTitle = captured.title;
        }
        return {
          buffer,
          mimeType: "image/png",
          viewport: {
            width: captured.width ?? currentViewport.width,
            height: captured.height ?? currentViewport.height,
            scaleFactor: currentViewport.scaleFactor,
          },
        };
      },
      dispatchMessage: async (message) => {
        if (closed) {
          throw new HiddenDesktopError(
            "desktop_closed",
            "Hidden desktop session is closed",
          );
        }
        switch (message.type) {
          case "char_text": {
            // The clipboard shortcuts are the driver's, answered from VirtualClipboard.
            if (message.text === "") break;
            await worker.call({
              cmd: "type",
              text: message.text,
              submit: message.submit === true,
            });
            break;
          }
          case "key": {
            await worker.call({ cmd: "key", key: message.key });
            break;
          }
          case "mouse_move": {
            await worker.call({
              cmd: "move",
              x: Math.round(message.x),
              y: Math.round(message.y),
            });
            break;
          }
          case "mouse_click": {
            await worker.call({
              cmd: "click",
              x: Math.round(message.x),
              y: Math.round(message.y),
              button: message.button,
              doubleClick: message.doubleClick === true,
            });
            break;
          }
          case "mouse_wheel": {
            await worker.call({
              cmd: "scroll",
              x: Math.round(message.x),
              y: Math.round(message.y),
              deltaX: Math.round(message.deltaX),
              deltaY: Math.round(message.deltaY),
            });
            break;
          }
          case "mouse_drag": {
            await worker.call({
              cmd: "click",
              x: Math.round(message.toX),
              y: Math.round(message.toY),
            });
            break;
          }
          default:
            break;
        }
      },
      switchTo: async () => {
        const result = await worker.call({ cmd: "promote" }, 15_000);
        if (result.ok !== true) {
          throw new HiddenDesktopError(
            "desktop_closed",
            result.error === "window_gone"
              ? `"${request.target}" is no longer running on "${request.desktopName}"; nothing to show, reopen the realm`
              : `Switching the screen to "${request.desktopName}" failed: ${result.error ?? "unknown"}${result.code === undefined ? "" : ` (Win32 ${String(result.code)})`}`,
            request.target,
          );
        }
      },
      switchBack: async () => {
        const result = await worker.call({ cmd: "demote" }, 15_000);
        if (result.ok !== true) {
          throw new HiddenDesktopError(
            "desktop_closed",
            `Switching the screen back from "${request.desktopName}" failed: ${result.error ?? "unknown"}${result.code === undefined ? "" : ` (Win32 ${String(result.code)})`}`,
            request.target,
          );
        }
      },
      openOverlay: async (options) => {
        const result = await worker.call(
          {
            cmd: "overlay",
            script: options.script,
            chatFile: options.chatFile,
            statusFile: options.statusFile,
            readyFile: options.readyFile,
            title: options.title,
          },
          20_000,
        );
        if (result.ok !== true) {
          throw new HiddenDesktopError(
            "desktop_closed",
            `Starting the in-realm overlay on "${request.desktopName}" failed: ${result.error ?? "unknown"}${result.code === undefined ? "" : ` (Win32 ${String(result.code)})`}`,
            request.target,
          );
        }
      },
      closeOverlay: async () => {
        await worker.call({ cmd: "close_overlay" }, 10_000);
      },
      terminateApp: async () => {
        await worker.call({ cmd: "terminate" }, 10_000);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        currentTitle = `${currentTitle} (closed)`;
        await worker.close();
      },
    };
    return session;
  }
}

/**
 * One `powershell.exe` speaking JSON lines: see
 * {@link HIDDEN_DESKTOP_WORKER_SCRIPT} for what it holds and what it refuses to do.
 */
class HiddenDesktopWorker {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #scriptPath: string;
  #buffer = "";
  #closed = false;
  #seq = 0;
  readonly #pending = new Map<number, (reply: WorkerReply) => void>();
  readonly #ready: Promise<void>;

  constructor() {
    // A script file, not `-Command -`: stdin is the command channel, and PowerShell would parse
    // it line by line, which cannot express the worker's loop.
    this.#scriptPath = join(tmpdir(), `eta-hidden-desktop-${randomUUID()}.ps1`);
    // The BOM matters: Windows PowerShell reads a BOM-less script as ANSI.
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      HIDDEN_DESKTOP_WORKER_SCRIPT,
    ].join("\n");
    writeFileSync(this.#scriptPath, `\uFEFF${script}`, "utf8");
    this.#child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.#scriptPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line !== "") this.#settle(line);
        newline = this.#buffer.indexOf("\n");
      }
    });
    this.#child.stderr.resume();
    this.#child.on("exit", () => {
      this.#closed = true;
      for (const resolve of this.#pending.values())
        resolve({ ok: false, error: "worker_exited" });
      this.#pending.clear();
    });
    this.#ready = Promise.resolve();
  }

  #settle(line: string): void {
    let parsed: { id?: number } & WorkerReply;
    try {
      parsed = JSON.parse(line) as { id?: number } & WorkerReply;
    } catch {
      // A stray write (a PowerShell banner, say) is not a reply.
      return;
    }
    if (typeof parsed.id !== "number") return;
    const resolve = this.#pending.get(parsed.id);
    if (resolve === undefined) return;
    this.#pending.delete(parsed.id);
    resolve(parsed);
  }

  async call(
    request: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<WorkerReply> {
    if (this.#closed) return { ok: false, error: "worker_exited" };
    await this.#ready;
    const id = ++this.#seq;
    const reply = new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
      this.#pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.#child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    return reply;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.call({ cmd: "close" }, 8_000).catch(() => undefined);
    this.#closed = true;
    this.#pending.clear();
    try {
      this.#child.stdin.end();
    } catch {
      // Already gone.
    }
    this.#child.kill();
    try {
      rmSync(this.#scriptPath, { force: true });
    } catch {
      // The temp file is a leftover of a killed worker; the OS cleans its temp directory.
    }
  }
}

/* ------------------------------------------------------------------ HiddenDesktopDriver */

/**
 * Tier B Windows isolation driver (`tier: "hidden_desktop"`, `kind: "app"`).
 *
 * Works on Windows Home (`Core` 26300) and Pro/Enterprise without moving the physical mouse
 * cursor, stealing foreground window focus, or touching the host OS clipboard:
 * - Never calls `SwitchDesktop` or global `SendInput`.
 * - Enforces `checkProcessTargetAllowed` before launching or injecting into any target.
 * - Detects blank `PrintWindow` frames (one flat dark colour, black or charcoal) from
 *   hardware-accelerated surfaces and throws a structured
 *   `HiddenDesktopError("black_frame_detected", ...)` so the agent never clicks blindly.
 * - Routes `Ctrl+C` / `Ctrl+V` through the per-realm `VirtualClipboard`.
 * - Supports `CropBox` cropping on observations for GroundCascade zoomed-in coordinate refinement.
 */
export class HiddenDesktopDriver implements RealmDriver {
  readonly kind = "app" as const;
  readonly tier = "hidden_desktop" as const;
  desktopName: string;
  /** Set when this driver adopted an already-running desktop instead of creating one. */
  readonly attachTo: string | undefined;

  private readonly targetExecutable: string;
  private readonly targetArgs: readonly string[];
  private readonly extraDenylist: readonly string[];
  private readonly backend: HiddenDesktopBackend;
  private readonly getSelectedText: (() => string | undefined) | undefined;
  private currentTitle: string;
  private currentViewport: ViewportSize;
  private session: HiddenDesktopBackendSession | null = null;
  private closed = false;
  private watched = false;
  /** True while this realm's desktop is the one on the user's screen. */
  private promoted = false;
  /** The overlay's channel files while promoted, so the host can read its chat. */
  private overlay: DesktopOverlayPaths | null = null;
  /** Heartbeat for the screen watchdog; cleared when the realm goes back to the background. */
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  /** The realm to push live frames into while somebody is watching, if it bound itself. */
  private realm: ManagedRealm | null = null;
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private capturing = false;
  private lastPointerPx: Point2D = { x: 0, y: 0 };
  private lastTypedText = "";
  private pickerState: ComputerPickerState = {
    status: "idle",
    files: [],
    updatedAt: Date.now(),
  };

  constructor(options: HiddenDesktopDriverOptions) {
    const check = checkProcessTargetAllowed(
      options.target,
      options.extraDenylist,
    );
    if (!check.allowed) {
      throw new HiddenDesktopError(
        check.code,
        `Refusing to open HiddenDesktopDriver for sensitive target "${options.target}" (matched "${check.matchedEntry}")`,
        options.target,
      );
    }

    const shortId = (options.id ?? randomUUID())
      .replace(/\W/g, "")
      .slice(0, 16);
    this.attachTo = options.attachTo;
    this.desktopName = options.attachTo ?? `eta_cu_${shortId}`;
    this.targetExecutable = options.target;
    this.targetArgs = options.args ?? [];
    this.extraDenylist = options.extraDenylist ?? [];
    this.currentTitle = options.title ?? options.target;
    this.currentViewport = options.viewport ?? {
      width: 1280,
      height: 720,
      scaleFactor: 1,
    };
    this.backend = options.backend ?? new Win32PowerShellHiddenDesktopBackend();
    this.getSelectedText = options.getSelectedText;
  }

  get isWatched(): boolean {
    return this.watched;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  title(): string {
    return this.session ? this.session.title() : this.currentTitle;
  }

  target(): string {
    return this.targetExecutable;
  }

  viewport(): ViewportSize {
    return this.session ? this.session.viewport() : { ...this.currentViewport };
  }

  /** Ensure the hidden desktop and target process have been initialized on the backend. */
  async ensureStarted(): Promise<HiddenDesktopBackendSession> {
    if (this.closed) {
      throw new HiddenDesktopError(
        "desktop_closed",
        "HiddenDesktopDriver is closed",
      );
    }
    const check = checkProcessTargetAllowed(
      this.targetExecutable,
      this.extraDenylist,
    );
    if (!check.allowed) {
      throw new HiddenDesktopError(
        check.code,
        `Refusing to launch sensitive target "${this.targetExecutable}" (matched "${check.matchedEntry}")`,
        this.targetExecutable,
      );
    }
    if (!this.session) {
      const request: HiddenDesktopLaunchRequest = {
        desktopName: this.desktopName,
        target: this.targetExecutable,
        args: this.targetArgs,
        viewport: this.currentViewport,
        title: this.currentTitle,
      };
      if (this.attachTo !== undefined) {
        if (this.backend.attach === undefined) {
          throw new HiddenDesktopError(
            "desktop_closed",
            `Backend for "${this.desktopName}" cannot re-attach to a running app`,
            this.targetExecutable,
          );
        }
        this.session = await this.backend.attach({
          ...request,
          desktopName: this.attachTo,
        });
        this.desktopName = this.attachTo;
      } else {
        this.session = await this.backend.launch(request);
      }
    }
    return this.session;
  }

  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    const session = await this.ensureStarted();
    // A freshly launched window paints on its next few message loops; on a non-active desktop
    // there is no compositor to hurry it along, so the very first capture can legitimately be
    // blank. Give it a moment before calling it one.
    let capture = await session.captureFrame();
    for (
      let attempt = 0;
      attempt < 8 &&
      (capture.isAllBlack === true || isBlankImageBuffer(capture.buffer));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      capture = await session.captureFrame();
    }
    const viewport = capture.viewport ?? session.viewport();

    if (capture.isAllBlack === true || isBlankImageBuffer(capture.buffer)) {
      throw new HiddenDesktopError(
        "black_frame_detected",
        `PrintWindow captured a blank frame (one flat colour, no picture) on hidden desktop "${this.desktopName}" for target "${this.targetExecutable}"; a GPU-composited window cannot be read back this way`,
        this.targetExecutable,
      );
    }

    if (options?.crop) {
      const cropRect = resolveCropRect(options.crop, viewport);
      const croppedPng = cropImageBufferToPng(capture.buffer, cropRect);
      return {
        mimeType: "image/png",
        data: croppedPng.toString("base64"),
        viewport: {
          width: cropRect.width,
          height: cropRect.height,
          scaleFactor: viewport.scaleFactor,
        },
        cropRect,
      };
    }

    return {
      mimeType: capture.mimeType ?? "image/png",
      data: capture.buffer.toString("base64"),
      viewport,
    };
  }

  async step(
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ): Promise<RealmStepResult | void> {
    if (ctx.signal.aborted) {
      return;
    }
    const session = await this.ensureStarted();
    const viewport = session.viewport();

    switch (action.kind) {
      case "move": {
        const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
          unit: action.unit,
        });
        this.lastPointerPx = px;
        await session.dispatchMessage({
          type: "mouse_move",
          x: px.x,
          y: px.y,
        });
        return {
          summary: `Moved pointer to (${String(px.x)}, ${String(px.y)}) on ${this.desktopName}`,
        };
      }

      case "click":
      case "double_click":
      case "right_click": {
        const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
          unit: action.unit,
        });
        this.lastPointerPx = px;
        const button =
          action.kind === "right_click" ? "right" : (action.button ?? "left");
        await session.dispatchMessage({
          type: "mouse_click",
          button,
          doubleClick: action.kind === "double_click",
          x: px.x,
          y: px.y,
        });
        return {
          summary: `Dispatched ${action.kind} at (${String(px.x)}, ${String(px.y)}) on ${this.desktopName}`,
        };
      }

      case "drag": {
        const fromPx = toViewportPixels(
          { x: action.fromX, y: action.fromY },
          viewport,
          { unit: action.unit },
        );
        const toPx = toViewportPixels(
          { x: action.toX, y: action.toY },
          viewport,
          { unit: action.unit },
        );
        this.lastPointerPx = toPx;
        await session.dispatchMessage({
          type: "mouse_drag",
          fromX: fromPx.x,
          fromY: fromPx.y,
          toX: toPx.x,
          toY: toPx.y,
        });
        return {
          summary: `Dragged (${String(fromPx.x)}, ${String(fromPx.y)}) -> (${String(toPx.x)}, ${String(toPx.y)})`,
        };
      }

      case "scroll": {
        const px =
          action.x !== undefined && action.y !== undefined
            ? toViewportPixels({ x: action.x, y: action.y }, viewport, {
                unit: action.unit,
              })
            : this.lastPointerPx;
        this.lastPointerPx = px;
        await session.dispatchMessage({
          type: "mouse_wheel",
          x: px.x,
          y: px.y,
          deltaX: action.deltaX ?? 0,
          deltaY: action.deltaY,
        });
        return {
          summary: `Scrolled dy=${String(action.deltaY)} at (${String(px.x)}, ${String(px.y)})`,
        };
      }

      case "type": {
        this.lastTypedText = action.text;
        await session.dispatchMessage({
          type: "char_text",
          text: action.text,
          submit: action.submit === true,
        });
        return {
          summary: `Typed ${String(action.text.length)} chars via WM_CHAR`,
        };
      }

      case "key": {
        const normalizedKey = action.key.trim().toLowerCase();
        // Intercept Ctrl+C / Control+C and Ctrl+V / Control+V inside VirtualClipboard
        if (normalizedKey === "ctrl+c" || normalizedKey === "control+c") {
          const selected = this.getSelectedText?.() ?? this.lastTypedText;
          ctx.clipboard.writeText(selected);
          await session.dispatchMessage({
            type: "key",
            key: action.key,
          });
          return {
            summary: `Copied ${String(selected.length)} chars into VirtualClipboard`,
          };
        }

        if (normalizedKey === "ctrl+v" || normalizedKey === "control+v") {
          const pasted = ctx.clipboard.readText();
          this.lastTypedText = pasted;
          await session.dispatchMessage({
            type: "char_text",
            text: pasted,
            submit: false,
          });
          return {
            summary: `Pasted ${String(pasted.length)} chars from VirtualClipboard`,
          };
        }

        await session.dispatchMessage({
          type: "key",
          key: action.key,
        });
        return {
          summary: `Dispatched key ${action.key}`,
        };
      }

      case "wait": {
        if (action.durationMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, action.durationMs);
            ctx.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        return {
          summary: `Waited ${String(action.durationMs)}ms`,
        };
      }
    }
  }

  async userInput(
    input: ComputerUserInput,
    ctx: { clipboard: VirtualClipboard },
  ): Promise<void> {
    const abortController = new AbortController();
    switch (input.kind) {
      case "move":
      case "click":
      case "double_click":
      case "right_click":
        await this.step(
          { kind: input.kind, x: input.x, y: input.y, unit: "normalized" },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "drag":
        await this.step(
          {
            kind: "drag",
            fromX: input.fromX,
            fromY: input.fromY,
            toX: input.toX,
            toY: input.toY,
            unit: "normalized",
          },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "scroll":
        await this.step(
          {
            kind: "scroll",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            unit: "normalized",
          },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "type":
        await this.step(
          { kind: "type", text: input.text },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "key":
        await this.step(
          { kind: "key", key: input.key },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
    }
  }

  async stageFiles(files: string[]): Promise<ComputerPickerState> {
    this.pickerState = {
      status: files.length > 0 ? "armed" : "idle",
      files: [...files],
      updatedAt: Date.now(),
    };
    return { ...this.pickerState, files: [...this.pickerState.files] };
  }

  async resolvePicker(files: string[]): Promise<ComputerPickerState> {
    this.pickerState = {
      status: "intercepted_silent",
      files: [...files],
      updatedAt: Date.now(),
    };
    return { ...this.pickerState, files: [...this.pickerState.files] };
  }

  setWatched(watched: boolean): void {
    this.watched = watched;
    if (watched) {
      this.startFrameLoop();
    } else {
      this.stopFrameLoop();
    }
  }

  /** Whether this realm's desktop is currently the one on the user's screen. */
  get isPromoted(): boolean {
    return this.promoted;
  }

  /**
   * Bring the realm's desktop onto the user's screen. Nothing is moved between desktops — Windows
   * has no such operation — the whole screen switches to the desktop the app was already running
   * on, which is why the app keeps its window, state and process.
   */
  async promote(): Promise<DesktopOverlayPaths> {
    if (this.closed) {
      throw new HiddenDesktopError(
        "desktop_closed",
        `Realm "${this.desktopName}" is closed`,
        this.target(),
      );
    }
    const session = await this.ensureStarted();
    if (session.openOverlay === undefined || session.switchTo === undefined) {
      throw new HiddenDesktopError(
        "desktop_closed",
        `Backend for "${this.desktopName}" cannot switch the screen`,
        this.target(),
      );
    }
    // A second promote (the same button pressed twice, or the panel and the strip both asking)
    // must not put a second overlay on a desktop that already has one: the replaced overlay's
    // teardown switches the screen back, which reads as "Show on screen does nothing".
    if (this.promoted && this.overlay !== null) {
      return this.overlay;
    }
    const overlay = prepareDesktopOverlay(this.currentTitle);
    // Overlay first, switch second: if the overlay never comes up, the user is never left on a
    // desktop with no way back.
    await session.openOverlay({
      script: overlay.script,
      chatFile: overlay.chatFile,
      statusFile: overlay.statusFile,
      readyFile: overlay.readyFile,
      title: this.currentTitle,
    });
    const ready = await waitForFile(overlay.readyFile, 15_000);
    if (!ready) {
      await session.closeOverlay?.();
      throw new HiddenDesktopError(
        "desktop_closed",
        `The in-realm overlay for "${this.desktopName}" did not start; the screen was left alone`,
        this.target(),
      );
    }
    await session.switchTo();
    this.promoted = true;
    this.overlay = overlay;
    this.#startPromotionGuards(overlay);
    return overlay;
  }

  /**
   * Two guards run while a realm owns the screen: a heartbeat file the watchdog watches, and (for
   * the worst case) the worker's own record of the desktop the user came from. If this process dies,
   * the heartbeat goes stale and the watchdog switches the screen back on its own.
   */
  #startPromotionGuards(overlay: DesktopOverlayPaths): void {
    // A promote that follows an earlier one must not leave the first heartbeat loop writing to a
    // directory that has since been removed.
    if (this.beatTimer !== undefined) {
      clearInterval(this.beatTimer);
      this.beatTimer = undefined;
    }
    const beat = (): void => {
      try {
        writeFileSync(overlay.beatFile, String(Date.now()), "utf8");
      } catch {
        // The temp dir could be gone; the watchdog treats that as a stale heartbeat, which is the
        // safe direction.
      }
    };
    beat();
    this.beatTimer = setInterval(beat, 2_000);
    this.beatTimer.unref?.();
    try {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          overlay.watchdogScript,
          "-BeatFile",
          overlay.beatFile,
          "-TimeoutSeconds",
          "12",
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
    } catch {
      // Without the watchdog the overlay's own switch-back button is still there.
    }
  }

  #stopPromotionGuards(): void {
    if (this.beatTimer !== undefined) {
      clearInterval(this.beatTimer);
      this.beatTimer = undefined;
    }
    // Removing the heartbeat is how the watchdog is told to stand down.
    if (this.overlay !== null) {
      rmSync(this.overlay.beatFile, { force: true });
    }
  }

  /** Hand the screen back to wherever the user was, and take the overlay down. */
  async demote(): Promise<void> {
    if (!this.promoted) {
      return;
    }
    this.promoted = false;
    this.#stopPromotionGuards();
    const session = this.session;
    const overlay = this.overlay;
    this.overlay = null;
    if (session === null) {
      return;
    }
    try {
      await session.switchBack?.();
    } finally {
      await session.closeOverlay?.();
      if (overlay !== null) {
        rmSync(join(overlay.script, ".."), { recursive: true, force: true });
      }
    }
  }

  /**
   * While somebody is looking, push frames the way the browser realm does, so the panel shows the
   * desktop live rather than one still picture. Unwatched, this loop does not exist: a hidden
   * realm costs nothing but its window.
   */
  startFrameLoop(): void {
    if (this.frameTimer !== undefined || this.realm === null) return;
    this.frameTimer = setInterval(() => {
      void this.emitFrameOnce();
    }, 600);
    void this.emitFrameOnce();
  }

  stopFrameLoop(): void {
    if (this.frameTimer === undefined) return;
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
  }

  async emitFrameOnce(): Promise<void> {
    const realm = this.realm;
    if (realm === null || this.closed || !this.watched) return;
    if (this.capturing) return;
    this.capturing = true;
    try {
      const observation = await this.observe();
      realm.emitFrame({
        mimeType: "image/png",
        data: observation.data,
        viewport: observation.viewport,
        at: Date.now(),
      });
    } catch {
      // A window that is gone or not yet painted simply has no frame this tick.
    } finally {
      this.capturing = false;
    }
  }

  /** The realm this driver draws into; `ManagedRealm` hands itself over when it registers. */
  bindRealm(realm: ManagedRealm): this {
    this.realm = realm;
    return this;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watched = false;
    this.stopFrameLoop();
    if (this.session) {
      const activeSession = this.session;
      this.session = null;
      await activeSession.close();
    }
  }

  /**
   * End the app this realm launched.
   *
   * Only ever called when the user asked for it: the window may hold work that was never saved, so
   * the realm's ordinary `close` releases the desktop and leaves the process running.
   */
  async terminateApp(): Promise<void> {
    const session = this.session;
    if (session === null || this.closed) return;
    await session.terminateApp?.();
  }
}
