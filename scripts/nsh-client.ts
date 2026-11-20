import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { thirdPartyNotices } from "../apps/eta/scripts/notices";

const root = resolve(import.meta.dir, "..");
const cwd = join(root, "apps", "client");
const args = process.argv.slice(2);
const nsh = process.env.ETA_NSH ?? "nsh";
const fromClient = createRequire(join(cwd, "package.json"));
const meta = (await Bun.file(join(cwd, "nsh.json")).json()) as {
  id: string;
  name: string;
  version: string;
};

function option(name: string, short?: string): string | undefined {
  const index = args.findIndex(
    (arg) => arg === name || arg === short || arg.startsWith(`${name}=`),
  );
  if (index === -1) return undefined;
  return args[index]!.startsWith(`${name}=`)
    ? args[index]!.slice(name.length + 1)
    : args[index + 1];
}

async function run(
  command: string,
  args: string[],
  directory = cwd,
): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd: directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const code = await child.exited;
    if (code) throw new Error(`${command} exited with status ${code}`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

const packaging =
  args[0] === "package" && !args.includes("--help") && !args.includes("-h");
const target = option("--target");
const desktop =
  packaging &&
  (target === "macos" || target === "windows" || target === "linux");
const name = option("--name") ?? meta.name;
const out = resolve(cwd, option("--out", "-o") ?? ".nsh/out");

if (args[0] !== "publish" && args[0] !== "update-manifest") {
  copyFileSync(
    fromClient.resolve("jsqr"),
    join(cwd, "assets", "qr-decoder.txt"),
  );
  copyFileSync(
    join(
      dirname(fromClient.resolve("html2canvas-pro")),
      "html2canvas-pro.min.js",
    ),
    join(cwd, "assets", "artifact-pdf-renderer.txt"),
  );
  copyFileSync(
    fromClient.resolve("es-module-lexer/js"),
    join(cwd, "assets", "artifact-pdf-module-lexer.txt"),
  );
}

const updateUrl = process.env.ETA_CLIENT_UPDATE_URL;
const updateKey = process.env.ETA_CLIENT_UPDATE_PUBLIC_KEY;
const updateEnabled = desktop && !!(updateUrl || updateKey);
const manifest =
  args[0] === "update-manifest" &&
  !option("--entry") &&
  !args.includes("--help") &&
  !args.includes("-h") &&
  !!(updateUrl || updateKey);
let staging: string | undefined;
try {
  const command = desktop ? args.filter((arg) => arg !== "--run") : [...args];
  if (updateEnabled || manifest) {
    if (!updateUrl || !updateKey)
      throw new Error(
        "ETA_CLIENT_UPDATE_URL and ETA_CLIENT_UPDATE_PUBLIC_KEY must be set together.",
      );
    const endpoint = new URL(updateUrl);
    const local =
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== "https:" && !local) ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error(
        "Use an HTTPS manifest URL without embedded credentials.",
      );
    const generated = join(cwd, ".nsh");
    mkdirSync(generated, { recursive: true });
    staging = mkdtempSync(join(generated, "desktop-source-"));
    if (updateEnabled) {
      for (const file of readdirSync(cwd)) {
        if (file.endsWith(".tsx") || file.endsWith(".ts") || file === "assets")
          cpSync(join(cwd, file), join(staging, file), { recursive: true });
      }
      const entry = command.indexOf("App.tsx", 1);
      if (entry === -1)
        throw new Error(
          "Use the Eta client App.tsx entry for desktop packages.",
        );
      command[entry] = join(staging, "App.tsx");
      if (!option("--out", "-o")) command.push("--out", out);
    } else {
      command.push("--entry", staging);
    }
    writeFileSync(
      join(staging, "nsh.json"),
      JSON.stringify({
        ...meta,
        ...(manifest
          ? {
              id: process.env.ETA_CLIENT_ID ?? meta.id,
              version: process.env.ETA_CLIENT_VERSION ?? meta.version,
            }
          : {}),
        updater: { url: endpoint.href, publicKey: updateKey },
      }),
    );
  }
  await run(nsh, command);
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}

if (packaging && target === "web") {
  const site = join(out, name);
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(site, "index.html")).text())
    .digest("hex");
  await Bun.write(join(site, "BUILD"), `${hash}\n`);
  await Bun.write(
    join(site, "THIRD_PARTY_NOTICES.md"),
    thirdPartyNotices(root),
  );
}
if (desktop) {
  const platform = { macos: "darwin", linux: "linux", windows: "win32" }[
    target
  ];
  if (platform !== process.platform)
    throw new Error(
      `Build the ${target} desktop package on a ${target} runner.`,
    );
  const bundle = join(out, target === "macos" ? `${name}.app` : name);
  const resources =
    target === "macos"
      ? join(bundle, "Contents", "Resources", "nsh")
      : target === "linux"
        ? join(bundle, "nsh")
        : bundle;
  const launcher = join(
    resources,
    target === "windows" ? "eta-bootstrap.exe" : "eta-bootstrap",
  );
  const upstream = process.env.ETA_HOST_UPSTREAM;
  const define = upstream
    ? ["--define", `ETA_HOST_UPSTREAM=${JSON.stringify(upstream)}`]
    : [];
  const arch = option("--arch");

  if (
    target === "macos" &&
    arch &&
    arch !== (process.arch === "x64" ? "x86_64" : process.arch)
  )
    throw new Error(
      "Build the macOS app and its host launcher on the same architecture.",
    );

  // Bun may leave its intermediate executable in its current directory.
  const bootstrapWork = mkdtempSync(join(out, ".bootstrap-"));
  try {
    await run(
      process.execPath,
      [
        "build",
        "--compile",
        join(import.meta.dir, "nsh-host-bootstrap.ts"),
        "--outfile",
        launcher,
        ...define,
      ],
      bootstrapWork,
    );
  } finally {
    rmSync(bootstrapWork, { recursive: true, force: true });
  }

  if (target === "macos") {
    const sign = ["--force", "--sign", "-"];
    const entitlements = join(out, `${name}.entitlements`);
    await run("codesign", [...sign, launcher]);
    await run("codesign", [
      ...sign,
      ...(existsSync(entitlements) ? ["--entitlements", entitlements] : []),
      bundle,
    ]);
    await run("codesign", ["--verify", "--deep", bundle]);
    await run("ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      bundle,
      join(out, `${name}.zip`),
    ]);
  } else if (target === "linux") {
    await run("tar", ["-czf", join(out, `${name}.tar.gz`), "-C", out, name]);
  } else {
    await run("tar", ["-ac", "-f", join(out, `${name}.zip`), "-C", out, name]);
    // NSH may have emitted an Inno installer before the launcher was available.
    const setup = join(out, `${name}-setup.exe`);
    if (existsSync(setup)) rmSync(setup);
  }

  if (updateEnabled) {
    const version = option("--app-version") ?? meta.version;
    const prefix = `${name}-${version}-${target}-`;
    const archive = readdirSync(out).find(
      (item) =>
        item.startsWith(prefix) &&
        (item.endsWith(".tar.gz") || item.endsWith(".zip")),
    );
    if (!archive) throw new Error("NSH did not emit a desktop update archive.");
    if (target === "macos") {
      await run("tar", ["-czf", join(out, archive), "-C", out, `${name}.app`]);
    } else {
      copyFileSync(
        join(out, `${name}.${target === "linux" ? "tar.gz" : "zip"}`),
        join(out, archive),
      );
    }
  }

  if (args.includes("--run")) {
    if (target === "macos") await run("open", [bundle]);
    else
      await run(join(bundle, target === "windows" ? `${name}.exe` : name), []);
  }
}
