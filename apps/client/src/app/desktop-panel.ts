import { signal, Storage } from "nsh";

const key = "eta.panel.open";
const open = signal(true);
let loaded = false;
let edited = false;

export function desktopPanelOpen(): boolean {
  if (!loaded) {
    loaded = true;
    void Storage.getItem(key)
      .then((value) => {
        if (!edited) open.set(value !== "false");
      })
      .catch(() => {});
  }
  return open();
}

export function setDesktopPanelOpen(value: boolean) {
  edited = true;
  open.set(value);
  void Storage.setItem(key, String(value)).catch(() => {});
}
