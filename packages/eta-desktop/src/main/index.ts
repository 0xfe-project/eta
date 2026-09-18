/**
 * eta's desktop shell.
 *
 * The window connects to the machine's independent eta service. This process owns
 * only window chrome and native capabilities; quitting it leaves sessions running.
 *
 * Three facts the P0 probe (/tmp/eta-p0) established, and this file depends on:
 * a page served from `views://` may open a WebSocket to `127.0.0.1`; `preload` is
 * script *source*, not a path, so the port — which only exists at launch — can be
 * in the page before its first line runs; and a tray image must be black plus
 * alpha, which is why `scripts/tray-icon.ts` draws the mark rather than cropping
 * the logo PNG.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ApplicationMenu, BrowserWindow, PATHS, Tray, Utils, type ApplicationMenuItemConfig } from "electrobun/main";
import type { BackendDescriptor } from "../../../eta-core/src/remote.ts";
import { ensureBackend } from "../../../eta-server/src/service-launcher.ts";
import { startNativeBridge } from "./native-bridge.ts";
import { configureWindowsWindow } from "./platform/windows/index.ts";

const VERSION = "0.1.0";
const CLIENT_DIST = join(PATHS.VIEWS_FOLDER, "eta");
const BACKEND = join(PATHS.VIEWS_FOLDER, "eta-backend", process.platform === "win32" ? "eta-server.exe" : "eta-server");
const isMac = process.platform === "darwin";
let windowRef: BrowserWindow | undefined;

/** The `action` strings the front-end answers; see eta-client/src/lib/native.ts. */
const ACTIONS = {
	toggleSidebar: "view.toggle-sidebar",
	togglePanel: "view.toggle-panel",
	commandPalette: "view.command-palette",
	newSession: "nav.new-session",
	abort: "session.abort",
	compact: "session.compact",
	openFolder: "file.open-folder",
	quit: "app.quit",
} as const;

// The child is detached and claims its own lock; the window never owns sessions.
let descriptor: BackendDescriptor | undefined;
let serviceError: string | undefined;
try {
	descriptor = await ensureBackend({ command: [BACKEND, "serve"], webDist: CLIENT_DIST, version: VERSION });
} catch (error) {
	serviceError = error instanceof Error ? error.message : String(error);
	console.error(`[eta-desktop] ${serviceError}`);
}
const apiBase = descriptor === undefined ? "" : `http://127.0.0.1:${String(descriptor.port)}`;
const credential = descriptor?.token;
const nativeBridge = startNativeBridge({
	async folderDialog(input): Promise<string | null> {
		const picked = await Utils.openFileDialog({
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
			...(input.startingFolder === undefined ? {} : { startingFolder: input.startingFolder }),
		});
		return picked[0] ?? null;
	},
	async saveFile({ content, filename }): Promise<string | null> {
		const target = join(homedir(), ".eta", "exports", filename.replace(/[/\\]/g, "-"));
		await Bun.write(target, content);
		return target;
	},
	/** `views://` has no browser behind it: a link only opens if the shell opens it. */
	openExternal({ url }): void {
		Utils.openExternal(url);
	},
	contextMenu({ items }): void {
		console.log(`[eta-desktop] contextMenu(${String(items.length)} items) is not wired up yet`);
	},
	windowAction({ action }): void {
		const current = windowRef;
		if (current === undefined) return;
		if (action === "minimize") current.minimize();
		else if (action === "toggle-maximize") current.isMaximized() ? current.unmaximize() : current.maximize();
		else current.close();
	},
}, VERSION);

/**
 * In `dev:desk` the vite server is usually up and hot reload beats a rebuild loop.
 * Something else may well own that port, though, so the page is asked whether it
 * is ours — the @font-face in eta-client's index.html is the marker — rather than
 * assumed. This once loaded a different app's UI into an eta window and it looked
 * exactly like eta.
 */
const devUrl = process.env["ETA_CLIENT_URL"] ?? "http://localhost:5173";
const devIsOurs = await fetch(devUrl, { signal: AbortSignal.timeout(400) })
	.then(async (response) => response.ok && (await response.text()).includes("AKRDWGSCNFM-Regular.woff2"))
	.catch(() => false);
const pageUrl = devIsOurs ? devUrl : "views://eta/index.html";

console.log(`[eta-desktop] backend ${apiBase} page=${pageUrl}`);

const window = new BrowserWindow({
	title: "eta",
	url: pageUrl,
	frame: { width: 1240, height: 820 },
	activate: true,
	// macOS keeps its native inset controls. Windows is fully frameless: the page
	// draws the three controls, so there is no native title bar or small icon.
	titleBarStyle: isMac ? "hiddenInset" : "hidden",
	...(isMac ? { trafficLightOffset: { x: 14, y: Number(process.env["ETA_LIGHT_Y"] ?? 5) } } : {}),
	preload: `window.__ETA_HOST__=${JSON.stringify({
		apiBase,
		token: credential,
		platform: process.platform,
		appVersion: VERSION,
		native: true,
		nativeApiBase: nativeBridge.apiBase,
		nativeToken: nativeBridge.token,
		role: descriptor?.role ?? "dev",
		...(serviceError === undefined ? {} : { error: serviceError }),
	})};`,
});
windowRef = window;

if (process.platform === "win32") configureWindowsWindow(window);

/** Menu-bar item; the same actions the window menu would carry. */
const tray = isMac
	? new Tray({ image: "views://eta/tray-18@2x.png", template: true, width: 18, height: 18 })
	: new Tray({ image: "views://eta/Eta-Logo.ico", template: false, width: 16, height: 16 });
