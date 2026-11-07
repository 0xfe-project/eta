/**
 * The desktop shell. Opening the app shows a host's page: its own, or one the user connected to.
 *
 * The user decides which, on the shell's own page the first time and from Settings after that, and
 * `shell.ts` holds the rules for moving between them. In **local** mode the host (`apps/eta`) runs
 * here, the whole product in one Bun process: the page, the database and the socket live behind
 * its one port. This process finds a free port, starts that one, and points the window at it. With
 * no built page (`apps/web/dist`) the host serves the socket only and the window says so. In
 * **remote** mode no host runs here and the window loads the remote one's page; nothing of the two
 * modes' data is shared or moved.
 *
 * The host lives as long as the app, not as long as a window: closing the window is closing a
 * window (Dock click brings it back), and quitting the app or switching to remote is what stops
 * the host.
 *
 * Three things sit beside the host in this process, and all are the window's, not the product's:
 *
 * - the **capability bridge** (`native.ts`): a loopback port that answers save dialogs, the
 *   system browser, window buttons. It exists so the page can do what a page cannot, and it answers
 *   whichever page the window shows, a remote one included.
 * - the **shell's page** (`shell-server.ts`, `shell-page.ts`): where the host is chosen and where
 *   a host that cannot be shown is explained. It is the only page that can touch the connection.
 * - the **preload**: the one script that runs in the page before any of its own code. `preload` is
 *   script *source*, not a path, which is the only reason the bridge's port — which does not exist
 *   until this process has started — can be in the page before its first line runs.
 *
 * What the page learns about itself arrives that way, as `window.__ETA_HOST__`
 * (see `apps/web/src/lib/native.ts`). Three facts worth stating here: no page is given a host's
 * token, because a remote page gets a cookie for it from the host and a loopback host has no token
 * gate; `role` says what the shell is — `desktop` when the app carries a host (`host/`, a compiled
 * binary staged by `scripts/stage-host.ts`), `dev` when it runs one out of the checkout above it;
 * and `connection` says `local` or `remote`, with `address` for the latter.
 *
 * The window is the app's own, not a browser's: it has no system title bar, and the 40px band the
 * page draws across its top *is* the title bar — the page's band carries the drag region and, on
 * macOS, the three lights are inset into it. The platform that keeps native corner buttons
 * (macOS) and the one that has to have them painted by the page (Windows) differ only in that;
 * see `platform/windows/index.ts` for what a frameless window costs there.
 *
 * The menu bar is this process's too, and on macOS it is input before it is decoration: ⌘C/⌘V and
 * their neighbours are main-menu key equivalents, so a shell with no Edit menu has no copy and
 * paste anywhere in the app. The menu is installed below, all of it roles.
 */
import type { ApplicationMenuItemConfig } from "electrobun/main";
import type { HostLaunch, View } from "./shell";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import Electrobun, {
  ApplicationMenu,
  BrowserWindow,
  ContextMenu,
  Utils,
} from "electrobun/main";
import { readConnection, writeConnection } from "./connection";
import { HOST_WRAPPER } from "./host";
import { startNativeBridge } from "./native";
import { configureWindowsWindow } from "./platform/windows";
import { pagePreload, relayedRequest, relayToBridge } from "./preload";
import { probeRemote, remoteHealth, watchRemote } from "./remote";
import { createShell } from "./shell";
import { startShellServer } from "./shell-server";

/** Kept in step with package.json and electrobun.config.ts; the page may show it. */
const APP_VERSION = "0.1.0";

/** What an executable's name ends in here. */
const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * The menu bar, which on macOS is the input system rather than decoration.
 *
 * ⌘A/⌘C/⌘V/⌘X/⌘Z in the composer are not keydowns first: AppKit dispatches them as main-menu key
 * equivalents into the responder chain (`selectAll:`, `copy:`, `paste:`, `cut:`, `undo:`). With no
 * Edit menu there is no chain, so the web content never sees a keydown and nothing on the page can
 * catch them — which is why ⌘C/⌘V died in the composer and no JS could bring them back.
 *
 * Electrobun only supplies the role → selector mapping; installing the menu is this file's job.
 * Every item below is a `role`, so every click has a native answer waiting on the other side.
 * An item with an `action` would be a button that does nothing: a menu click fires in *this*
 * process, and nothing yet carries it into the page — the bridge runs the other way (the page
 * asks, this process answers). New session, toggle sidebar, command palette, abort and compact
 * wait for a channel that runs main → page.
 *
 * Two things deliberately absent:
 * - no ⌘↵ item: Cocoa binds it to `insertNewlineIgnoringFieldEditor:`, and the composer needs that
 *   keydown to steer mid-turn;
 * - no ⌘R: reloading is the page's own cmd+R, and a menu item would take it away from a build
 *   whose devtools are how it gets debugged.
 */
