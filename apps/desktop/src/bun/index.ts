/**
 * The desktop shell. Opening the app starts the host and shows its page.
 *
 * The host (`apps/eta`) is the whole product in one Bun process: the page, the database and the
 * socket live behind its one port. This process finds a free port, starts that one, and points
 * the window at it. With no built page (`apps/web/dist`) the host serves the socket only and the
 * window says so.
 *
 * The host lives as long as the app, not as long as a window: closing the window is closing a
 * window (Dock click brings it back), and quitting the app is what stops the host.
 *
 * Two things sit beside the host in this process, and both are the window's, not the product's:
 *
 * - the **capability bridge** (`native.ts`): a loopback port that answers folder dialogs, the
 *   system browser, window buttons. It exists so the page can do what a page cannot.
 * - the **preload**: the one script that runs in the page before any of its own code. `preload` is
 *   script *source*, not a path, which is the only reason the bridge's port — which does not exist
 *   until this process has started — can be in the page before its first line runs.
 *
 * What the page learns about itself arrives that way, as `window.__ETA_HOST__`
 * (see `apps/web/src/lib/native.ts`). Two facts worth stating here: there is no `token` when the
 * host listens on loopback only, because a loopback host has no token gate; and `role` is `dev`
 * for as long as the shell runs the host out of a checkout — a packaged build, which ships the
 * host as a binary beside the app, will say `desktop`.
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
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import Electrobun, {
  ApplicationMenu,
  BrowserWindow,
  ContextMenu,
  Utils,
} from "electrobun/main";
import { failurePage } from "./failure";
import { HOST_WRAPPER } from "./host";
import { startNativeBridge } from "./native";
import { configureWindowsWindow } from "./platform/windows";

/** Kept in step with package.json and electrobun.config.ts; the page may show it. */
const APP_VERSION = "0.1.0";

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
  const beside = join(dirname(process.execPath), "bun");
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

/** What the window has to show, or why it has nothing to show. */
type Launch =
  | { ready: true; page: string; port?: number }
  | { ready: false; reason: string };

let current: BrowserWindow | undefined;
let host: Bun.Subprocess | undefined;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Start the host and learn the port it bound.
 *
 * A failure here is a window's answer, not a process's exit: the two ways it goes wrong (no
 * checkout above us, no host within twenty seconds) both come back as the reason the page is
 * missing, so the window can open and say it. Quitting on `process.exit` left the user with an
 * app that flashed and vanished.
 */
