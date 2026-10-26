import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { libraryPath, modelsDirPath } from "../src/index";

const root = join(import.meta.dirname, "..");
const repoRoot = join(root, "..", "..");
const outLib = libraryPath();
const modelsDir = modelsDirPath();
const runtimeCacheDir = join(root, "native", "target", "ort-runtime");
const ogaCacheDir = join(root, "native", "target", "oga-runtime");

/// ONNX Runtime 1.30.0 (API 1..26) satisfies both `ort` (`api-22`) and `onnxruntime-genai` 0.17.0.
const ORT_VERSION = "1.30.0";
// The OpenVINO package is the only official build that carries `OpenVINOExecutionProvider`, and it
// stops at 1.24.1 — so asking for it pins the whole runtime back six minor versions.
const ORT_OPENVINO_VERSION = "1.24.1";
const OGA_VERSION = "0.17.0";

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

// 2. Provision ONNX Runtime + ONNX Runtime GenAI and build the Rust cdylib (`libeta_computer.so` / `.dylib` / `.dll`).
// The runtime is linked as an import library and shipped next to the cdylib, so a GPU build can be
// swapped in without recompiling — which is also what makes the execution-provider probe at load
// time meaningful.
const ortLibDir = await provisionOrtRuntime();
const ogaLibDir = await provisionOgaRuntime();
// Unix loaders resolve the runtime next to the cdylib via an rpath; Windows does not have one, so
// `src/index.ts` preloads `onnxruntime.dll` and `onnxruntime-genai.dll` from the same directory instead.
const rpath =
  process.platform === "darwin"
    ? "-C link-arg=-Wl,-rpath,@loader_path"
    : process.platform === "linux"
      ? "-C link-arg=-Wl,-rpath,$ORIGIN"
      : "";
const linkSearch = `-L native=${ogaLibDir}`;
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
    env: {
      ...process.env,
      ORT_LIB_LOCATION: ortLibDir,
      ORT_PREFER_DYNAMIC_LINK: "1",
      RUSTFLAGS: [process.env.RUSTFLAGS, rpath, linkSearch]
        .filter(Boolean)
        .join(" "),
    },
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

// 3. Ship ONNX Runtime + ONNX Runtime GenAI beside the cdylib.
const runtimeLibPattern =
  process.platform === "win32"
    ? /\.dll$/i
    : process.platform === "darwin"
      ? /\.dylib$/i
      : /\.so(\.\d+)*$/i;
// Switching variants leaves the previous runtime behind, and a stale `libonnxruntime.so.1` would
// silently win over the one just provisioned.
for (const entry of await readdir(dirname(outLib))) {
  if (!entry.startsWith("libonnxruntime.") || !entry.includes(".so")) continue;
  await rm(join(dirname(outLib), entry), { force: true });
}
for (const dir of [ortLibDir, ogaLibDir]) {
  for (const entry of await readdir(dir)) {
    if (!runtimeLibPattern.test(entry)) continue;
    const source = join(dir, entry);
    if (!(await stat(source)).isFile()) continue;
    await copyFile(source, join(dirname(outLib), entry));
  }
}

console.log(
  `[eta-computer] built ${outLib} against ONNX Runtime (${ortLibDir}) + OGA (${ogaLibDir})`,
);