const APP_MENU: ApplicationMenuItemConfig[] = [
  {
    label: "eta",
    submenu: [
      { role: "about", label: "关于 eta", accelerator: "" },
      { type: "divider" },
      { role: "hide", label: "隐藏 eta", accelerator: "CommandOrControl+H" },
      {
        role: "hideOthers",
        label: "隐藏其他",
        accelerator: "CommandOrControl+Option+H",
      },
      { role: "showAll", label: "全部显示", accelerator: "" },
      { type: "divider" },
      { role: "quit", label: "退出 eta", accelerator: "CommandOrControl+Q" },
    ],
  },
  {
    label: "编辑",
    submenu: [
      { role: "undo", label: "撤销", accelerator: "CommandOrControl+Z" },
      { role: "redo", label: "重做", accelerator: "CommandOrControl+Shift+Z" },
      { type: "divider" },
      { role: "cut", label: "剪切", accelerator: "CommandOrControl+X" },
      { role: "copy", label: "拷贝", accelerator: "CommandOrControl+C" },
      { role: "paste", label: "粘贴", accelerator: "CommandOrControl+V" },
      {
        role: "pasteAndMatchStyle",
        label: "粘贴并匹配样式",
        accelerator: "CommandOrControl+Shift+Option+V",
      },
      {
        role: "delete",
        label: "删除",
        accelerator: "CommandOrControl+Backspace",
      },
      { type: "divider" },
      { role: "selectAll", label: "全选", accelerator: "CommandOrControl+A" },
    ],
  },
  {
    label: "视图",
    // Only full screen: anything else here would need an action the page cannot hear yet.
    submenu: [
      {
        role: "toggleFullScreen",
        label: "全屏幕",
        accelerator: "Control+Command+F",
      },
    ],
  },
  {
    label: "窗口",
    submenu: [
      { role: "minimize", label: "最小化", accelerator: "CommandOrControl+M" },
      { role: "zoom", label: "缩放", accelerator: "" },
      { type: "divider" },
      { role: "close", label: "关闭", accelerator: "CommandOrControl+W" },
      { role: "bringAllToFront", label: "全部置于前端", accelerator: "" },
    ],
  },
];

// Windows keeps its default: WebView2 handles Ctrl+C/V itself, and a menu with no responder chain
// behind it would only be decoration that claims accelerators.
if (process.platform === "darwin") ApplicationMenu.setApplicationMenu(APP_MENU);

/**
 * The host the app carries: the compiled host in `host/`, beside the main process's bundle. Only
 * a packaged build has one — `build.copy` never lands in the dev bundle.
 */
function packagedHost(): string | undefined {
  const dir = join(dirname(Bun.main), "..", "host");
  const file = join(dir, `eta-host${EXE}`);
  return existsSync(file) ? file : undefined;
}

const packaged = packagedHost();

/**
 * PATH as the user's login shell has it.
 *
 * An app opened from Finder or the Dock inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * not the one the user's terminal builds, and the host hands its PATH on to everything it runs:
 * the bash tool, git, an MCP server started with `node` or `bunx`. Asked once, at launch; a
 * shell that does not answer within five seconds leaves PATH as it was.
 */
