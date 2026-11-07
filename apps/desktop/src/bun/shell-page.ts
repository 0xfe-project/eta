/**
 * The shell's own page: choosing where the host runs, downloading it the first time, and saying why
 * it cannot be shown.
 *
 * A string, not a file under `src/mainview`: `build.copy` does not land files in the dev bundle
 * (see host.ts), and this page has to exist exactly when there is no host to serve a better one.
 * Nothing of the product is here for the same reason, so it repeats the product's look by hand:
 * the colours are `apps/web/src/styles.css`'s, the rules are `apps/web/AGENTS.md`'s. Words live in
 * `WORDS` below, zh and en, picked from the system language like the page's own default.
 *
 * It holds no secret and takes no value from the server into its markup. Everything comes from
 * `shell-server.ts` as JSON and lands through `textContent`, so an address or an error is text.
 */
const zh = {
  title: "eta 在哪里运行？",
  local: "在这台电脑上运行",
  localHint: "host 和数据都在这台电脑上。",
  remote: "连接到已有 host",
  remoteHint: "这台电脑只是一块屏，数据留在那台 host 上。",
  independent: "两种方式的数据互相独立，切换不会迁移。",
  address: "地址",
  addressHint: "地址或连接链接",
  token: "令牌",
  tokenSaved: "已保存",
  connect: "连接",
  connecting: "连接中",
  starting: "正在启动",
  back: "返回",
  retry: "重试",
  change: "切换连接方式",
  "current.local": "当前：在这台电脑上运行",
  "current.remote": "当前：{address}",
  "failure.address.title": "地址不对",
  "failure.address.body": "地址写成 https://host:8790 这样。",
  "failure.unreachable.title": "连不上这个地址",
  "failure.unreachable.body":
    "确认地址没写错、host 在运行、这台电脑能访问到它。",
  "failure.timeout.title": "host 没有及时回应",
  "failure.timeout.body": "确认 host 在运行、网络没有问题。",
  "failure.not-eta.title": "这个地址上不是 eta host",
  "failure.not-eta.body": "检查地址和端口。",
  "failure.token.title": "令牌不对",
  "failure.token.body": "到 host 的设置 → 机器 → 连接手机重新拿一条链接。",
  "failure.no-page.title": "这个 host 没有网页界面",
  "failure.no-page.body": "host 在运行，但没有页面可以显示。",
  "failure.lost.title": "与 host 的连接断开了",
  "failure.lost.body": "智能体还在 host 上继续运行。恢复后这里会自动回去。",
  "failure.host.title": "eta 没能启动 host",
  "failure.host.body": "修好后重试，或者连接到已有 host。",
  "download.title": "正在下载 host",
  "download.finding": "正在查找可用的版本",
  "download.size": "{received} / {total} MB",
  "download.received": "已下载 {received} MB",
  "download.hint": "只有第一次需要下载，之后 host 在设置里单独更新。",
  "failure.download-offline.title": "连不上下载服务器",
  "failure.download-offline.body": "检查网络后重试，或者连接到已有 host。",
  "failure.download-interrupted.title": "下载中断了",
  "failure.download-interrupted.body": "没下完的部分已经删掉。重试会重新下载。",
  "failure.download-checksum.title": "下载的文件校验不通过",
  "failure.download-checksum.body":
    "文件和发布时的 SHA256SUMS 对不上，已经删掉，没有运行。重试会重新下载。",
  "failure.download-token.title": "没有权限下载 host",
  "failure.download-token.body":
    "仓库是私有的，需要能读它的 GitHub token：设置 GH_TOKEN，或者用 gh auth login 登录后重试。也可以改为连接到已有 host。",
  "failure.download-refused.title": "下载服务器拒绝了请求",
  "failure.download-refused.body":
    "下面是服务器的回答。可以重试，或者连接到已有 host。",
  "failure.download-none.title": "没有这个版本能用的 host",
  "failure.download-none.body": "先更新桌面端，或者连接到已有 host。",
  "failure.download-broken.title": "下载的 host 运行不了",
  "failure.download-broken.body": "文件已经删掉。重试会重新下载。",
  "failure.download-disk.title": "没能保存 host",
  "failure.download-disk.body": "检查磁盘空间和用户目录的权限后重试。",
  close: "关闭",
  minimize: "最小化",
  maximize: "最大化",
};

