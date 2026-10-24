/**
 * The three window buttons, drawn by the page.
 *
 * A Windows window whose title bar was hidden (`apps/desktop`) has no caption buttons at all, so
 * the page is the only place they can come from: close, minimise, maximise-or-restore, in the
 * fruit colours everyone already reads as "these are the window's", in the corner the window would
 * have put them. macOS keeps its own three lights inset into the same band, and a browser has no
 * window to close — on both, this renders nothing at all.
 *
 * Fixed rather than slotted into a band: the buttons belong to the window and have to stay in the
 * window's corner whatever the page below is doing — including on the phone-width layout, where
 * the sidebar band is gone. `.lights-slot` in the sidebar band keeps the wordmark out from under
 * them (see `styles.css`).
 *
 * Its own labels go through `common`, because a screen reader hears the window's controls, not the
 * page's.
 */
import type { WindowAction } from "@/lib/native";
import { useTranslation } from "react-i18next";
import { drawsOwnWindowControls, windowAction } from "@/lib/native";

const BUTTONS: readonly {
  action: WindowAction;
  label: "window.close" | "window.minimize" | "window.maximize";
  tone: string;
}[] = [
  { action: "close", label: "window.close", tone: "window-control-close" },
  {
    action: "minimize",
    label: "window.minimize",
    tone: "window-control-minimize",
  },
  {
    action: "toggle-maximize",
    label: "window.maximize",
    tone: "window-control-maximize",
  },
];

export function WindowControls() {
  const { t: translateText } = useTranslation(["common"] as const);
  if (!drawsOwnWindowControls()) return null;
  return (
    <div className="window-controls" data-no-drag>
      {BUTTONS.map(({ action, label, tone }) => (
        <button
          key={action}
          type="button"
          aria-label={translateText(label)}
          title={translateText(label)}
          className={tone}
          onClick={() => void windowAction(action)}
        />
      ))}
    </div>
  );
}
