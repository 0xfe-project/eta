import type {
  ComputerCursorEvent,
  ComputerCursorState,
  ComputerFrameEvent,
  ComputerMachineCapabilities,
  ComputerPickerEvent,
  ComputerPickerState,
  ComputerRealmView,
  ComputerUserInput,
} from "@eta/client-contracts";
import type { WireState } from "@/lib/wire";
import { useCallback, useEffect, useState } from "react";
import { getWire } from "@/lib/wire";
import {
  useTarget,
  useTargetMissing,
  useWireMutation,
  useWireState,
} from "@/queries/wire";

const COMPUTER_TARGET = "computer";

const computerRealmTarget = (realmId: string): string => `computer.${realmId}`;

const EMPTY_REALMS: readonly ComputerRealmView[] = [];
const EMPTY_CAPABILITIES: readonly ComputerMachineCapabilities[] = [];

/** Whether a plugin is mounted without an error in `hello.mounted`. */
export function isPluginMounted(
  name: string,
  state: Pick<WireState, "mounted"> = getWire().store.getState(),
): boolean {
  return state.mounted.some(
    (plugin) => plugin.name === name && plugin.error === undefined,
  );
}

/** Reactive check for `hello.mounted` so entry points hide cleanly when not mounted. */
export function useIsPluginMounted(name = COMPUTER_TARGET): boolean {
  return useWireState((state) => isPluginMounted(name, state));
}

interface ComputerTargetSections {
  realms?: readonly ComputerRealmView[] | undefined;
  capabilities?: readonly ComputerMachineCapabilities[] | undefined;
}

interface ComputerRealmTargetSections {
  info?: ComputerRealmView | undefined;
}

export interface ComputerActionArgs {
  takeover: { realmId?: string | undefined };
  release: { realmId?: string | undefined };
  pause: { realmId?: string | undefined };
  resume: { realmId?: string | undefined };
  stop: { realmId?: string | undefined };
  input: { realmId?: string | undefined; input: ComputerUserInput };
  resolvePicker: { realmId?: string | undefined; files: string[] };
  promote: { realmId?: string | undefined };
  demote: { realmId?: string | undefined };
  close: { realmId?: string | undefined; endApp?: boolean | undefined };
}

/**
 * Subscribe to the `computer` root target (`realms` and `capabilities`), gated by
 * `hello.mounted` so unmounted hosts are never subscribed to.
 */
export function useComputer() {
  const mounted = useIsPluginMounted(COMPUTER_TARGET);
  const sections = useTarget(mounted ? COMPUTER_TARGET : undefined)?.sections as
    | ComputerTargetSections
    | undefined;
  return {
    mounted,
    loaded: sections !== undefined,
    realms: sections?.realms ?? EMPTY_REALMS,
    capabilities: sections?.capabilities ?? EMPTY_CAPABILITIES,
  };
}

/**
 * Subscribe to `computer.<realmId>` for `info: ComputerRealmView` and live ephemeral
 * `frame`, `cursor`, and `picker` events.
 */