const en: typeof zh = {
  title: "Where should eta run?",
  local: "Run on this computer",
  localHint: "The host and its data stay on this computer.",
  remote: "Connect to an existing host",
  remoteHint: "This computer is only a screen. Data stays on that host.",
  independent: "The two keep separate data. Switching doesn't move anything.",
  address: "Address",
  addressHint: "Address or connect link",
  token: "Token",
  tokenSaved: "Saved",
  connect: "Connect",
  connecting: "Connecting",
  starting: "Starting",
  back: "Back",
  retry: "Retry",
  change: "Change connection",
  "current.local": "Now: running on this computer",
  "current.remote": "Now: {address}",
  "failure.address.title": "That address isn't valid",
  "failure.address.body": "Write it like https://host:8790.",
  "failure.unreachable.title": "Can't reach this address",
  "failure.unreachable.body":
    "Check the address, that the host is running, and that this computer can reach it.",
  "failure.timeout.title": "The host didn't answer in time",
  "failure.timeout.body":
    "Check that the host is running and the network works.",
  "failure.not-eta.title": "That isn't an eta host",
  "failure.not-eta.body": "Check the address and the port.",
  "failure.token.title": "The token is wrong",
  "failure.token.body":
    "Get a new link from the host: Settings → Machines → Connect a phone.",
  "failure.no-page.title": "This host has no web interface",
  "failure.no-page.body": "The host is running but has no page to show.",
  "failure.lost.title": "Lost the connection to the host",
  "failure.lost.body":
    "Agents keep running on the host. This window goes back by itself once it answers.",
  "failure.host.title": "eta couldn't start the host",
  "failure.host.body": "Fix it and retry, or connect to an existing host.",
  "download.title": "Downloading the host",
  "download.finding": "Looking for a version to use",
  "download.size": "{received} / {total} MB",
  "download.received": "{received} MB so far",
  "download.hint":
    "Only the first time. After this the host updates on its own from Settings.",
  "failure.download-offline.title": "Can't reach the download server",
  "failure.download-offline.body":
    "Check the network and retry, or connect to an existing host.",
  "failure.download-interrupted.title": "The download stopped",
  "failure.download-interrupted.body":
    "The part that arrived was deleted. Retry downloads it again.",
  "failure.download-checksum.title": "The download didn't check out",
  "failure.download-checksum.body":
    "It doesn't match the release's SHA256SUMS, so it was deleted without running. Retry downloads it again.",
  "failure.download-token.title": "No permission to download the host",
  "failure.download-token.body":
    "The repository is private and needs a GitHub token that can read it: set GH_TOKEN, or sign in with gh auth login, then retry. Or connect to an existing host instead.",
  "failure.download-refused.title": "The download server said no",
  "failure.download-refused.body":
    "Its answer is below. Retry, or connect to an existing host.",
  "failure.download-none.title": "No host works with this app",
  "failure.download-none.body":
    "Update the desktop app first, or connect to an existing host.",
  "failure.download-broken.title": "The downloaded host doesn't run",
  "failure.download-broken.body": "It was deleted. Retry downloads it again.",
  "failure.download-disk.title": "Couldn't save the host",
  "failure.download-disk.body":
    "Check the disk space and the permissions on your home folder, then retry.",
  close: "Close",
  minimize: "Minimize",
  maximize: "Maximize",
};

export const WORDS = { zh, en };

