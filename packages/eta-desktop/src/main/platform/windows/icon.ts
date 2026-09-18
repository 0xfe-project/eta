import { existsSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

/** Apply the packaged ICO to the native HWND. Electrobun does not expose this yet. */
export function setWindowIcon(iconPath: string): void {
	if (!existsSync(iconPath)) return;
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowA: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
			LoadImageA: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		});
		const hwnd = user32.symbols.FindWindowA(null, Buffer.from("eta\0"));
		if (!hwnd) return;
		const icon = Buffer.from(`${iconPath}\0`);
		const small = user32.symbols.LoadImageA(null, icon, 1, 16, 16, 0x10);
		const large = user32.symbols.LoadImageA(null, icon, 1, 32, 32, 0x10);
		if (small) user32.symbols.SendMessageW(hwnd, 0x0080, 0, small);
		if (large) user32.symbols.SendMessageW(hwnd, 0x0080, 1, large);
	} catch (error) {
		console.warn("[eta-desktop] failed to set the native window icon", error);
	}
}
