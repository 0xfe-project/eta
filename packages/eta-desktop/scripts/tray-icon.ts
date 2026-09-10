/**
 * Window and menu-bar icons, from the SVG rather than from the exported PNG.
 *
 * The menu bar keeps only the alpha channel of a template image and tints it to
 * follow the bar, so the plate that Icon Composer baked into the exported PNGs has
 * to come off — under a template it turns the mark into a black square. What is
 * left is ten axis-aligned rectangles on a 2000-unit canvas, laid out on a 4x4
 * grid, so any size divisible by 4 rasterizes with whole-pixel cell edges: crisp
 * at 16px and at 512px alike, with no resampling anywhere.
 *
 * The tray PNGs go next to the logo in `packages/eta-client/public`, which is the
 * directory the app serves, so the shell reaches them as `views://eta/tray-*.png`.
 *
 *   bun scripts/tray-icon.ts
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const publicDir = join(here, "../../eta-client/public");
const svg = await Bun.file(join(publicDir, "Eta-Logo.svg")).text();

type Rect = { x1: number; y1: number; x2: number; y2: number };
const rects: Rect[] = [];
for (const [, d] of svg.matchAll(/<path\s+d="([^"]+)"/g)) {
	const points: [number, number][] = [];
	let x = 0;
	let y = 0;
	for (const [, command, raw] of d.matchAll(/([MmHhVvLlZz])([^MmHhVvLlZz]*)/g)) {
		const numbers = raw.trim().split(/[\s,]+/).filter((value) => value !== "").map(Number);
		const relative = command === command.toLowerCase();
		const upper = command.toUpperCase();
		if (upper === "Z") continue;
		if (upper === "H") for (const value of numbers) x = relative ? x + value : value;
		else if (upper === "V") for (const value of numbers) y = relative ? y + value : value;
		else if (upper === "M" || upper === "L") {
			x = relative ? x + (numbers[0] ?? 0) : (numbers[0] ?? 0);
			y = relative ? y + (numbers[1] ?? 0) : (numbers[1] ?? 0);
		}
		points.push([x, y]);
	}
	const xs = points.map((point) => point[0]);
	const ys = points.map((point) => point[1]);
	if (xs.length === 0) continue;
	rects.push({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
}
if (rects.length === 0) throw new Error("no <path d=...> in the logo SVG");

const minX = Math.min(...rects.map((rect) => rect.x1));
const maxX = Math.max(...rects.map((rect) => rect.x2));
const minY = Math.min(...rects.map((rect) => rect.y1));
const maxY = Math.max(...rects.map((rect) => rect.y2));
const cells = rects.map((rect) => [
	Math.round(((rect.x1 - minX) / (maxX - minX)) * 4),
	Math.round(((rect.y1 - minY) / (maxY - minY)) * 4),
	Math.round(((rect.x2 - minX) / (maxX - minX)) * 4),
	Math.round(((rect.y2 - minY) / (maxY - minY)) * 4),
] as const);
console.log(`mark: ${String(rects.length)} rects, ${String(maxX - minX)}x${String(maxY - minY)} of the canvas`);

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ?? (crc >>> 8) ^ 0xedb88320;
	return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, data.length);
	const typeBytes = new TextEncoder().encode(type);
	const crc = new Uint8Array(4);
	new DataView(crc.buffer).setUint32(0, crc32(new Uint8Array([...typeBytes, ...data])));
	return new Uint8Array([...length, ...typeBytes, ...data, ...crc]);
};

/** Black plus alpha, one flat colour, no antialiasing — all a template needs. */
function png(size: number, inset = 0.03): Uint8Array {
	const box = 4 * Math.max(1, Math.floor((size * (1 - inset * 2)) / 4));
	const offset = Math.floor((size - box) / 2);
	const per = box / 4;
	if (!Number.isInteger(per)) throw new Error(`${String(size)}px cannot hold a 4x4 grid exactly`);
	const rows: number[] = [];
	for (let row = 0; row < size; row++) {
		const pixels: number[] = [];
		const cy = Math.floor((row - offset) / per);
		for (let column = 0; column < size; column++) {
			const cx = Math.floor((column - offset) / per);
			const inside =
				cy >= 0 && cy < 4 && cx >= 0 && cx < 4 && cells.some(([x1, y1, x2, y2]) => cx >= x1 && cx < x2 && cy >= y1 && cy < y2);
			pixels.push(0, 0, 0, inside ? 255 : 0);
		}
		rows.push(0, ...pixels);
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, size);
	view.setUint32(4, size);
	header[8] = 8;
	header[9] = 6;
	return new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10,
		...chunk("IHDR", header),
		...chunk("IDAT", deflateSync(new Uint8Array(rows))),
		...chunk("IEND", new Uint8Array(0)),
	]);
}

for (const [name, size] of [
	["tray-16.png", 16],
	["tray-18@2x.png", 36],
	["tray-22@2x.png", 44],
] as const) {
	writeFileSync(join(publicDir, name), png(size));
	console.log(`public/${name} (${String(size)}px, ${String(size / 4)}px per cell)`);
}

/**
 * The app icon is the opposite case — full colour, plate and all — so it is the
 * exported logo, resized by `sips`. Committed, because a build should not need
 * this script.
 */
const iconset = join(here, "../icon.iconset");
mkdirSync(iconset, { recursive: true });
const source = join(publicDir, "Eta-Logo.png");
for (const [name, size] of [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
] as const) {
	const done = Bun.spawnSync({ cmd: ["sips", "-z", String(size), String(size), source, "--out", join(iconset, name)], stdout: "ignore", stderr: "ignore" });
	if (done.exitCode !== 0) throw new Error(`sips failed on ${name}`);
}
console.log(`icon.iconset/ 10 sizes from public/Eta-Logo.png`);