/// Resolves `<cache>/<asset>/lib`, downloading the ONNX Runtime release when the cache is cold.
async function provisionOrtRuntime(): Promise<string> {
  const configured = process.env.ETA_ORT_RUNTIME_DIR;
  if (configured !== undefined && configured !== "") {
    return join(configured, "lib");
  }

  if (await shouldUseOpenVinoRuntime()) return provisionOpenVinoOrtRuntime();

  const gpu = await shouldUseGpuRuntime();
  const asset = runtimeAssetName(gpu);
  const extracted = join(runtimeCacheDir, asset);
  const libDir = join(extracted, "lib");
  if (existsSync(libDir)) return libDir;

  await mkdir(runtimeCacheDir, { recursive: true });
  const archiveExt = process.platform === "win32" ? "zip" : "tgz";
  const url = `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${asset}.${archiveExt}`;
  const archive = join(runtimeCacheDir, `${asset}.${archiveExt}`);
  if (!existsSync(archive)) {
    console.log(
      `[eta-computer] downloading ONNX Runtime ${asset} (${gpu ? "CUDA" : "CPU"})`,
    );
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to download ${url}: ${response.status}`);
    }
    await Bun.write(archive, response);
  }

  const extractArgs =
    archiveExt === "zip" ? ["-xf", archive] : ["-xzf", archive];
  const extractProc = Bun.spawn(
    ["tar", ...extractArgs, "-C", runtimeCacheDir],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await extractProc.exited) !== 0) {
    throw new Error(`failed to extract ${archive}`);
  }
  if (!existsSync(libDir)) {
    throw new Error(`${asset} did not contain a lib/ directory`);
  }
  return libDir;
}

/// `ETA_COMPUTER_ORT_VARIANT=openvino` selects the OpenVINO build, which is the only official
/// package registering `OpenVINOExecutionProvider` (Intel CPU/GPU/NPU).
async function shouldUseOpenVinoRuntime(): Promise<boolean> {
  const variant = process.env.ETA_COMPUTER_ORT_VARIANT?.trim().toLowerCase();
  if (variant === "openvino" || variant === "ov") return true;
  if (variant !== undefined && variant !== "") return false;
  // A device request is itself an intent to use the EP, so it selects the variant too.
  return ["ETA_OPENVINO_DEVICE", "ETA_OPENVINO_CACHE"].some((key) => {
    const value = process.env[key]?.trim();
    return value !== undefined && value !== "";
  });
}

/// Stages the OpenVINO wheel's `capi/` directory as a plain runtime directory. The wheel is the only
/// distribution point for this EP on Linux, so it is fetched (+extracted) rather than built.
async function provisionOpenVinoOrtRuntime(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "ETA_COMPUTER_ORT_VARIANT=openvino is only wired up for linux-x64",
    );
  }
  const asset = `onnxruntime-openvino-${ORT_OPENVINO_VERSION}`;
  const libDir = join(runtimeCacheDir, asset, "lib");
  if (existsSync(join(libDir, "libonnxruntime.so.1"))) return libDir;

  await mkdir(runtimeCacheDir, { recursive: true });
  const wheelDir = join(runtimeCacheDir, `${asset}.wheel`);
  const capi = join(wheelDir, "onnxruntime", "capi");
  if (!existsSync(join(capi, "libonnxruntime.so.1.24.1"))) {
    const listing = (await (
      await fetch(
        `https://pypi.org/pypi/onnxruntime-openvino/${ORT_OPENVINO_VERSION}/json`,
      )
    ).json()) as { urls: { filename: string; url: string }[] };
    const wheel = listing.urls.find(
      (entry) =>
        entry.filename.includes("manylinux") &&
        entry.filename.includes("x86_64") &&
        entry.filename.includes("cp3"),
    );
    if (wheel === undefined) {
      throw new Error(`no manylinux x86_64 wheel for ${asset}`);
    }
    console.log(`[eta-computer] downloading ${wheel.filename} (OpenVINO EP)`);
    const response = await fetch(wheel.url);
    if (!response.ok) {
      throw new Error(`failed to download ${wheel.url}: ${response.status}`);
    }
    const archive = join(runtimeCacheDir, wheel.filename);
    await Bun.write(archive, response);
    const unzipProc = Bun.spawn(["unzip", "-oq", archive, "-d", wheelDir], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await unzipProc.exited) !== 0) throw new Error(`failed to unzip ${archive}`);
  }

  // The linker wants a bare `libonnxruntime.so`; the loader resolves the SONAME, so both names and
  // the OpenVINO provider + plugin libraries have to sit in the same directory.
  await mkdir(libDir, { recursive: true });
  for (const entry of await readdir(capi)) {
    if (!/\.so(?:\.\d+)*$/.test(entry)) continue;
    const source = join(capi, entry);
    if (!(await stat(source)).isFile()) continue;
    await copyFile(source, join(libDir, entry));
  }
  for (const [alias, target] of [
    ["libonnxruntime.so", `libonnxruntime.so.${ORT_OPENVINO_VERSION}`],
    ["libonnxruntime.so.1", `libonnxruntime.so.${ORT_OPENVINO_VERSION}`],
  ] as const) {
    const link = join(libDir, alias);
    if (existsSync(link)) continue;
    await symlink(target, link);
  }
  return libDir;
}

