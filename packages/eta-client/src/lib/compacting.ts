/**
 * Shared compacting state: set by the context-panel when a manual compact op is
 * sent, cleared when compactionEpoch advances past the request epoch.
 *
 * Both context-panel (compact button + indicator) and composer (send gate +
 * hint) read the same signal so they stay in lock-step without prop-threading.
 */
import { createSignal } from "solid-js";

const [compacting, setCompacting] = createSignal(false);
const [requestedAtEpoch, setRequestedAtEpoch] = createSignal<number | null>(null);

export { compacting, setCompacting, requestedAtEpoch, setRequestedAtEpoch };
