import { appSelector, isEtaIconSource, stylesheet } from "./adapter.js";
import {
  defaultTheme,
  normalizeTheme,
  settingsKey,
  sitesKey,
} from "./theme.js";

const { chrome } = globalThis;

if (!globalThis.etaThemeStudioActive) {
  globalThis.etaThemeStudioActive = true;
  start();
}

function start() {
  let root;
  let canvas;
  let theme = defaultTheme();
  let image = null;
  let enabled = false;
  let themeStyle;
  let pending = false;
  let rendered;
  let nativeRules = [];
  let snapshots = [];
  const icons = new Map();
  const examined = new Set();
  const iconSelector = 'img:is([src^="data:image/svg+xml,"],[src^="blob:"])';
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function rememberIcon(element) {
    const source = element.getAttribute("src");
    if (!source || examined.has(source)) return;
    if (isEtaIconSource(source)) {
      icons.set(source, source);
    } else if (source.startsWith(`blob:${location.origin}/`)) {
      // The Web runtime converts Eta's short, single-path SVG icons to blob URLs.
      // Their own bytes provide the source color without changing the image's original URL.
      void fetch(source)
        .then(async (response) => {
          if (response.headers.get("content-type") !== "image/svg+xml") return;
          const blob = await response.blob();
          if (blob.size > 8192) return;
          const original = `data:image/svg+xml,${encodeURIComponent(await blob.text())}`;
          if (!isEtaIconSource(original)) return;
          icons.set(source, original);
          queue();
        })
        .catch(() => {});
    }
    examined.add(source);
  }

  function rememberIcons(element) {
    if (element.matches(iconSelector)) rememberIcon(element);
    for (const icon of element.querySelectorAll(iconSelector))
      rememberIcon(icon);
  }

  const watchPage = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.attributeName === "src" &&
        record.target.matches(iconSelector)
      ) {
        rememberIcon(record.target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) rememberIcons(node);
      }
    }
    queue();
  });
  function queue() {
    if (!pending) {
      pending = true;
      requestAnimationFrame(paint);
    }
  }

  function paint() {
    pending = false;
    root = enabled && document.querySelector(appSelector);
    if (!root) {
      delete document.documentElement.dataset.etaTheme;
      themeStyle?.remove();
      rendered = undefined;
      return;
    }
    const rulesChanged = readPaintStyles();
    const rootClass = root.parentElement?.className;
    if (rulesChanged || rendered?.rootClass !== rootClass) {
      // The safe area's outer view carries Eta's canvas color. Read its original class rules
      // so downstream overrides never masquerade as a new built-in palette.
      canvas =
        root.parentElement?.style.backgroundColor ||
        nativeRules.find(
          (rule) =>
            rule.style.backgroundColor &&
            root.parentElement?.matches(rule.selectorText),
        )?.style.backgroundColor;
    }
    if (
      !rulesChanged &&
      rendered?.root === root &&
      rendered.rootClass === rootClass &&
      rendered.theme === theme &&
      rendered.image === image &&
      rendered.iconCount === icons.size &&
      rendered.motion === reducedMotion.matches
    )
      return;
    if (!themeStyle) {
      themeStyle = document.createElement("style");
      themeStyle.id = "eta-theme-studio";
    }
    const css = stylesheet(
      theme,
      image,
      canvas,
      reducedMotion.matches,
      nativeRules,
      icons,
    );
    if (themeStyle.textContent !== css) themeStyle.textContent = css;
    if (!themeStyle.isConnected) document.head.append(themeStyle);
    document.documentElement.dataset.etaTheme = "";
    rendered = {
      root,
      rootClass,
      theme,
      image,
      iconCount: icons.size,
      motion: reducedMotion.matches,
    };
  }

  function readPaintStyles() {
    const current = [];
    for (const sheet of [
      ...document.styleSheets,
      ...document.adoptedStyleSheets,
    ]) {
      if (themeStyle && sheet.ownerNode === themeStyle) continue;
      try {
        current.push({
          sheet,
          rules: sheet.cssRules,
          count: sheet.cssRules.length,
        });
      } catch {
        /* A stylesheet from another origin is inaccessible to the browser. */
      }
    }
    if (
      current.length === snapshots.length &&
      current.every(
        ({ sheet, count }, index) =>
          sheet === snapshots[index].sheet && count === snapshots[index].count,
      )
    )
      return false;
    snapshots = current;
    nativeRules = current.flatMap(({ rules }) =>
      Array.from(rules).filter(
        (rule) => rule.selectorText?.startsWith(".nsh-") && rule.style,
      ),
    );
    return true;
  }

  function applySettings(settings) {
    try {
      theme = settings?.theme ? normalizeTheme(settings.theme) : defaultTheme();
      image = settings?.image;
    } catch {
      theme = defaultTheme();
      image = null;
    }
  }

  function enable(sites) {
    enabled = Array.isArray(sites) && sites.includes(location.origin);
    watchPage.disconnect();
    if (enabled) {
      rememberIcons(document.body);
      watchPage.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "src"],
      });
    }
    queue();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[settingsKey]) {
      applySettings(changes[settingsKey].newValue);
      queue();
    }
    if (changes[sitesKey]) enable(changes[sitesKey].newValue);
  });
  reducedMotion.addEventListener("change", queue);
  chrome.storage.local.get([settingsKey, sitesKey]).then((stored) => {
    applySettings(stored[settingsKey]);
    enable(stored[sitesKey]);
  });
}
