import { signal } from "nsh";
import { foldNext } from "../../components/motion";

interface DisclosureOptions {
  open?: () => boolean;
  defaultOpen?: boolean;
  animated?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Atomic disclosure (expand/collapse) behavior with optional LayoutAnimation fold transition.
 */
export function createDisclosure(options: DisclosureOptions = {}) {
  const own = signal(options.defaultOpen ?? false);
  const open = () => (options.open ? options.open() : own());

  function setOpen(next: boolean) {
    if (next === open()) return;
    if (options.animated) foldNext();
    if (!options.open) own.set(next);
    options.onOpenChange?.(next);
  }

  return {
    open,
    setOpen,
    toggle: () => setOpen(!open()),
    triggerState: () => ({ expanded: open() }),
  };
}
