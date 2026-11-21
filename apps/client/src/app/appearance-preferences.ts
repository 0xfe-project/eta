import type { Flavor, PaletteId } from "../components/palettes";
import type { ChatWidth, Theme } from "../pages/settings/appearance";
import { setColorScheme, signal, Storage } from "nsh";
import { flavors, paletteIds } from "../components/palettes";
const themeKey = "eta.appearance";

const chatWidthKey = "eta.chat.width";

const chatRailKey = "eta.chat.rail";

const fontsKey = "eta.appearance.fonts";

const paletteKey = "eta.appearance.palette";

const flavorKey = "eta.appearance.flavor";

export function createAppearancePreferences() {
  const theme = signal<Theme>("system");
  const chatRail = signal(false);
  const paletteId = signal<PaletteId>("default");
  const flavor = signal<Flavor>("mocha");
  void Storage.getItem(paletteKey)
    .then((stored) => {
      const id = paletteIds.find((candidate) => candidate === stored);
      if (id) paletteId.set(id);
    })
    .catch(() => {});
  void Storage.getItem(flavorKey)
    .then((stored) => {
      const name = flavors.find((candidate) => candidate === stored);
      if (name) flavor.set(name);
    })
    .catch(() => {});
  function changePalette(next: PaletteId) {
    paletteId.set(next);
    void Storage.setItem(paletteKey, next).catch(() => {});
  }
  function changeFlavor(next: Flavor) {
    flavor.set(next);
    void Storage.setItem(flavorKey, next).catch(() => {});
  }
  const fonts = signal({ interface: "", mono: "" });
  void Storage.getItem(chatRailKey)
    .then((value) => chatRail.set(value === "true"))
    .catch(() => {});
  void Storage.getItem(fontsKey)
    .then((value) => {
      if (!value) return;
      const saved = JSON.parse(value);
      if (typeof saved.interface === "string" && typeof saved.mono === "string")
        fonts.set({
          interface: saved.interface.slice(0, 100),
          mono: saved.mono.slice(0, 100),
        });
    })
    .catch(() => {});
  function changeChatRail(next: boolean) {
    chatRail.set(next);
    void Storage.setItem(chatRailKey, String(next)).catch(() => {});
  }
  function changeFonts(next: { interface: string; mono: string }) {
    const normalized = {
      interface: next.interface.slice(0, 100),
      mono: next.mono.slice(0, 100),
    };
    fonts.set(normalized);
    void Storage.setItem(fontsKey, JSON.stringify(normalized)).catch(() => {});
  }
  const chatWidth = signal<ChatWidth>("standard");
  void Storage.getItem(chatWidthKey)
    .then((stored) => {
      if (
        stored === "extra-narrow" ||
        stored === "compact" ||
        stored === "wide" ||
        stored === "standard"
      )
        chatWidth.set(stored);
    })
    .catch(() => {});
  function changeChatWidth(width: ChatWidth) {
    chatWidth.set(width);
    void Storage.setItem(chatWidthKey, width).catch(() => {});
  }
  void Storage.getItem(themeKey)
    .then((stored) => {
      if (stored === "dark" || stored === "light") {
        theme.set(stored);
        setColorScheme(stored);
      }
    })
    .catch(() => {});
  function changeTheme(next: Theme) {
    theme.set(next);
    setColorScheme(next);
    void Storage.setItem(themeKey, next).catch(() => {});
  }
  return {
    theme,
    fonts,
    chatWidth,
    chatRail,
    paletteId,
    flavor,
    changeTheme,
    changePalette,
    changeFlavor,
    changeFonts,
    changeChatWidth,
    changeChatRail,
  };
}
