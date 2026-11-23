import { context, signal, Storage } from "nsh";

// Settings › Appearance › Images in messages, kept on this device. Compact: a picture is its name
// where it was put, its thumbnail on hover (desktops) and the picture on a press. Expanded: no
// name in the text; 180-wide cards under it. Only shown text follows it (messages, task
// descriptions, routine reports, tool screenshots); an editor always shows the name.

export type PictureMode = "compact" | "expanded";

export const pictureModes = ["compact", "expanded"] as const;

const storageKey = "eta.messages.pictures";

export function createPictureMode() {
  const mode = signal<PictureMode>("compact");
  let changed = false;
  void Storage.getItem(storageKey)
    .then((stored) => {
      if (!changed && (stored === "compact" || stored === "expanded"))
        mode.set(stored);
    })
    .catch(() => {});
  return {
    mode: () => mode(),
    set(next: PictureMode) {
      changed = true;
      mode.set(next);
      void Storage.setItem(storageKey, next).catch(() => {});
    },
  };
}

/** How pictures in shown text look on this device; compact where nothing provides it. */
export const PictureModes = context<ReturnType<typeof createPictureMode>>({
  mode: () => "compact",
  set: () => {},
});
