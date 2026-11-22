import { exportTheme, importTheme } from "./theme-package.js";
import {
  checkedImage,
  defaultTheme,
  imageLimit,
  normalizeTheme,
  resolveColors,
  settingsKey,
  showWallpaper,
  sitePattern,
  sitesKey,
  webOrigin,
} from "./theme.js";

const { chrome } = globalThis;
const get = (id) => document.getElementById(id);
const labels = {
  canvas: "应用背景",
  surface: "面板底色",
  ink: "正文",
  border: "边框",
  button: "主按钮",
  blue: "链接与强调",
  selected: "选中状态",
  muted: "次要文字",
  mutedInk: "辅助正文",
  faint: "弱提示",
  strong: "强调边框",
  buttonInk: "按钮文字",
  ring: "键盘焦点",
  blueFill: "信息背景",
  green: "成功文字",
  greenFill: "成功背景",
  amber: "待处理文字",
  amberFill: "待处理背景",
  warning: "警告标记",
  warningInk: "警告文字",
  red: "错误文字",
  redFill: "错误背景",
};
const primaryColors = ["canvas", "surface", "ink", "border", "button", "blue"];
const colorFields = new Map();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let state = { theme: defaultTheme(), image: null, imageName: "" };
let saveTimer;
let saveVersion = 0;
let fileVersion = 0;
let enabledSites = [];
let siteIsOn = false;
let siteBusy = false;
let siteVersion = 0;

function feedback(text, error = false) {
  const label = get("feedback");
  label.textContent = text;
  label.toggleAttribute("data-error", error);
}

async function flush() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const version = saveVersion;
  try {
    await chrome.storage.local.set({ [settingsKey]: state });
    if (version === saveVersion) feedback("已保存，已启用的 Eta 页面会更新。");
  } catch {
    if (version === saveVersion)
      feedback("保存失败。请尝试清除壁纸后再保存。", true);
  }
}

function changed(renderForm = false) {
  updatePreview();
  if (renderForm) updateControls();
  saveVersion++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 140);
  feedback("正在保存…");
}

function colorControls() {
  for (const [role, label] of Object.entries(labels)) {
    const row = document.createElement("div");
    row.className = "color-row";
    const text = document.createElement("label");
    text.htmlFor = `color-${role}`;
    text.textContent = label;
    const picker = document.createElement("input");
    picker.type = "color";
    picker.id = text.htmlFor;
    const hex = document.createElement("input");
    hex.type = "text";
    hex.setAttribute("aria-label", `${label}的十六进制颜色`);
    hex.spellcheck = false;
    hex.maxLength = 7;
    picker.addEventListener("input", () => {
      hex.value = picker.value;
      hex.removeAttribute("aria-invalid");
      state.theme.colors[role] = picker.value;
      changed();
    });
    hex.addEventListener("change", () => {
      if (!/^#[0-9a-f]{6}$/i.test(hex.value)) {
        hex.setAttribute("aria-invalid", "true");
        feedback("请输入 # 加六位十六进制字符，例如 #1E293B。", true);
        return;
      }
      picker.value = hex.value;
      hex.removeAttribute("aria-invalid");
      state.theme.colors[role] = picker.value;
      changed();
    });
    row.append(text, picker, hex);
    get(primaryColors.includes(role) ? "color-list" : "more-colors").append(
      row,
    );
    colorFields.set(role, { picker, hex });
  }
}

function range(id, value, suffix) {
  get(id).value = value;
  get(`${id}-value`).textContent = `${value}${suffix}`;
}

function updateComponents() {
  const settings = state.theme.components[get("part").value];
  range("part-radius", settings.radius, "px");
  get("part-opacity-row").hidden = settings.backgroundOpacity === undefined;
  if (settings.backgroundOpacity !== undefined)
    range("part-opacity", Math.round(settings.backgroundOpacity * 100), "%");
}

