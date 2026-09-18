import { dlopen, FFIType } from "bun:ffi";

/** Disable Windows 11 rounded corners to match eta's square client geometry. */
export function squareWindowCorners(): void {
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowA: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
		});
		const hwnd = user32.symbols.FindWindowA(null, Buffer.from("eta\0"));
		if (!hwnd) return;
		const dwmapi = dlopen("dwmapi.dll", {
			DwmSetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		});
		dwmapi.symbols.DwmSetWindowAttribute(hwnd, 33, Buffer.from([1, 0, 0, 0]), 4);
	} catch (error) {
		console.warn("[eta-desktop] failed to square the window corners", error);
	}
}
