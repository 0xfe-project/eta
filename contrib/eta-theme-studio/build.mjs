import { cp, mkdir } from "node:fs/promises";
import process from "node:process";
import { build } from "esbuild";

async function main() {
  const output = "dist/extension";
  const files = [
    "manifest.json",
    "editor.html",
    "editor.css",
    "icons",
    "THIRD_PARTY_NOTICES.txt",
  ];
  await mkdir(output, { recursive: true });
  await Promise.all([
    ...files.map((file) =>
      cp(`src/${file}`, `${output}/${file}`, { recursive: true }),
    ),
    build({
      entryPoints: ["src/editor.js", "src/background.js", "src/content.js"],
      outdir: output,
      bundle: true,
      target: "chrome111",
      format: "iife",
      legalComments: "eof",
    }),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
