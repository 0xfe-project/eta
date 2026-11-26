import type { UpgradeArgs, UpgradeResults } from "@eta/client-contracts";
import { cleanup, effect, signal } from "nsh";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { recentResult } from "./progress";

function describeError(error: unknown) {
  return problemText(error);
}

export function useHostUpdate() {
  const host = useHost();
  const check = host.upgradeCheck;
  const pending = signal("");
  const error = signal("");
  const checkedAt = signal(0);
  const checkClock = signal(Date.now());
  const advanced = signal<boolean>();
  const notes = signal(false);
  const confirm = signal(false);
  const editor = signal<"upstream" | "token">();
  const draft = signal("");
  const status = host.upgrade;
  const connected = () => host.state().status === "open";
  const active = () => status()?.state === "running";
  const editable = () => connected() && !pending() && !active();
  const canRead = () => connected() && host.can("upgrade.check");
  const failed = () =>
    ["failed", "rolled-back", "broken", "lost"].includes(status()?.state ?? "");
  /** The last upgrade, once it has ended, while it is recent enough to tell. */
  const result = () => recentResult(status(), checkClock());
  /** Pressed and not answered yet: the row says so before the Host does. */
  const launched = signal<string>();
  const starting = () =>
    !active() &&
    (pending() === "start" ||
      (launched() !== undefined && status()?.id !== launched()));
  const version = () =>
    status()?.state === "done"
      ? (status()?.to ?? check()?.version)
      : check()?.version;
  const offer = () =>
    !!check()?.available && !!check()?.latest && check()?.latest !== version();
  const token = () => check()?.token;
  const source = () => check()?.upstream;
  const checkedLabel = () => {
    const minutes = Math.floor(
      Math.max(0, checkClock() - checkedAt()) / 60_000,
    );
    if (minutes < 1) return uiText("updateCheckedJustNow");
    if (minutes < 60) return uiText("updateCheckedMinutes", { minutes });
    return uiText("updateCheckedHours", { hours: Math.floor(minutes / 60) });
  };

  async function read() {
    await host.checkUpgrade();
    const now = Date.now();
    checkedAt.set(now);
    checkClock.set(now);
  }

  async function refresh() {
    if (!canRead() || pending()) return;
    error.set("");
    pending.set("check");
    try {
      await read();
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
    }
  }

  async function save<A extends "setPrerelease" | "setUpstream" | "setToken">(
    action: A,
    args: UpgradeArgs[A],
  ): Promise<boolean> {
    if (!editable() || !host.can(`upgrade.${action}`)) return false;
    error.set("");
    pending.set(action);
    try {
      await host.call<UpgradeResults[A]>("upgrade", action, args);
      editor.set(undefined);
      draft.set("");
      notes.set(false);
      await read();
      return true;
    } catch (problem) {
      error.set(describeError(problem));
      return false;
    } finally {
      pending.set("");
    }
  }

  async function request<A extends "start" | "cancel">(
    action: A,
    args: UpgradeArgs[A],
  ) {
    if (!connected() || pending()) return;
    error.set("");
    pending.set(action);
    // The dialog closes at once: the row says what happens next.
    if (action === "start") confirm.set(false);
    try {
      const answer = await host.call<UpgradeResults[A]>(
        "upgrade",
        action,
        args,
      );
      if (action === "start") launch((answer as UpgradeResults["start"]).id);
      confirm.set(false);
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
      host.refreshUpgrade();
    }
  }

  // The Host answered with the upgrade's id; its status follows within a poll. A Host whose
  // status never comes stops counting as starting after a while.
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  function launch(id: string) {
    launched.set(id);
    clearTimeout(launchTimer);
    launchTimer = setTimeout(() => launched.set(undefined), 20_000);
  }
  cleanup(() => clearTimeout(launchTimer));

  /** While waiting for work: give up waiting and restart now, stopping it. */
  async function updateNow() {
    if (!connected() || pending()) return;
    error.set("");
    pending.set("start");
    try {
      await host.call<UpgradeResults["cancel"]>("upgrade", "cancel", {});
      const answer = await host.call<UpgradeResults["start"]>(
        "upgrade",
        "start",
        { force: true },
      );
      launch(answer.id);
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
      host.refreshUpgrade();
    }
  }

  let checked = false;
  let completed = "";
  effect(() => {
    if (!canRead() || pending()) return;
    const state = status();
    const newCompletion = state?.state === "done" && state.id !== completed;
    if (checked && !newCompletion) return;
    if (state?.state === "done") completed = state.id;
    checked = true;
    void refresh();
  });
  const clock = setInterval(() => checkClock.set(Date.now()), 30_000);
  cleanup(() => clearInterval(clock));

  function edit(mode: "upstream" | "token") {
    error.set("");
    draft.set(mode === "upstream" ? (source()?.saved ?? "") : "");
    editor.set(mode);
  }

  function closeEditor() {
    if (pending()) return;
    editor.set(undefined);
    error.set("");
    draft.set("");
  }

  const canUpdate = () =>
    host.can("upgrade.start") && editable() && !check()?.blocked && offer();

  return {
    check,
    status,
    pending,
    error,
    checkedAt,
    checkedLabel,
    advanced,
    notes,
    confirm,
    editor,
    draft,
    connected,
    active,
    editable,
    canRead,
    failed,
    result,
    starting,
    updateNow,
    version,
    offer,
    canUpdate,
    token,
    source,
    refresh,
    save,
    request,
    edit,
    closeEditor,
  };
}

export type HostUpdate = ReturnType<typeof useHostUpdate>;
