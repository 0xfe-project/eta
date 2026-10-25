import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { libraryPath, modelsDirPath } from "../src/index";

const root = join(import.meta.dirname, "..");
const repoRoot = join(root, "..", "..");
const outLib = libraryPath();
const modelsDir = modelsDirPath();

await mkdir(dirname(outLib), { recursive: true });
await mkdir(modelsDir, { recursive: true });

// 1. Prepare the 3 real pretrained ONNX models if not already present
if (
  !existsSync(join(modelsDir, "ui_detector_embed.onnx")) ||
  !existsSync(join(modelsDir, "ocr_rec.onnx")) ||
  !existsSync(join(modelsDir, "openjev_system1.onnx")) ||
  !existsSync(join(modelsDir, "bpe_vocab.tsv"))
) {
  const prepareProc = Bun.spawn(
    [
      "uv",
      "run",
      "--project",
      join(repoRoot, "apps", "memory"),
      // `onnx` is only needed to quantize the decision model while preparing it, so it is an
      // ephemeral dependency of this step rather than one the memory sidecar carries.
      "--with",
      "onnx",
      "python",
      join(root, "scripts", "prepare-real-models.py"),
      modelsDir,
    ],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await prepareProc.exited;
  if (code !== 0) {
    process.exitCode = code;
    throw new Error(`prepare-real-models.py exited with code ${code}`);
  }
}

// 2. Build the Rust cdylib (`libeta_computer.so` / `.dylib` / `.dll`)
const cargoProc = Bun.spawn(
  [
    "cargo",
    "build",
    "--release",
    "--manifest-path",
    join(root, "native", "Cargo.toml"),
  ],
  {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
const cargoCode = await cargoProc.exited;
if (cargoCode !== 0) {
  process.exitCode = cargoCode;
  throw new Error(`cargo build exited with code ${cargoCode}`);
}

const ext =
  process.platform === "darwin"
    ? "dylib"
    : process.platform === "win32"
      ? "dll"
      : "so";
const prefix = process.platform === "win32" ? "" : "lib";
const builtArtifact = join(
  root,
  "native",
  "target",
  "release",
  `${prefix}eta_computer.${ext}`,
);
await copyFile(builtArtifact, outLib);