const STYLE = String.raw`
  :root {
    color-scheme: light dark;
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.54 0 0);
    --destructive: oklch(0.53 0.22 27.325);
    --border: oklch(0.922 0 0);
    --border-strong: oklch(0.85 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.556 0 0);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.1 0 0);
      --foreground: oklch(0.98 0 0);
      --primary: oklch(0.98 0 0);
      --primary-foreground: oklch(0.1 0 0);
      --muted: oklch(0.2 0 0);
      --muted-foreground: oklch(0.72 0 0);
      --destructive: oklch(0.68 0.19 25);
      --border: oklch(0.98 0 0 / 10%);
      --border-strong: oklch(0.98 0 0 / 28%);
      --input: oklch(0.98 0 0 / 28%);
      --ring: oklch(0.72 0 0);
    }
  }
  * { box-sizing: border-box; border-radius: 0; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    flex-direction: column;
    font: 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    background: var(--background);
    color: var(--foreground);
  }
  .band {
    flex: none;
    height: 40px;
    display: flex;
    justify-content: flex-end;
    -webkit-app-region: drag;
    app-region: drag;
    --electrobun-app-region: drag;
  }
  .band button {
    width: 46px;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 16px;
    -webkit-app-region: no-drag;
    app-region: no-drag;
    --electrobun-app-region: no-drag;
  }
  .band button:hover { background: var(--muted); color: var(--foreground); }
  main {
    flex: 1;
    width: 100%;
    max-width: 28rem;
    margin: 0 auto;
    padding: 0 16px 40px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
  }
  [hidden] { display: none !important; }
  h1 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 500; }
  p { margin: 0; }
  .quiet { color: var(--muted-foreground); }
  .small { font-size: 12px; line-height: 16px; }
  .error { color: var(--destructive); }
  .meter {
    height: 4px;
    background: var(--muted);
  }
  .meter > div {
    height: 100%;
    width: 0;
    background: var(--primary);
    transition: width 60ms linear;
  }
  .detail {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 16px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted-foreground);
  }
  .stack { display: grid; gap: 12px; }
  .options { display: grid; gap: 8px; }
  .option {
    display: block;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    font: inherit;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--foreground);
    transition: background-color 60ms linear, border-color 60ms linear;
  }
  .option:hover:enabled { background: var(--muted); }
  .option[aria-expanded="true"] { border-color: var(--foreground); }
  .option span { display: block; }
  form { display: grid; gap: 8px; }
  label {
    display: grid;
    grid-template-columns: 4rem 1fr;
    align-items: center;
    gap: 8px;
    color: var(--muted-foreground);
  }
  input {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    font: inherit;
    border: 1px solid var(--input);
    background: transparent;
    color: var(--foreground);
    transition: border-color 60ms linear;
  }
  input::placeholder { color: var(--muted-foreground); }
  input:focus, button:focus-visible { outline: 1px solid var(--ring); outline-offset: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .action {
    height: 32px;
    padding: 0 12px;
    font: inherit;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--foreground);
    transition: background-color 60ms linear;
  }
  .action:hover:enabled { background: var(--muted); }
  .action.primary {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }
  .action.primary:hover:enabled { opacity: 0.9; }
  button:disabled { opacity: 0.5; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

/** The script runs against the ids below, in the page; it is written out so nothing is built. */
const SCRIPT = String.raw`
const shell = window.__ETA_SHELL__;
const facts = window.__ETA_HOST__;
const element = (id) => document.getElementById(id);
const words = JSON.parse(element("words").textContent);
let lang = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
const t = (key, values) => {
  let text = words[lang][key];
  for (const [name, value] of Object.entries(values || {}))
    text = text.replace("{" + name + "}", value);
  return text;
};

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "omit",
    headers: { authorization: "Bearer " + shell.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return await response.json();
}

let view;
let busy = false;

function paintWords() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll("[data-word]"))
    node.textContent = t(node.dataset.word);
  for (const node of document.querySelectorAll("[data-label]"))
    node.setAttribute("aria-label", t(node.dataset.label));
  element("address").placeholder = t("addressHint");
}

/** A download's failures say what went wrong with the download; a refusal with no token says that. */
function failureKey(failure) {
  if (failure.reason !== "download") return failure.reason;
  if (failure.kind === "refused" && failure.tokenless) return "download-token";
  return "download-" + failure.kind;
}

