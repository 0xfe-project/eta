import { useState } from "react";

/**
 * A dialog's onCloseAutoFocus, giving focus back to what had it when the
 * dialog opened. Radix gives it to the dialog's own trigger, which a dialog
 * opened from a menu or a store does not have.
 */
export function useReturnFocus(open: boolean) {
  const [wasOpen, setWasOpen] = useState(open);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  // Read while rendering the opening: a field's autoFocus takes focus as the
  // dialog mounts, before any of its effects or handlers run.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const active = document.activeElement;
      setOpener(active instanceof HTMLElement ? active : null);
    }
  }
  return (event: Event) => {
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  };
}
