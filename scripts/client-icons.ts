// The app icons NSH cannot take as they are, made from the web app's logo when the client is
// built: `apps/client/nsh.json` `icon` names them, beside the logo itself where a platform takes it
// unchanged. Written to `apps/client/.nsh/icons/`, out of git.
//
// - macOS draws its icons inset on a transparent canvas, 824 of 1024 pixels, the logo's rounded
//   square (`Eta-Logo.png`) at the size of every other app's in the Dock.
// - iOS masks a full square itself and takes no alpha channel: the vector logo (`Eta-Logo.svg`),
//   whose dark square fills the canvas, written as RGB. It is drawn at its own 2000 pixels first,
//   where its squares meet on whole pixels: drawn straight at 1024, each seam shows a faint line.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const size = 1024;
const inset = 824;

export async function writeClientIcons(root: string): Promise<void> {
  const logo = join(root, "apps", "client", "assets");
  const out = join(root, "apps", "client", ".nsh", "icons");
  await initWasm(
    await Bun.file(
      createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm"),
    ).arrayBuffer(),
  );
  const render = (svg: string, width = size) =>
    new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: { loadSystemFonts: false },
    }).render();
  const image = (png: Uint8Array, at: number, side: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="data:image/png;base64,${Buffer.from(png).toString("base64")}" x="${at}" y="${at}" width="${side}" height="${side}"/></svg>`;

  const offset = (size - inset) / 2;
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "macos.png"),
    render(
      image(await Bun.file(join(logo, "Eta-Logo.png")).bytes(), offset, inset),
    ).asPng(),
  );
  writeFileSync(
    join(out, "ios.png"),
    opaque(
      render(
        image(
          render(
            await Bun.file(join(logo, "Eta-Logo.svg")).text(),
            2000,
          ).asPng(),
          0,
          size,
        ),
      ).pixels,
    ),
  );
}

// An 8-bit RGB PNG of `size`² RGBA pixels, their alpha dropped.
function opaque(rgba: Uint8Array): Uint8Array {
  const row = size * 3 + 1;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      raw.set(rgba.subarray(from, from + 3), y * row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}
