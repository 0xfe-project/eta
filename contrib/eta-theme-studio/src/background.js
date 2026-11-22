import { sitePattern, sitesKey, webOrigin } from "./theme.js";

const { chrome } = globalThis;
const registrationId = "eta-theme-pages";
const files = ["content.js"];
let work = Promise.resolve();

function schedule(task) {
  const next = work.then(task);
  work = next.catch(console.warn);
  return next;
}

async function sites() {
  const stored = (await chrome.storage.local.get(sitesKey))[sitesKey];
  return Array.isArray(stored)
    ? stored.filter((value) => value && webOrigin(value) === value)
    : [];
}

async function register(origins) {
  const patterns = [...new Set(origins.map(sitePattern))];
  const granted = await Promise.all(
    patterns.map((pattern) =>
      chrome.permissions.contains({ origins: [pattern] }),
    ),
  );
  const matches = patterns.filter((_, index) => granted[index]);
  const [existing] = await chrome.scripting.getRegisteredContentScripts({
    ids: [registrationId],
  });
  if (!matches.length) {
    if (existing)
      await chrome.scripting.unregisterContentScripts({
        ids: [registrationId],
      });
    return;
  }
  if (
    existing &&
    [...existing.matches].sort().join() === [...matches].sort().join()
  )
    return;
  const config = {
    id: registrationId,
    matches,
    js: files,
    runAt: "document_idle",
  };
  if (existing) await chrome.scripting.updateContentScripts([config]);
  else await chrome.scripting.registerContentScripts([config]);
}

async function setSite(origin, enabled) {
  if (!origin || webOrigin(origin) !== origin)
    throw new Error("请输入有效的 HTTP 或 HTTPS 地址。");
  const current = await sites();
  const pattern = sitePattern(origin);
  const next = enabled
    ? [...new Set([...current, origin])]
    : current.filter((site) => site !== origin);
  if (enabled && !(await chrome.permissions.contains({ origins: [pattern] })))
    throw new Error("浏览器尚未授予该站点的访问权限。");
  await register(next);
  await chrome.storage.local.set({ [sitesKey]: next });
  if (enabled) {
    const tabs = await chrome.tabs.query({ url: pattern });
    await Promise.allSettled(
      tabs
        .filter((tab) => webOrigin(tab.url) === origin)
        .map((tab) =>
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files }),
        ),
    );
  } else if (!next.some((site) => sitePattern(site) === pattern)) {
    await chrome.permissions.remove({ origins: [pattern] });
  }
}

async function revokeSites() {
  const current = await sites();
  const permitted = await Promise.all(
    current.map((site) =>
      chrome.permissions.contains({ origins: [sitePattern(site)] }),
    ),
  );
  const remaining = current.filter((_, index) => permitted[index]);
  if (remaining.length !== current.length)
    await chrome.storage.local.set({ [sitesKey]: remaining });
  await register(remaining);
}

chrome.action.onClicked.addListener((tab) => {
  const editor = new URL(chrome.runtime.getURL("editor.html"));
  const origin = webOrigin(tab.url);
  if (origin) editor.searchParams.set("site", origin);
  chrome.tabs.create({ url: editor.href });
});
chrome.runtime.onInstalled.addListener(() =>
  schedule(async () => register(await sites())),
);
chrome.runtime.onStartup.addListener(() =>
  schedule(async () => register(await sites())),
);
chrome.permissions.onRemoved.addListener(() => schedule(revokeSites));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message?.kind !== "set-site" ||
    !sender.url?.startsWith(chrome.runtime.getURL("editor.html"))
  )
    return false;
  schedule(() => setSite(message.origin, message.enabled === true)).then(
    () => respond({ ok: true }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