function updateControls() {
  const { theme, image } = state;
  get("name").value = theme.name;
  get("base").value = theme.base;
  const colors = resolveColors(theme);
  for (const [role, { picker, hex }] of colorFields) {
    picker.value = colors[role];
    hex.value = colors[role].toUpperCase();
    hex.removeAttribute("aria-invalid");
  }
  get("wallpaper-fit").value = theme.wallpaper.fit;
  get("wallpaper-clear").disabled = !image;
  get("wallpaper-name").textContent = state.imageName || "尚未选择壁纸";
  range(
    "wallpaper-overlay",
    Math.round(theme.wallpaper.overlayOpacity * 100),
    "%",
  );
  updateComponents();
}

function updatePreview() {
  const preview = get("preview");
  const { theme, image } = state;
  const paintImage = showWallpaper(image, reducedMotion.matches) ? image : null;
  get("wallpaper-thumb").style.backgroundImage = paintImage
    ? `url("${paintImage}")`
    : "";
  const colors = resolveColors(theme);
  for (const [role, color] of Object.entries(colors))
    preview.style.setProperty(`--preview-${role}`, color);
  for (const [part, settings] of Object.entries(theme.components)) {
    preview.style.setProperty(
      `--preview-${part}-radius`,
      `${settings.radius}px`,
    );
    if (settings.backgroundOpacity !== undefined) {
      const bg = colors[part === "composer" ? "canvas" : "surface"];
      preview.style.setProperty(
        `--preview-${part}-bg`,
        `color-mix(in srgb, ${bg} ${settings.backgroundOpacity * 100}%, transparent)`,
      );
    }
  }
  const shade = `color-mix(in srgb, ${colors.canvas} ${theme.wallpaper.overlayOpacity * 100}%, transparent)`;
  preview.style.backgroundImage = paintImage
    ? `linear-gradient(${shade}, ${shade}), url("${paintImage}")`
    : "";
  preview.style.backgroundSize =
    theme.wallpaper.fit === "fill" ? "100% 100%" : theme.wallpaper.fit;
}

function bindTabs(list) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      const panel = item.getAttribute("aria-controls");
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      get(panel).hidden = !selected;
      document
        .querySelector(`[data-preview-nav="${panel}"]`)
        ?.classList.toggle("active", selected);
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const next = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      select(tabs[next]);
    });
  }
}

async function refreshSite() {
  const origin = webOrigin(get("site").value.trim());
  const version = ++siteVersion;
  const allowed =
    origin &&
    enabledSites.includes(origin) &&
    (await chrome.permissions.contains({ origins: [sitePattern(origin)] }));
  if (version !== siteVersion) return;
  siteIsOn = Boolean(allowed);
  get("site-toggle").textContent = siteIsOn ? "停用主题" : "启用主题";
  get("site-toggle").disabled = siteBusy || !origin;
  get("site-status").textContent = siteIsOn
    ? "主题已启用"
    : "仅在你启用的站点应用主题";
}

get("site").addEventListener("input", () => {
  get("site-toggle").disabled = true;
  void refreshSite();
});
get("site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (siteBusy) return;
  const origin = webOrigin(get("site").value.trim());
  if (!origin) {
    feedback("请输入以 http:// 或 https:// 开头的 Eta 站点地址。", true);
    return;
  }
  siteBusy = true;
  get("site").value = origin;
  get("site-toggle").disabled = true;
  try {
    const enabled = !siteIsOn;
    if (
      enabled &&
      !(await chrome.permissions.request({ origins: [sitePattern(origin)] }))
    )
      throw new Error("需要站点访问权限才能应用主题。");
    const response = await chrome.runtime.sendMessage({
      kind: "set-site",
      origin,
      enabled,
    });
    if (!response?.ok) throw new Error(response?.error || "无法更新站点设置。");
    enabledSites = enabled
      ? [...new Set([...enabledSites, origin])]
      : enabledSites.filter((site) => site !== origin);
    feedback(
      enabled ? "已启用。打开 Eta 页面即可看到主题。" : "已停用该站点的主题。",
    );
  } catch (error) {
    feedback(error.message, true);
  } finally {
    siteBusy = false;
    void refreshSite();
  }
});