/// A CUDA runtime is only worth its ~300 MB when explicitly requested (`ETA_COMPUTER_ORT_VARIANT=gpu`),
/// since the default pure-vision WeVisOne-VL-2B OGA pipeline targets local CPU/NPU execution.
async function shouldUseGpuRuntime(): Promise<boolean> {
  const configured = process.env.ETA_COMPUTER_ORT_VARIANT?.trim().toLowerCase();
  if (configured === "gpu") return true;
  return false;
}

function runtimeAssetName(gpu: boolean): string {
  switch (process.platform) {
    case "darwin":
      // Apple silicon builds carry the CoreML provider; CUDA/TensorRT have no macOS counterpart.
      return `onnxruntime-osx-${process.arch === "arm64" ? "arm64" : "x86_64"}-${ORT_VERSION}`;
    case "win32":
      return `onnxruntime-win-x64${gpu ? "-gpu_cuda12" : ""}-${ORT_VERSION}`;
    default:
      // Only the x64 Linux tarballs ship a CUDA build.
      if (process.arch !== "x64") {
        return `onnxruntime-linux-${process.arch === "arm64" ? "aarch64" : process.arch}-${ORT_VERSION}`;
      }
      return `onnxruntime-linux-x64${gpu ? "-gpu_cuda12" : ""}-${ORT_VERSION}`;
  }
}

async function provisionOgaRuntime(): Promise<string> {
  const configured = process.env.ETA_OGA_RUNTIME_DIR;
  if (configured !== undefined && configured !== "") {
    return join(configured, "lib");
  }

  const asset = ogaAssetName();
  const versionDir = join(ogaCacheDir, OGA_VERSION);
  const extracted = join(versionDir, asset);
  const libDir = join(extracted, "lib");
  if (existsSync(libDir)) return libDir;

  await mkdir(versionDir, { recursive: true });
  const archiveExt = process.platform === "win32" ? "zip" : "tar.gz";
  const url = `https://github.com/microsoft/onnxruntime-genai/releases/download/v${OGA_VERSION}/${asset}.${archiveExt}`;
  const archive = join(versionDir, `${asset}.${archiveExt}`);
  if (!existsSync(archive)) {
    console.log(`[eta-computer] downloading ONNX Runtime GenAI ${asset}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to download ${url}: ${response.status}`);
    }
    await Bun.write(archive, response);
  }

  const extractArgs =
    archiveExt === "zip" ? ["-xf", archive] : ["-xzf", archive];
  const extractProc = Bun.spawn(["tar", ...extractArgs, "-C", versionDir], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await extractProc.exited) !== 0) {
    throw new Error(`failed to extract ${archive}`);
  }
  if (!existsSync(libDir)) {
    throw new Error(`${asset} did not contain a lib/ directory`);
  }
  return libDir;
}

function ogaAssetName(): string {
  switch (process.platform) {
    case "darwin":
      return `onnxruntime-genai-${OGA_VERSION}-osx-arm64`;
    case "win32":
      return `onnxruntime-genai-${OGA_VERSION}-win-${process.arch === "arm64" ? "arm64" : "x64"}`;
    default:
      return `onnxruntime-genai-${OGA_VERSION}-linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
  }
}
