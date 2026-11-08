import type { UpdaterLike } from "../src/bun/update";
import { describe, expect, it, vi } from "vitest";
import { createShellUpdate } from "../src/bun/update";

type Listener = Parameters<UpdaterLike["onStatusChange"]>[0];

/** Electrobun's Updater as far as this uses it, offering `offered` and doing what it is told. */
function fakeUpdater(
  offered: { version: string; updateAvailable: boolean; error?: string },
  behave: { downloadFails?: string; applyQuits?: boolean } = {},
) {
  let listener: Listener = null;
  let ready = false;
  const emit = (status: string, details?: Record<string, unknown>) =>
    listener?.({ status, message: status, ...(details ? { details } : {}) });
  const updater: UpdaterLike = {
    checkForUpdate: vi.fn(async () => ({ error: "", ...offered })),
    downloadUpdate: vi.fn(async () => {
      emit("download-progress", { progress: 40 });
      if (behave.downloadFails !== undefined) {
        emit("error", { errorMessage: behave.downloadFails });
        return;
      }
      ready = true;
      emit("download-complete");
    }),
    applyUpdate: vi.fn(async () => {
      if (behave.applyQuits === true) emit("launching-new-version");
      else emit("error", { errorMessage: "helper failed" });
    }),
    updateInfo: () => ({ updateReady: ready, error: "" }),
    onStatusChange: (callback) => {
      listener = callback;
    },
  };
  return { updater, emit };
}

const hooks = () => ({
  beforeApply: vi.fn(async () => {}),
  afterFailedApply: vi.fn(async () => {}),
});

describe("the app's own update", () => {
  it("does nothing until it is asked", () => {
    const { updater } = fakeUpdater({
      version: "0.3.0",
      updateAvailable: true,
    });
    const update = createShellUpdate({ updater, current: "0.2.0", ...hooks() });
    expect(update.view()).toEqual({ state: "idle", current: "0.2.0" });
    expect(updater.checkForUpdate).not.toHaveBeenCalled();
  });

  it("finds a newer version, downloads it and hands over to it", async () => {
    const { updater } = fakeUpdater(
      { version: "0.3.0", updateAvailable: true },
      { applyQuits: true },
    );
    const around = hooks();
    const update = createShellUpdate({ updater, current: "0.2.0", ...around });
    expect(await update.check()).toMatchObject({
      state: "available",
      version: "0.3.0",
    });
    expect(await update.download()).toMatchObject({
      state: "ready",
      version: "0.3.0",
    });
    expect(await update.apply()).toMatchObject({ state: "applying" });
    expect(around.beforeApply).toHaveBeenCalledBefore(
      updater.applyUpdate as ReturnType<typeof vi.fn>,
    );
    expect(around.afterFailedApply).not.toHaveBeenCalled();
  });

  it("calls only a newer version an update", async () => {
    const { updater } = fakeUpdater({
      version: "0.1.9",
      updateAvailable: true,
    });
    const update = createShellUpdate({ updater, current: "0.2.0", ...hooks() });
    expect(await update.check()).toMatchObject({ state: "current" });
    expect(await update.download()).toMatchObject({ state: "current" });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("says why a check failed", async () => {
    const { updater } = fakeUpdater({
      version: "",
      updateAvailable: false,
      error: "Failed to check for updates: HTTP 404",
    });
    const update = createShellUpdate({ updater, current: "0.2.0", ...hooks() });
    expect(await update.check()).toMatchObject({
      state: "failed",
      during: "check",
      error: "Failed to check for updates: HTTP 404",
    });
  });

  it("says why a download failed, and leaves the app as it was", async () => {
    const { updater } = fakeUpdater(
      { version: "0.3.0", updateAvailable: true },
      { downloadFails: "checksum mismatch" },
    );
    const around = hooks();
    const update = createShellUpdate({ updater, current: "0.2.0", ...around });
    await update.check();
    expect(await update.download()).toMatchObject({
      state: "failed",
      during: "download",
      error: "checksum mismatch",
    });
    expect(await update.apply()).toMatchObject({ state: "failed" });
    expect(around.beforeApply).not.toHaveBeenCalled();
  });

  it("brings the host back when the update does not go ahead", async () => {
    const { updater } = fakeUpdater({
      version: "0.3.0",
      updateAvailable: true,
    });
    const around = hooks();
    const update = createShellUpdate({ updater, current: "0.2.0", ...around });
    await update.check();
    await update.download();
    expect(await update.apply()).toMatchObject({
      state: "failed",
      during: "apply",
      error: "helper failed",
    });
    expect(around.beforeApply).toHaveBeenCalledTimes(1);
    expect(around.afterFailedApply).toHaveBeenCalledTimes(1);
  });
});
