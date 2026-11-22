import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  checkedImage,
  imageLimit,
  normalizeTheme,
  validImageUrl,
} from "./theme.js";

const archiveLimit = imageLimit + 65536;
const themeLimit = 16384;
const themeFile = "theme.json";

export function exportTheme(settings) {
  const theme = normalizeTheme(settings.theme);
  const files = {};
  if (validImageUrl(settings.image)) {
    const bytes = Uint8Array.from(atob(settings.image.split(",")[1]), (char) =>
      char.charCodeAt(0),
    );
    const { file } = checkedImage(bytes);
    theme.wallpaper.file = file;
    files[file] = [bytes, { level: 0 }];
  } else {
    delete theme.wallpaper.file;
  }
  files[themeFile] = strToU8(`${JSON.stringify(theme, null, 2)}\n`);
  return zipSync(files);
}

export function importTheme(bytes) {
  if (!bytes.length || bytes.length > archiveLimit)
    throw new Error("主题包过大，壁纸上限为 4 MB。");
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let files;
  let manifest = bytes;
  if (isZip) {
    files = unzipSync(bytes, {
      filter: ({ name, originalSize }) =>
        name === themeFile
          ? originalSize <= themeLimit
          : /^wallpaper\.(?:png|jpg|gif|webp)$/.test(name) &&
            originalSize <= imageLimit,
    });
    manifest = Object.hasOwn(files, themeFile) ? files[themeFile] : undefined;
  }
  if (!manifest || manifest.length > themeLimit)
    throw new Error("主题包中缺少有效的 theme.json。");
  const theme = normalizeTheme(JSON.parse(strFromU8(manifest)));
  const path = theme.wallpaper.file;
  if (!path) return { theme, image: null, imageName: "" };
  if (!files || !Object.hasOwn(files, path))
    throw new Error("主题包中缺少 theme.json 指定的壁纸文件。");
  const imageBytes = files[path];
  const { mime, file } = checkedImage(imageBytes);
  if (file !== path) throw new Error("壁纸内容与主题中声明的格式不匹配。");
  let binary = "";
  for (let offset = 0; offset < imageBytes.length; offset += 8192)
    binary += String.fromCharCode(
      ...imageBytes.subarray(offset, offset + 8192),
    );
  return {
    theme,
    image: `data:${mime};base64,${btoa(binary)}`,
    imageName: file,
  };
}