get("name").addEventListener("change", (event) => {
  state.theme.name = event.target.value.trim() || "自定义主题";
  changed(true);
});
get("base").addEventListener("change", (event) => {
  state.theme.base = event.target.value;
  state.theme.colors = {};
  changed(true);
});
get("reset").addEventListener("click", () => {
  fileVersion++;
  state = { theme: defaultTheme(), image: null, imageName: "" };
  changed(true);
});
get("part").addEventListener("change", updateComponents);
get("part-radius").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.theme.components[get("part").value].radius = value;
  range("part-radius", value, "px");
  changed();
});
get("part-opacity").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.theme.components[get("part").value].backgroundOpacity = value / 100;
  range("part-opacity", value, "%");
  changed();
});
get("wallpaper-fit").addEventListener("change", (event) => {
  state.theme.wallpaper.fit = event.target.value;
  changed();
});
get("wallpaper-overlay").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.theme.wallpaper.overlayOpacity = value / 100;
  range("wallpaper-overlay", value, "%");
  changed();
});
get("wallpaper-clear").addEventListener("click", () => {
  fileVersion++;
  delete state.theme.wallpaper.file;
  state.image = null;
  state.imageName = "";
  changed(true);
});

function readUrl(bytes, mime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取此壁纸。"));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

async function verifyDecode(src) {
  if (!src) return;
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new Error("浏览器无法打开这张图片。");
  }
}

get("wallpaper-file").addEventListener("change", async (event) => {
  const picked = event.target.files[0];
  event.target.value = "";
  if (!picked) return;
  const version = ++fileVersion;
  try {
    if (picked.size > imageLimit)
      throw new Error("请选择一张不超过 4 MB 的图片。");
    const bytes = new Uint8Array(await picked.arrayBuffer());
    const { file, mime } = checkedImage(bytes);
    const image = await readUrl(bytes, mime);
    await verifyDecode(image);
    if (version !== fileVersion) return;
    state.theme.wallpaper.file = file;
    state.image = image;
    state.imageName = picked.name;
    changed(true);
  } catch (error) {
    if (version === fileVersion) feedback(error.message, true);
  }
});
get("theme-file").addEventListener("change", async (event) => {
  const picked = event.target.files[0];
  event.target.value = "";
  if (!picked) return;
  const version = ++fileVersion;
  try {
    if (picked.size > imageLimit + 65536)
      throw new Error("主题包过大，壁纸上限为 4 MB。");
    const imported = importTheme(new Uint8Array(await picked.arrayBuffer()));
    await verifyDecode(imported.image);
    if (version !== fileVersion) return;
    state = imported;
    changed(true);
  } catch (error) {
    if (version === fileVersion)
      feedback(
        error instanceof SyntaxError
          ? "无法读取主题的 JSON，请检查文件格式。"
          : error.message,
        true,
      );
  }
});
get("export").addEventListener("click", () => {
  try {
    const bytes = exportTheme(state);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/zip" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.theme.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "-")}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    feedback("主题已导出。");
  } catch (error) {
    feedback(error.message, true);
  }
});

colorControls();
for (const list of document.querySelectorAll('[role="tablist"]'))
  bindTabs(list);
updateControls();
updatePreview();
reducedMotion.addEventListener("change", updatePreview);
addEventListener("pagehide", flush);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[sitesKey]) {
    enabledSites = changes[sitesKey].newValue || [];
    void refreshSite();
  }
});

chrome.storage.local
  .get([settingsKey, sitesKey])
  .then((stored) => {
    if (stored[settingsKey] && saveVersion === 0) {
      const loaded = stored[settingsKey];
      state = {
        theme: normalizeTheme(loaded.theme),
        image: loaded.image,
        imageName: loaded.imageName,
      };
      updateControls();
      updatePreview();
    }
    enabledSites = stored[sitesKey] || [];
    const fromTab = webOrigin(new URLSearchParams(location.search).get("site"));
    if (!get("site").value)
      get("site").value = fromTab ?? enabledSites[0] ?? "";
    void refreshSite();
  })
  .catch(() => feedback("无法读取已保存的设置。", true));