tray.setMenu([
	{ type: "normal", label: "新会话", action: ACTIONS.newSession },
	{ type: "normal", label: "切换侧栏", action: ACTIONS.toggleSidebar },
	{ type: "normal", label: "切换右栏", action: ACTIONS.togglePanel },
	{ type: "separator" },
	{ type: "normal", label: "退出 eta", action: ACTIONS.quit },
]);

/**
 * The menu bar, which on macOS is not decoration but the input system.
 *
 * Without an Edit menu, ⌘A/⌘C/⌘V/⌘X/⌘Z typed into eta's composer die in AppKit:
 * those keys are dispatched as main-menu key equivalents into the responder chain
 * (`selectAll:`, `copy:`, `paste:`, `cut:`, `undo:`), and the web content never sees
 * a keydown at all — so nothing on the page can catch them. Hutch has the role →
 * selector map; the only thing missing was somebody calling setApplicationMenu.
 *
 * Two things deliberately absent:
 * - no ⌘↵ item: Cocoa binds ⌘↵ to `insertNewlineIgnoringFieldEditor:`, and the
 *   composer needs that keydown to steer mid-turn;
 * - no ⌘R: reloading is the page's own cmd+R, and a menu item would take it away
 *   from a build whose devtools are how it gets debugged.
 *
 * Every item here has an answer on the other side, which is the test an item has to
 * pass before it gets an accelerator — see the two notes inside for where the answer
 * is conditional on the view.
 */
const macAppMenu: ApplicationMenuItemConfig = {
	label: "eta",
	submenu: [
		{ role: "about", label: "关于 eta", accelerator: "" },
		{ type: "divider" },
		{ role: "hide", label: "隐藏 eta", accelerator: "CommandOrControl+H" },
		{ role: "hideOthers", label: "隐藏其他", accelerator: "CommandOrControl+Option+H" },
		{ role: "showAll", label: "全部显示", accelerator: "" },
		{ type: "divider" },
		{ role: "quit", label: "退出 eta", accelerator: "CommandOrControl+Q" },
	],
};

const APP_MENU: ApplicationMenuItemConfig[] = [
	...(isMac ? [macAppMenu] : []),
	{
		label: "会话",
		submenu: [
			{ label: "新会话", action: ACTIONS.newSession, accelerator: "CommandOrControl+Shift+O" },
			/* Answered by the new-session page, which owns a folder; from another view the
			   item is inert rather than opening a dialog over something that cannot take it. */
			{ label: "打开文件夹…", action: ACTIONS.openFolder, accelerator: "CommandOrControl+O" },
			{ type: "divider" },
			{ label: "中止回合", action: ACTIONS.abort, accelerator: "CommandOrControl+Period" },
			{ label: "压缩上下文", action: ACTIONS.compact, accelerator: "CommandOrControl+Shift+C" },
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
			{ role: "pasteAndMatchStyle", label: "粘贴并匹配样式", accelerator: isMac ? "CommandOrControl+Shift+Option+V" : "CommandOrControl+Shift+V" },
			{ role: "delete", label: "删除", accelerator: "CommandOrControl+Backspace" },
			{ type: "divider" },
			{ role: "selectAll", label: "全选", accelerator: "CommandOrControl+A" },
		],
	},
	{
		label: "视图",
		submenu: [
			{ label: "命令面板", action: ACTIONS.commandPalette, accelerator: "CommandOrControl+K" },
			{ label: "切换侧栏", action: ACTIONS.toggleSidebar, accelerator: "CommandOrControl+B" },
			{ label: "切换右栏", action: ACTIONS.togglePanel, accelerator: "CommandOrControl+Shift+B" },
			{ type: "divider" },
			{ role: "toggleFullScreen", label: "全屏幕", accelerator: isMac ? "Control+Command+F" : "F11" },
		],
	},
	{
		label: "窗口",
		submenu: [
			{ role: "minimize", label: "最小化", accelerator: "CommandOrControl+M" },
			{ role: "zoom", label: "缩放", accelerator: "" },
			{ type: "divider" },
			{ role: "close", label: "关闭", accelerator: "CommandOrControl+W" },
			...(isMac ? [{ role: "bringAllToFront", label: "全部置于前端", accelerator: "" } satisfies ApplicationMenuItemConfig] : []),
		],
	},
];

/**
 * Menu clicks arrive as `{action}`; the tray wraps the item's payload one level
 * deeper, so both shapes are read rather than one of them assumed.
 */
function actionOf(event: unknown): string | undefined {
	const data = (event as { data?: { action?: string; data?: { action?: string } } }).data;
	return data?.action ?? data?.data?.action;
}

function runAction(action: string, kind: "menu" | "tray"): void {
	if (action === ACTIONS.quit) {
		process.exit(0);
		return;
	}
	// Window actions belong to this client, not every subscriber of the shared backend.
	window.webview.executeJavascript(`window.__etaNative?.(${JSON.stringify({ kind, action })})`);
}

if (isMac) ApplicationMenu.setApplicationMenu(APP_MENU);
ApplicationMenu.on("application-menu-clicked", (event) => {
	const action = actionOf(event);
	if (action !== undefined) runAction(action, "menu");
});

tray.on("tray-clicked", (event) => {
	const action = actionOf(event);
	if (action !== undefined) runAction(action, "tray");
});

// Only the window-local capability bridge stops here. The backend has its own PID.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => process.exit(0));
}
process.on("exit", () => {
	tray.remove();
	nativeBridge.close();
});
