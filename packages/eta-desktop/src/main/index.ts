/**
 * eta's desktop shell.
 *
 * The eta server runs inside this process and the webview loads the built
 * eta-client, so the shell adds exactly two things a browser tab cannot have:
 * the window chrome, and the native capabilities behind `/api/native/*`.
 *
 * Three facts the P0 probe (/tmp/eta-p0) established, and this file depends on:
 * a page served from `views://` may open a WebSocket to `127.0.0.1`; `preload` is
 * script *source*, not a path, so the port — which only exists at launch — can be
 * in the page before its first line runs; and a tray image must be black plus
 * alpha, which is why `scripts/tray-icon.ts` draws the mark rather than cropping
 * the logo PNG.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType } from "bun:ffi";
import { ApplicationMenu, BrowserWindow, PATHS, Tray, Utils, type ApplicationMenuItemConfig } from "electrobun/main";
import { startServer, type EtaServer, type NativeHandlers } from "../../../eta-server/src/server.ts";

const VERSION = "0.1.0";
const CLIENT_DIST = fileURLToPath(new URL("../../eta-client/dist", import.meta.url));
const isMac = process.platform === "darwin";

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

const token = crypto.randomUUID().replaceAll("-", "");
let windowRef: BrowserWindow | undefined;

const server: EtaServer = await startServer({
	settingsToken: token,
	// Random port, loopback only: `dev:web` may already hold 3000 with SO_REUSEPORT,
	// and the shell tells the page where it is through the preload anyway.
	port: 0,
	hostname: "127.0.0.1",
	reusePort: false,
	webDist: CLIENT_DIST,
	platform: process.platform,
	appVersion: VERSION,
	native: {
		async folderDialog(input): Promise<string | null> {
			const picked = await Utils.openFileDialog({
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
				...(input.startingFolder === undefined ? {} : { startingFolder: input.startingFolder }),
			});
			return picked[0] ?? null;
		},
		/** Hutch has no save dialog yet, so exports land somewhere findable. */
		async saveFile({ content, filename }): Promise<string | null> {
			const target = join(homedir(), ".eta", "exports", filename.replace(/[/\\]/g, "-"));
			await Bun.write(target, content);
			return target;
		},
		windowAction({ action }): void {
			const current = windowRef;
			if (current === undefined) return;
			if (action === "minimize") current.minimize();
			else if (action === "toggle-maximize") current.isMaximized() ? current.unmaximize() : current.maximize();
			else current.close();
		},
		contextMenu({ items }): void {
			console.log(`[eta-desktop] contextMenu(${String(items.length)} items) is not wired up yet`);
		},
	} satisfies NativeHandlers,
});

const apiBase = `http://127.0.0.1:${String(server.port)}`;
/** Settings requests carry the preload credential as an Authorization header. */

const health = await fetch(`${apiBase}/api/health`).then((response) => response.status).catch(() => 0);

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

console.log(`[eta-desktop] server ${apiBase} health=${String(health)} page=${pageUrl}`);

const window = new BrowserWindow({
	title: "eta",
	url: pageUrl,
	frame: { width: 1240, height: 820 },
	activate: true,
	// macOS keeps its native inset controls. Windows is fully frameless: the page
	// draws the three controls, so there is no native title bar or small icon.
	titleBarStyle: isMac ? "hiddenInset" : "hidden",
	...(isMac ? { trafficLightOffset: { x: 14, y: Number(process.env["ETA_LIGHT_Y"] ?? 5) } } : {}),
	preload: `window.__ETA_HOST__=${JSON.stringify({ apiBase, token, platform: process.platform, appVersion: VERSION })};`,
});

/** Set the HWND icon directly: Electrobun's wrapper does not reach this window. */
function setWindowIcon(_target: BrowserWindow): void {
	if (process.platform !== "win32") return;
	const iconPath = join(PATHS.VIEWS_FOLDER, "eta", "Eta-Logo.ico");
	if (!existsSync(iconPath)) return;
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowA: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
			LoadImageA: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		});
		const title = Buffer.from("eta\0");
		const icon = Buffer.from(`${iconPath}\0`);
		const hwnd = user32.symbols.FindWindowA(null, title);
		if (!hwnd) return;
		const small = user32.symbols.LoadImageA(null, icon, 1, 16, 16, 0x10);
		const large = user32.symbols.LoadImageA(null, icon, 1, 32, 32, 0x10);
		if (small) user32.symbols.SendMessageW(hwnd, 0x0080, 0, small);
		if (large) user32.symbols.SendMessageW(hwnd, 0x0080, 1, large);
	} catch (error) {
		console.warn("[eta-desktop] failed to set the native window icon", error);
	}
}
windowRef = window;
setWindowIcon(window);

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
	server.push({ type: "native", kind, action });
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

// `close()` stops the listener and kills every shell the terminal registry started;
// without the exit hook an app quit leaves zsh processes behind. ⌘Q reaches us as a
// signal rather than a call, so the same cleanup has to hang off that too.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => process.exit(0));
}
process.on("exit", () => {
	tray.remove();
	server.close();
});
