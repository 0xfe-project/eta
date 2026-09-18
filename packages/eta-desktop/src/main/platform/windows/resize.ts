import { dlopen, FFIType } from "bun:ffi";

/** Add WS_THICKFRAME and refresh the frame so a hidden-title-bar window resizes. */
export function enableResizeBorder(): void {
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowA: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
			GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
			SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
			SetWindowPos: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
		});
		const hwnd = user32.symbols.FindWindowA(null, Buffer.from("eta\0"));
		if (!hwnd) return;
		const style = user32.symbols.GetWindowLongPtrW(hwnd, -16);
		user32.symbols.SetWindowLongPtrW(hwnd, -16, style | 0x00040000n);
		user32.symbols.SetWindowPos(hwnd, null, 0, 0, 0, 0, 0x37);
	} catch (error) {
		console.warn("[eta-desktop] failed to make the window resizable", error);
	}
}