async function loginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const { SHELL } = process.env;
  const marker = "__ETA_PATH__";
  try {
    const child = Bun.spawn(
      [SHELL ?? "/bin/zsh", "-ilc", `printf '${marker}%s' "$PATH"`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => child.kill(), 5_000);
    const output = await new Response(child.stdout).text();
    clearTimeout(timer);
    const at = output.lastIndexOf(marker);
    const path = at === -1 ? "" : output.slice(at + marker.length).trim();
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
}

/** The repository root: the directory holding `apps/eta` and `apps/web`, found by walking up. */
function repoRoot(): string {
  // Dev bundles the main process inside build/<app>.app, so the root can sit many levels up.
  let dir = dirname(Bun.main);
  for (;;) {
    if (existsSync(join(dir, "apps", "eta", "src", "main.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cannot find the repository root above ${Bun.main}: expected apps/eta/src/main.ts`,
  );
}

/** `bun` beside this runtime when there is one, else whatever `bun` is on PATH. */
function bunBinary(): string {
  const beside = join(dirname(process.execPath), `bun${EXE}`);
  return existsSync(beside) ? beside : "bun";
}

/**
 * The port the host actually bound, read from a file rather than its stdout.
 *
 * The Electrobun launcher owns this process's stdout for its own protocol, so a pipe off the
 * host does not arrive as the host wrote it. The host prints one JSON summary first; a wrapper
 * keeps that line and lets the rest through.
 */
async function boundPort(file: string, child: Bun.Subprocess): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes("\n")) {
      return (JSON.parse(text.slice(0, text.indexOf("\n"))) as { port: number })
        .port;
    }
    // `await child.exited` would wait for the host to exit; only its exitCode is a question now.
    if (child.exitCode !== null) {
      throw new Error(
        `the host exited with ${child.exitCode} before it was ready`,
      );
    }
    if (Date.now() > deadline)
      throw new Error("the host was not ready after 20s");
    await Bun.sleep(100);
  }
}

let current: BrowserWindow | undefined;
let host: Bun.Subprocess | undefined;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The dev page, which comes with a host of its own: `bun run dev --desktop` starts both. */
const { ETA_DESKTOP_WEB_URL } = process.env;
const devPage = ETA_DESKTOP_WEB_URL?.trim();
const developing = devPage !== undefined && devPage !== "";

/**
 * Start the host and learn the port it bound.
 *
 * A failure here is a window's answer, not a process's exit: the two ways it goes wrong (no
 * host carried and no checkout above us, no host within twenty seconds) both come back as the reason the page is
 * missing, so the window can open and say it. Quitting on `process.exit` left the user with an
 * app that flashed and vanished.
 */
async function startHost(): Promise<HostLaunch> {
  if (developing) {
    try {
      const url = new URL(devPage);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("only http(s) pages are supported");
      return { ready: true, page: url.href };
    } catch (error) {
      return {
        ready: false,
        reason: `ETA_DESKTOP_WEB_URL is not a usable page: ${reasonOf(error)}`,
      };
    }
  }

  // The app's own host, else the checkout's: `bun apps/eta/src/main.ts`, with the page when it
  // has been built and the dev server's origin let in when it has not.
  let command: string[];
  let cwd: string;
  let built: boolean;
  if (packaged !== undefined) {
    command = [packaged];
    cwd = homedir();
    built = true;
  } else {
    let root: string;
    try {
      root = repoRoot();
    } catch (error) {
      return { ready: false, reason: reasonOf(error) };
    }
    built = existsSync(join(root, "apps", "web", "dist", "index.html"));
    command = [
      bunBinary(),
      "apps/eta/src/main.ts",
      ...(built
        ? ["--web-dir", "apps/web/dist"]
        : ["--allow-origin", "http://127.0.0.1:3000"]),
    ];
    cwd = root;
  }
  const path = packaged === undefined ? undefined : await loginShellPath();

  const runtime = join(tmpdir(), "eta-desktop");
  await mkdir(runtime, { recursive: true });
  const summary = join(runtime, "host.json");
  await rm(summary, { force: true });

  // A file import is bundled inline and build.copy never lands in the dev bundle, so the script
  // bun runs is written out from this string. It is src/bun/host.ts; keep the two the same.
  const wrapper = join(runtime, "host.ts");
  await Bun.write(wrapper, HOST_WRAPPER);

  host = Bun.spawn(
    // Port 0: the host picks a free port and says which in its summary.
    [bunBinary(), wrapper, ...command, "--port", "0", "--github"],
    // The host keeps its data in ~/.eta; HOME is the only way to point it elsewhere.
    {
      cwd,
      env: {
        ...process.env,
        ...(path === undefined ? {} : { PATH: path }),
        ETA_DESKTOP_SUMMARY: summary,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  try {
    const port = await boundPort(summary, host);
    return {
      // The built page is served by the host itself, so the window and the socket share one
      // origin. Without a build there is only the shell's own placeholder.
      page: built
        ? `http://127.0.0.1:${String(port)}`
        : "views://mainview/index.html",
      port,
      ready: true,
    };
  } catch (error) {
    await stopLocalHost();
    return { ready: false, reason: reasonOf(error) };
  }
}

/** Stop the host and wait for it: it holds the database until it has gone. */
async function stopLocalHost(): Promise<void> {
  const closing = host;
  host = undefined;
  if (closing === undefined) return;
  closing.kill("SIGTERM");
  const exited = closing.exited;
  const gaveUp = new Promise((resolve) =>
    setTimeout(resolve, 5_000, "timeout"),
  );
  if ((await Promise.race([exited, gaveUp])) === "timeout")
    closing.kill("SIGKILL");
}

/**
 * A context-menu row that was chosen belongs to the page that asked for the menu: it goes back
 * there as an `eta:native` event, the same shape the menu bar and the tray use for their actions.
 */
ContextMenu.on("context-menu-clicked", (event) => {
  const data = (
    event as {
      data?: { action?: string; data?: { action?: string } };
    }
  ).data;
  const action = data?.action ?? data?.data?.action;
  if (action === undefined || action === "") return;
  current?.webview.executeJavascript(
    `window.__etaNative?.(${JSON.stringify({ kind: "context-menu", action })});`,
  );
});

/** The origin of an http page, or nothing: `views://` and friends are not origins a page has. */
function httpOrigin(url: string): string | undefined {
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed.origin
    : undefined;
}

/** The origin a view's page will have. */
const originOf = (view: View): string | undefined =>
  view.screen === "page" ? httpOrigin(view.page) : pages.origin;

/**
 * The capability bridge starts before there is a page, so it starts answering nothing: `show`
 * tells it the origin of each page the window is given, and no origin before or after that one.
 * A page that is not served over http (the shell's placeholder for a missing build) has no origin
 * to whitelist, and the bridge then answers no page.
 */
const bridge = startNativeBridge({
  appVersion: APP_VERSION,
  origins: [],
  platform: process.platform,
  handlers: {
    async saveFile({ content, filename }) {
      // Electrobun has no save panel: the honest closest thing is to ask for a directory and
      // write the file there, rather than put it somewhere the user did not point at.
      const picked = await Utils.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      const directory = picked[0];
      if (directory === undefined) return null;
      const target = join(directory, filename.replace(/[/\\]/g, "-"));
      await Bun.write(target, content);
      return target;
    },
    /** A webview has no browser behind it: a link only opens if the shell opens it. */
    openExternal({ url }) {
      Utils.openExternal(url);
    },
    contextMenu({ items }) {
      ContextMenu.showContextMenu(
        items.map((item) =>
          item.divider === true
            ? { type: "divider" }
            : { type: "normal", label: item.label, action: item.action ?? "" },
        ),
      );
    },
    windowAction({ action, language }) {
      if (action === "connection") {
        shell.openChooser(language);
        return;
      }
      const window = current;
      if (window === undefined) return;
      if (action === "minimize") window.minimize();
      else if (action === "toggle-maximize")
        window.isMaximized() ? window.unmaximize() : window.maximize();
      else window.close();
    },
  },
});

// An `https` page's bridge calls, which reach this process as messages (see `preload.ts`).
Electrobun.events.on("host-message", (event) => {
  const { detail } = (event as { data: { detail: unknown } }).data;
  const request = relayedRequest(detail);
  if (request === undefined) return;
  void relayToBridge(bridge.apiBase, request).then(
    (answer) => {
      current?.webview.executeJavascript(answer);
    },
    () => {},
  );
});

/**
 * The page's first fact about itself. `preload` is source, so the bridge's port — which only
 * exists now — is already on `window` before the page's first line runs. The bridge token is in
 * there too; it is a secret of this launch and belongs in the page and nowhere else: never log it,
 * never put it in a message. The shell's page also gets the token of the connection calls, which
 * is why a window's preload is written for the view it shows.
 */
function preloadFor(view: View): string {
  const { connection } = view;
  return pagePreload({
    origin: originOf(view),
    facts: {
      apiBase:
        view.screen !== "page"
          ? undefined
          : view.port === undefined
            ? httpOrigin(view.page)
            : `http://127.0.0.1:${String(view.port)}`,
      platform: process.platform,
      appVersion: APP_VERSION,
      native: true,
      nativeApiBase: bridge.apiBase,
      nativeToken: bridge.token,
      role: packaged === undefined ? "dev" : "desktop",
      // The dev page has no connection to change, so it hears about none.
      ...(developing || connection === undefined
        ? {}
        : {
            connection: connection.mode,
            ...(connection.mode === "remote"
              ? { address: connection.address }
              : {}),
          }),
      ...(view.screen === "failure" && view.failure.reason === "host"
        ? { error: view.failure.detail }
        : {}),
    },
    ...(view.screen === "page" ? {} : { shellToken: pages.token }),
  });
}

const isMac = process.platform === "darwin";
const DEFAULT_FRAME = { width: 1280, height: 800 };

/**
 * What the window is called.
 *
 * Nothing on macOS depends on it, and three things on Windows do: a frameless window cannot be
 * resized by, squared off, or given an icon through Electrobun's API, so each of those patches
 * (`platform/windows/`) reaches the native handle the only way it can — `FindWindowA(null, title)`.
 * Rename the window and all three go looking for a window that is not there. Keep this string and
 * those patches in step.
 */
const WINDOW_TITLE = "eta";

/**
 * Where the three lights sit inside our 40px band.
 *
 * `x` is the band's own inset, fixed: the lights have to start where the page's lights slot
 * starts, and the slot is 68px wide (`apps/web/src/styles.css`). `y` is tunable from the
 * environment because the light's diameter is AppKit's choice, not ours — the band's height is
 * ours, and the two only line up by eye (`ETA_LIGHT_Y=7` for a deeper seat).
 */
const LIGHT_INSET_X = 14;
const lightInsetY = (): number => {
  // Destructured rather than read as a property: `process.env` is an index signature, and the
  // dot-notation that reads nicer here is exactly what the type system refuses.
  const { ETA_LIGHT_Y } = process.env;
  const value = Number(ETA_LIGHT_Y ?? 5);
  return Number.isFinite(value) ? value : 5;
};

/**
 * The window, and the only place its chrome is decided.
 *
 * `titleBarStyle`: macOS keeps its own lights but hides the bar they came in (`hiddenInset`), so
 * the page starts at the top of the window and there is one band rather than a system bar above
 * ours. Everywhere else the bar is hidden outright (`hidden`) — Windows has no inset controls to
 * keep, so the page draws all three buttons itself.
 */
function open(view: View, frame = DEFAULT_FRAME): BrowserWindow {
  const created = new BrowserWindow({
    title: WINDOW_TITLE,
    url: view.screen === "page" ? view.page : pages.origin,
    frame,
    preload: preloadFor(view),
    // A window opened by the app is the app's window: bring it forward, do not open it behind.
    activate: true,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightOffset: { x: LIGHT_INSET_X, y: lightInsetY() } }
      : {}),
  });
  created.on("close", () => {
    if (current === created) current = undefined;
  });
  // Windows pays for the missing title bar in three places; none of them are Electrobun's.
  if (process.platform === "win32") void configureWindowsWindow(created);
  return created;
}

/**
 * Put a view in the window. A preload cannot be changed once a webview has it, and what it says
 * differs from view to view, so a new view is a new window, in the place of the old one. Closed
 * first: the Windows patches find a window by its title, and there must be only one.
 *
 * With the window closed there is nothing to replace, and asking for it back opens this view. A
 * host that goes away behind a closed window does not get to open one.
 */
let shown: View | undefined;
function show(view: View): void {
  const origin = originOf(view);
  bridge.setOrigins(origin === undefined ? [] : [origin]);
  const first = shown === undefined;
  shown = view;
  const replaced = current;
  if (replaced === undefined && !first) return;
  const frame = replaced?.getFrame();
  current = undefined;
  replaced?.close();
  current = open(view, frame);
}

/**
 * The app answers the first launch's question itself in two cases: the dev page brings its own
 * host, and the release's smoke test (`scripts/try-app.ts`) has nobody at the window. Neither
 * touches what a user chose.
 */
const { ETA_DESKTOP_CONNECTION } = process.env;
const decided = developing || ETA_DESKTOP_CONNECTION === "local";
const connectionFile = join(Utils.paths.userData, "connection.json");
const shell = createShell({
  read: async () =>
    decided ? { mode: "local" } : await readConnection(connectionFile),
  save: async (connection) => {
    if (!decided) await writeConnection(connectionFile, connection);
  },
  startHost,
  stopHost: stopLocalHost,
  probe: probeRemote,
  watch: (target, onLost) =>
    watchRemote({ health: () => remoteHealth(target), onLost }),
  show,
});

const pages = startShellServer({
  view: () => shell.current(),
  choose: (choice) => shell.choose(choice),
  retry: () => shell.retry(),
  openChooser: () => {
    shell.openChooser();
  },
  back: () => {
    shell.back();
  },
});

await shell.boot();

// A Dock click on a windowless app asks for its window back.
Electrobun.events.on("reopen", () => {
  if (current?.isVisible()) {
    current.activate();
    return;
  }
  if (shown !== undefined) current = open(shown);
});

/** Quitting stops everything this process started: its sessions flush, its files close. */
let stopping = false;
async function stopAll(): Promise<void> {
  if (stopping) return;
  stopping = true;
  shell.close();
  pages.close();
  bridge.close();
  await stopLocalHost();
}

Electrobun.events.on("before-quit", (event) => {
  if (stopping) return;
  // The emitter does not await; refuse this quit, stop the host, then ask again.
  (event as { response?: { allow: boolean } }).response = { allow: false };
  void stopAll().then(() => Electrobun.Utils.quit());
});

process.on("SIGINT", () => void stopAll().then(() => process.exit(0)));
process.on("SIGTERM", () => void stopAll().then(() => process.exit(0)));
