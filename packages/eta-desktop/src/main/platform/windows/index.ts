import { join } from "node:path";
import { PATHS, type BrowserWindow } from "electrobun/main";
import { setWindowIcon } from "./icon.ts";
import { enableResizeBorder } from "./resize.ts";
import { squareWindowCorners } from "./corners.ts";

/** Windows-only window chrome. The main shell calls this only on win32. */
export function configureWindowsWindow(_window: BrowserWindow): void {
	const iconPath = join(PATHS.VIEWS_FOLDER, "eta", "Eta-Logo.ico");
	setWindowIcon(iconPath);
	enableResizeBorder();
	squareWindowCorners();
}