function paintFailure(target, failure) {
  const key = failureKey(failure);
  target.title.textContent = t("failure." + key + ".title");
  target.body.textContent = t("failure." + key + ".body");
  target.detail.textContent = failure.detail || "";
  target.detail.hidden = !failure.detail;
}

function showError(failure) {
  element("form-error").hidden = false;
  paintFailure(
    { title: element("form-error-title"), body: element("form-error-body"), detail: element("form-error-detail") },
    failure,
  );
}

function setBusy(on, word) {
  busy = on;
  for (const node of document.querySelectorAll("button:not(.window)")) node.disabled = on;
  element("connect").textContent = t(on && word === "connecting" ? "connecting" : "connect");
  element("local-title").textContent = t(on && word === "starting" ? "starting" : "local");
  element("retry").textContent = t(on ? "connecting" : "retry");
}

const MB = 1024 * 1024;

function paintDownload() {
  element("chooser").hidden = true;
  element("failed").hidden = true;
  element("downloading").hidden = false;
  const progress = view.progress;
  const total = progress?.total;
  element("download-version").textContent = progress ? "eta-host " + progress.version : t("download.finding");
  // A server that does not say the size still gets a count.
  element("download-size").hidden = !progress;
  if (progress)
    element("download-size").textContent = total
      ? t("download.size", {
          received: (progress.received / MB).toFixed(0),
          total: (total / MB).toFixed(0),
        })
      : t("download.received", { received: (progress.received / MB).toFixed(0) });
  const bar = element("download-bar");
  bar.style.width = total ? Math.min(100, (100 * progress.received) / total).toFixed(1) + "%" : "0%";
  element("download-meter").setAttribute("aria-valuenow", total ? String(Math.round((100 * progress.received) / total)) : "0");
}

function paintChooser() {
  const remote = view.connection?.mode === "remote";
  element("chooser").hidden = false;
  element("failed").hidden = true;
  element("downloading").hidden = true;
  element("back").hidden = !view.canReturn;
  const now = element("now");
  now.hidden = view.connection === null;
  if (view.connection !== null)
    now.textContent = remote
      ? t("current.remote", { address: view.connection.address })
      : t("current.local");
  if (remote) {
    element("address").value = view.connection.address;
    element("token").placeholder = view.connection.hasToken ? t("tokenSaved") : "";
  }
}

function paintFailed() {
  element("chooser").hidden = true;
  element("downloading").hidden = true;
  element("failed").hidden = false;
  paintFailure(
    { title: element("failed-title"), body: element("failed-body"), detail: element("failed-detail") },
    view.failure,
  );
  const address = view.connection?.address;
  element("failed-address").hidden = !address;
  element("failed-address").textContent = address || "";
}

async function refresh() {
  view = await api("view");
  if (view.language?.toLowerCase().startsWith("zh")) lang = "zh";
  else if (view.language) lang = "en";
  paintWords();
  if (view.screen === "failure") paintFailed();
  else if (view.screen === "download") paintDownload();
  else paintChooser();
}

// A download moves on the view without the page being shown again: this follows it.
setInterval(() => {
  if (view?.screen === "download") void refresh();
}, 500);

element("choose-local").addEventListener("click", async () => {
  if (busy) return;
  element("form-error").hidden = true;
  setBusy(true, "starting");
  const answer = await api("choose", { mode: "local" });
  setBusy(false);
  if (!answer.ok) showError(answer.failure);
});

element("choose-remote").addEventListener("click", () => {
  const open = element("form").hidden;
  element("form").hidden = !open;
  element("choose-remote").setAttribute("aria-expanded", String(open));
  if (open) element("address").focus();
});

// A link is both fields at once, in either field, as on the phone.
for (const id of ["address", "token"]) {
  element(id).addEventListener("input", async (event) => {
    element("form-error").hidden = true;
    const value = event.target.value;
    if (!/^\s*eta:\/\/connect\?/i.test(value)) return;
    const link = await api("link", { text: value });
    if (link === null) return;
    element("address").value = link.address;
    element("token").value = link.token;
  });
}