export function useComputerRealm(realmId: string | null | undefined) {
  const mounted = useIsPluginMounted(COMPUTER_TARGET);
  const target =
    mounted && realmId !== null && realmId !== undefined && realmId !== ""
      ? computerRealmTarget(realmId)
      : undefined;
  const state = useTarget(target);
  const missing = useTargetMissing(target);
  const sections = state?.sections as ComputerRealmTargetSections | undefined;
  const info = sections?.info;

  const [ephemeral, setEphemeral] = useState<{
    realmId: string;
    frame?: ComputerFrameEvent | undefined;
    cursor?: ComputerCursorEvent | undefined;
    picker?: ComputerPickerEvent | undefined;
  }>();

  useEffect(() => {
    if (target === undefined || realmId === null || realmId === undefined) {
      return undefined;
    }
    const wire = getWire();
    const off = wire.onEvent(target, (event) => {
      if (
        event.name === "frame" &&
        event.data !== null &&
        typeof event.data === "object"
      ) {
        const frame = event.data as ComputerFrameEvent;
        setEphemeral((prev) => ({
          realmId,
          frame,
          cursor: prev?.realmId === realmId ? prev.cursor : undefined,
          picker: prev?.realmId === realmId ? prev.picker : undefined,
        }));
      } else if (
        event.name === "cursor" &&
        event.data !== null &&
        typeof event.data === "object"
      ) {
        const cursor = event.data as ComputerCursorEvent;
        setEphemeral((prev) => ({
          realmId,
          frame: prev?.realmId === realmId ? prev.frame : undefined,
          cursor,
          picker: prev?.realmId === realmId ? prev.picker : undefined,
        }));
      } else if (
        event.name === "picker" &&
        event.data !== null &&
        typeof event.data === "object"
      ) {
        const picker = event.data as ComputerPickerEvent;
        setEphemeral((prev) => ({
          realmId,
          frame: prev?.realmId === realmId ? prev.frame : undefined,
          cursor: prev?.realmId === realmId ? prev.cursor : undefined,
          picker,
        }));
      }
    });
    return off;
  }, [target, realmId]);

  const activeEphemeral =
    ephemeral?.realmId === realmId ? ephemeral : undefined;

  const cursor: ComputerCursorState | undefined =
    activeEphemeral?.cursor !== undefined &&
    (info === undefined || activeEphemeral.cursor.at >= info.cursor.at)
      ? activeEphemeral.cursor
      : info?.cursor;

  const picker: ComputerPickerState | undefined =
    activeEphemeral?.picker !== undefined &&
    (info === undefined ||
      activeEphemeral.picker.updatedAt >= info.picker.updatedAt)
      ? activeEphemeral.picker
      : info?.picker;

  return {
    mounted,
    missing,
    loaded: info !== undefined,
    info,
    frame: activeEphemeral?.frame,
    cursor,
    picker,
  };
}

/** Mutations for a specific `computer.<realmId>` (or root `computer` when `realmId` is omitted). */
export function useComputerActions(realmId?: string) {
  const target =
    realmId !== undefined && realmId !== ""
      ? computerRealmTarget(realmId)
      : COMPUTER_TARGET;

  const takeover = useWireMutation<
    ComputerActionArgs["takeover"] | void,
    ComputerRealmView
  >(target, "takeover");
  const release = useWireMutation<
    ComputerActionArgs["release"] | void,
    ComputerRealmView
  >(target, "release");
  const pause = useWireMutation<
    ComputerActionArgs["pause"] | void,
    ComputerRealmView
  >(target, "pause");
  const resume = useWireMutation<
    ComputerActionArgs["resume"] | void,
    ComputerRealmView
  >(target, "resume");
  const stop = useWireMutation<
    ComputerActionArgs["stop"] | void,
    ComputerRealmView
  >(target, "stop");
  const input = useWireMutation<
    ComputerActionArgs["input"],
    ComputerRealmView | void
  >(target, "input");
  const resolvePicker = useWireMutation<
    ComputerActionArgs["resolvePicker"],
    ComputerPickerState
  >(target, "resolvePicker");
  const close = useWireMutation<ComputerActionArgs["close"] | void, void>(
    target,
    "close",
  );
  const promote = useWireMutation<
    ComputerActionArgs["promote"] | void,
    ComputerRealmView
  >(target, "promote");
  const demote = useWireMutation<
    ComputerActionArgs["demote"] | void,
    ComputerRealmView
  >(target, "demote");

  const sendInput = useCallback(
    (userInput: ComputerUserInput) =>
      input.mutate(
        realmId !== undefined
          ? { realmId, input: userInput }
          : { input: userInput },
      ),
    [input, realmId],
  );

  return {
    takeover,
    release,
    pause,
    resume,
    stop,
    input,
    sendInput,
    resolvePicker,
    promote,
    demote,
    close,
  };
}
