import { cleanup, keymap, signal } from "nsh";

// Centralized Escape-key dismissal stack for overlays (Modal, Sheet, Popover, Menu).
// Only the topmost dismissable receives Escape; non-dismissable entries remain on top and
// block layers underneath from dismissing behind a busy confirmation dialog.

interface DismissEntry {
  dismiss: () => void;
  enabled: () => boolean;
}

const stack = signal<DismissEntry[]>([]);
let bound = false;

function ensureBound() {
  if (bound) return;
  bound = true;
  keymap.bind(
    "escape",
    () => {
      const top = stack().at(-1);
      if (top && top.enabled()) top.dismiss();
    },
    { when: "always" },
  );
}

/**
 * Registers a dismissable layer on the Escape stack for the lifetime of the current reactive
 * scope. Returns a handle to invoke dismissal (respecting `enabled`) or check whether this layer
 * is currently topmost.
 */
export function createDismissable(options: {
  onDismiss: () => void;
  enabled?: () => boolean;
}) {
  ensureBound();
  const enabled = () => (options.enabled ? options.enabled() : true);
  const entry: DismissEntry = {
    dismiss: () => {
      if (enabled()) options.onDismiss();
    },
    enabled,
  };
  stack.update((all) => [...all, entry]);
  cleanup(() => {
    stack.update((all) => all.filter((item) => item !== entry));
  });
  return {
    dismiss: entry.dismiss,
    isTop: () => stack().at(-1) === entry,
  };
}

/**
 * Reports the topmost layer without dismissing it: is there one, and does it let itself be
 * dismissed right now? A layer that is present but disabled (a busy confirmation, say) still
 * sits on top, so a caller can tell "nothing open" apart from "open and holding".
 */
export function topDismissable(): "absent" | "dismissable" | "blocked" {
  const top = stack().at(-1);
  if (!top) return "absent";
  return top.enabled() ? "dismissable" : "blocked";
}

/**
 * Dismisses the topmost layer if one allows dismissal, so a caller (the Android back
 * handler, say) can chain to the layer under it. Returns whether anything was dismissed.
 */
export function dismissTop(): boolean {
  const top = stack().at(-1);
  if (top && top.enabled()) {
    top.dismiss();
    return true;
  }
  return false;
}

/** Current depth of the dismissable stack (useful for tests and layering guards). */
export function dismissStackSize() {
  return stack().length;
}
