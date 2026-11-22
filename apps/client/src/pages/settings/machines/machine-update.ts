import type { MachineView } from "@eta/client-contracts";
import { effect, signal, untracked } from "nsh";
import { showToast } from "../../../components/toast";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

// A machine's update as its row and its detail tell it (Paper: Eta · Settings › Supplement /
// Settings / Update flow, 9 and P7): pressed or being replaced → "Updating to 0.9.1…", then
// a toast "gpu-box updated to 0.9.1" once it is back on another build, or "Update failed" with why.

/** The build each machine was on when this window saw its update begin. */
const before = signal<Record<string, string | null>>({});

function remember(item: MachineView) {
  before.update((all) => ({ ...all, [item.id]: item.version }));
}

export type MachineUpdateState = "updating" | "updated" | "failed";

export function useMachineUpdate(item: () => MachineView) {
  const host = useHost();
  const pressed = signal(false);
  effect(() => {
    const now = item();
    if (now.build === "updating" && !(now.id in untracked(before)))
      remember(now);
  });
  const state = (): MachineUpdateState | undefined => {
    const now = item();
    if (pressed() || now.build === "updating") return "updating";
    if (now.status === "online" && now.updateError) return "failed";
    const was = before()[now.id];
    if (
      was !== undefined &&
      now.build === "current" &&
      now.version !== null &&
      now.version !== was
    )
      return "updated";
    return undefined;
  };
  // Back on another build: a toast says so once and the row is an ordinary row again.
  effect(() => {
    if (state() !== "updated") return;
    const now = untracked(item);
    // A row and its detail both watch the machine: one toast between them.
    if (!(now.id in untracked(before))) return;
    before.update((all) => {
      const { [now.id]: _, ...rest } = all;
      return rest;
    });
    showToast({
      title: uiText("machineUpdatedToast", {
        name: now.name,
        version: now.version ?? "",
      }),
    });
  });
  const label = () => {
    const now = item();
    switch (state()) {
      case "updating": {
        const target = host.upgradeCheck()?.version;
        return target
          ? uiText("machineUpdatingTo", { version: target })
          : uiText("updating");
      }
      case "updated":
        return uiText("machineUpdatedTo", { version: now.version ?? "" });
      case "failed":
        return uiText("machineUpdateFailed");
      default:
        return undefined;
    }
  };
  const tone = () => {
    switch (state()) {
      case "updating":
        return "blue" as const;
      case "updated":
        return "green" as const;
      case "failed":
        return "red" as const;
      default:
        return undefined;
    }
  };
  /** Ask the Host to replace the daemon now; the row says so at once. */
  async function start() {
    if (pressed()) return;
    pressed.set(true);
    remember(item());
    try {
      await host.call("machines", "upgrade", { machineId: item().id });
    } catch (problem) {
      // A reason the Host keeps is on the row already; anything else is said once, app-wide.
      const message =
        problem instanceof Error ? problem.message : String(problem);
      if (untracked(item).updateError !== message) host.error.set(message);
    } finally {
      pressed.set(false);
    }
  }
  return { state, label, tone, pressed, start };
}