element("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || element("address").value.trim() === "") return;
  element("form-error").hidden = true;
  setBusy(true, "connecting");
  const answer = await api("choose", {
    mode: "remote",
    address: element("address").value,
    token: element("token").value,
  });
  setBusy(false);
  if (!answer.ok) showError(answer.failure);
});

async function retry(quiet) {
  if (busy) return;
  setBusy(true);
  const answer = await api("retry", {});
  setBusy(false);
  if (answer.ok || quiet) return;
  view.failure = answer.failure;
  paintFailed();
}

element("retry").addEventListener("click", () => void retry(false));
element("change").addEventListener("click", () => void api("chooser", {}));
element("back").addEventListener("click", () => void api("back", {}));

// A host that went away is usually coming back; only a person can fix the other failures.
const COMES_BACK = ["lost", "unreachable", "timeout"];
setInterval(() => {
  if (view?.screen === "failure" && COMES_BACK.includes(view.failure.reason)) void retry(true);
}, 10000);

if (facts.platform === "win32") {
  element("controls").hidden = false;
  for (const node of document.querySelectorAll("[data-window]"))
    node.addEventListener("click", () => {
      void fetch(facts.nativeApiBase + "/api/native/window-action", {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { authorization: "Bearer " + facts.nativeToken, "content-type": "application/json" },
        body: JSON.stringify({ action: node.dataset.window }),
      });
    });
}

void refresh();
`;

/** Static: what changes on it comes from `/api/view`. */
export function shellPage(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>eta</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="band">
      <div id="controls" hidden>
        <button class="window" data-window="minimize" data-label="minimize">&#8211;</button>
        <button class="window" data-window="toggle-maximize" data-label="maximize">&#9633;</button>
        <button class="window" data-window="close" data-label="close">&#215;</button>
      </div>
    </div>
    <main>
      <section id="chooser" hidden>
        <div class="stack">
          <h1 data-word="title"></h1>
          <p id="now" class="quiet" hidden></p>
          <div class="options">
            <button id="choose-local" class="option" type="button">
              <span id="local-title" data-word="local"></span>
              <span class="quiet small" data-word="localHint"></span>
            </button>
            <button id="choose-remote" class="option" type="button" aria-expanded="false" aria-controls="form">
              <span data-word="remote"></span>
              <span class="quiet small" data-word="remoteHint"></span>
            </button>
          </div>
          <form id="form" hidden>
            <label><span data-word="address"></span><input id="address" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
            <label><span data-word="token"></span><input id="token" type="password" autocomplete="off" spellcheck="false" /></label>
            <div id="form-error" role="alert" hidden>
              <p id="form-error-title" class="error"></p>
              <p id="form-error-body" class="quiet small"></p>
              <p id="form-error-detail" class="detail" hidden></p>
            </div>
            <div class="actions"><button id="connect" class="action primary" type="submit" data-word="connect"></button></div>
          </form>
          <p class="quiet small" data-word="independent"></p>
          <div class="actions"><button id="back" class="action" type="button" data-word="back" hidden></button></div>
        </div>
      </section>
      <section id="downloading" hidden>
        <div class="stack">
          <h1 data-word="download.title"></h1>
          <p id="download-version" class="quiet"></p>
          <div id="download-meter" class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-label="download.title"><div id="download-bar"></div></div>
          <p id="download-size" class="quiet small" hidden></p>
          <p class="quiet small" data-word="download.hint"></p>
        </div>
      </section>
      <section id="failed" role="alert" hidden>
        <div class="stack">
          <h1 id="failed-title"></h1>
          <p id="failed-address" class="detail" hidden></p>
          <p id="failed-body" class="quiet"></p>
          <p id="failed-detail" class="detail" hidden></p>
          <div class="actions">
            <button id="retry" class="action primary" type="button" data-word="retry"></button>
            <button id="change" class="action" type="button" data-word="change"></button>
          </div>
        </div>
      </section>
    </main>
    <script id="words" type="application/json">${JSON.stringify(WORDS)}</script>
    <script>${SCRIPT}</script>
  </body>
</html>
`;
}
