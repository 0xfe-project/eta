import { createSignal } from "solid-js";

const [settingsOpen, setSettingsOpen] = createSignal(false);
export { settingsOpen };
export function openSettings(): void { setSettingsOpen(true); }
export function closeSettings(): void { setSettingsOpen(false); }