async function startHost(): Promise<Launch> {
  const { ETA_DESKTOP_WEB_URL } = process.env;
  const devPage = ETA_DESKTOP_WEB_URL?.trim();
  if (devPage !== undefined && devPage !== "") {
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

  let root: string;
  try {
    root = repoRoot();
  } catch (error) {
    return { ready: false, reason: reasonOf(error) };
  }
  const built = existsSync(join(root, "apps", "web", "dist", "index.html"));

  const runtime = join(tmpdir(), "eta-desktop");
  await mkdir(runtime, { recursive: true });
  const summary = join(runtime, "host.json");
  await rm(summary, { force: true });

  // A file import is bundled inline and build.copy never lands in the dev bundle, so the script
  // bun runs is written out from this string. It is src/bun/host.ts; keep the two the same.
  const wrapper = join(runtime, "host.ts");
  await Bun.write(wrapper, HOST_WRAPPER);

  host = Bun.spawn(
    [
      bunBinary(),
      wrapper,
      bunBinary(),
      "apps/eta/src/main.ts",
      // Port 0: the host picks a free port and says which in its summary.
      "--port",
      "0",
      "--github",
      ...(built
        ? ["--web-dir", "apps/web/dist"]
        : ["--allow-origin", "http://127.0.0.1:3000"]),
    ],
    // The host keeps its data in ~/.eta; HOME is the only way to point it elsewhere.
    {
      cwd: root,
      env: { ...process.env, ETA_DESKTOP_SUMMARY: summary },
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
    host.kill();
    return { ready: false, reason: reasonOf(error) };
  }
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

const launch = await startHost();

// The page's own origin is the only origin the capability bridge answers, and it is not knowable
// before the host has bound its port — hence the bridge starts here, not at the top. A page that
// is not served over http (the shell's own placeholder, or nothing at all when the host failed)
// has no origin to whitelist: the bridge then answers no page.
const pageOrigin = launch.ready ? httpOrigin(launch.page) : undefined;
const bridge = startNativeBridge({
  appVersion: APP_VERSION,
  origins: pageOrigin === undefined ? [] : [pageOrigin],
  platform: process.platform,
  handlers: {
    async folderDialog({ startingFolder }) {
      const picked = await Utils.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
        ...(startingFolder === undefined ? {} : { startingFolder }),
      });
      return picked[0] ?? null;
    },
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
    windowAction({ action }) {
      const shell = current;
      if (shell === undefined) return;
      if (action === "minimize") shell.minimize();
      else if (action === "toggle-maximize")
        shell.isMaximized() ? shell.unmaximize() : shell.maximize();
      else shell.close();
    },
  },
});

/**
 * The page's first fact about itself. `preload` is source, so the bridge's port — which only
 * exists now — is already on `window` before the page's first line runs. The bridge token is in
 * there too; it is a secret of this launch and belongs in the page and nowhere else: never log it,
 * never put it in a message.
 */
const preload = `window.__ETA_HOST__=${JSON.stringify({
  apiBase:
    launch.ready && launch.port !== undefined
      ? `http://127.0.0.1:${String(launch.port)}`
      : undefined,
  platform: process.platform,
  appVersion: APP_VERSION,
  native: true,
  nativeApiBase: bridge.apiBase,
  nativeToken: bridge.token,
  role: "dev",
  ...(launch.ready ? {} : { error: launch.reason }),
})};`;

const isMac = process.platform === "darwin";

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
function open(): BrowserWindow {
  const created = new BrowserWindow({
    title: WINDOW_TITLE,
    // No host, no page: the shell's own page carries the reason instead of the app vanishing.
    ...(launch.ready
      ? { url: launch.page }
      : { html: failurePage(launch.reason) }),
    frame: { width: 1280, height: 800 },
    preload,
    // A window opened by the app is the app's window: bring it forward, do not open it behind.
    activate: true,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightOffset: { x: LIGHT_INSET_X, y: lightInsetY() } }
      : {}),
  });
  // Windows pays for the missing title bar in three places; none of them are Electrobun's.
  if (process.platform === "win32") void configureWindowsWindow(created);
  return created;
}

current = open();

// A Dock click on a windowless app asks for its window back.
Electrobun.events.on("reopen", () => {
  if (current?.isVisible()) {
    current.activate();
    return;
  }
  current = open();
});

/** Quitting is the one thing that stops the host: its sessions flush, its files close. */
let stopping = false;
async function stopHost(): Promise<void> {
  if (stopping) return;
  stopping = true;
  bridge.close();
  const closing = host;
  if (closing === undefined) return;
  closing.kill("SIGTERM");
  const exited = closing.exited;
  const gaveUp = new Promise((resolve) =>
    setTimeout(resolve, 5_000, "timeout"),
  );
  if ((await Promise.race([exited, gaveUp])) === "timeout")
    closing.kill("SIGKILL");
}

Electrobun.events.on("before-quit", (event) => {
  if (stopping) return;
  // The emitter does not await; refuse this quit, stop the host, then ask again.
  (event as { response?: { allow: boolean } }).response = { allow: false };
  void stopHost().then(() => Electrobun.Utils.quit());
});

process.on("SIGINT", () => void stopHost().then(() => process.exit(0)));
process.on("SIGTERM", () => void stopHost().then(() => process.exit(0)));
