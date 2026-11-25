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
import { pathToFileURL } from "node:url";
import { thirdPartyNotices } from "../apps/eta/scripts/notices";
import {
  desktopHostLauncherName,
  desktopHostLauncherPath,
  desktopHostProcessGrants,
} from "../packages/client-contracts/src/host-launcher";
import { writeClientIcons } from "./client-icons";

const root = resolve(import.meta.dir, "..");
const cwd = join(root, "apps", "client");
const args = process.argv.slice(2);
const nsh = process.env.ETA_NSH ?? "nsh";
const fromClient = createRequire(join(cwd, "package.json"));
const meta = (await Bun.file(join(cwd, "nsh.json")).json()) as {
  id: string;
  name: string;
  version: string;
  icon: Record<string, string>;
  capabilities: { process: { execute: string[] } };
};

const granted = meta.capabilities.process.execute;
if (
  granted.length !== desktopHostProcessGrants.length ||
  granted.some(
    (name) => !(desktopHostProcessGrants as readonly string[]).includes(name),
  )
)
  throw new Error(
    `apps/client/nsh.json must grant exactly: ${desktopHostProcessGrants.join(", ")}`,
  );

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
const desktopTarget =
  packaging &&
  (target === "macos" || target === "windows" || target === "linux")
    ? target
    : undefined;
const desktop = desktopTarget !== undefined;
// Android updates by signed packages of the app's code (`nsh publish`), and
// by a new APK when the code needs a newer shell. iOS goes through the store.
const android = packaging && target === "android";
// `nsh publish` with a key signs an OTA package; `publish ios|android` uploads
// a store build, which needs nothing generated here.
const storeUpload =
  args[0] === "publish" && ["ios", "android"].includes(args[1] ?? "");
const name = option("--name") ?? meta.name;
const out = resolve(cwd, option("--out", "-o") ?? ".nsh/out");

if (!storeUpload && args[0] !== "update-manifest") {
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
// `nsh.json` names them for every package, a store upload's included.
if (args[0] !== "update-manifest") await writeClientIcons(root);

const updateUrl = process.env.ETA_CLIENT_UPDATE_URL;
const updateKey = process.env.ETA_CLIENT_UPDATE_PUBLIC_KEY;
// `stable=<manifest URL>,rc=<manifest URL>`: the channels the app's settings
// choose between by name (`checkForUpdate({ channel })`).
const updateChannels = Object.fromEntries(
  (process.env.ETA_CLIENT_UPDATE_CHANNELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("=");
      if (at < 1)
        throw new Error(
          `ETA_CLIENT_UPDATE_CHANNELS: expected name=url, got ${entry}`,
        );
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
);
// The OTA root public keys (`nsh keygen`'s root.pub) whose certified release
// keys may sign the app's packages; comma separated, to rotate one.
const packageRoots = (process.env.ETA_CLIENT_PACKAGE_ROOT ?? "")
  .split(",")
  .map((root) => root.trim())
  .filter(Boolean);
const updateEnabled = (desktop || android) && !!(updateUrl || updateKey);
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
    const manifestUrl = (url: string) => {
      const endpoint = new URL(url);
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
      return endpoint.href;
    };
    const endpoint = manifestUrl(updateUrl);
    // The app's settings always name a channel: a build given only a URL has
    // that as `stable`.
    const channels = Object.fromEntries(
      Object.entries(
        Object.keys(updateChannels).length
          ? updateChannels
          : { stable: updateUrl },
      ).map(([name, url]) => [name, manifestUrl(url)]),
    );
    // The roots go into Android builds, and into the manifest's own check of
    // the package it lists; the desktops update the whole app.
    const packages =
      (android || manifest) && packageRoots.length
        ? { packages: { roots: packageRoots } }
        : {};
    const generated = join(cwd, ".nsh");
    mkdirSync(generated, { recursive: true });
    staging = mkdtempSync(join(generated, "desktop-source-"));
    // nsh reads the app of the directory it is given, for a manifest as much as for a
    // package: it wants the App.tsx entry there, not only the nsh.json written below.
    for (const file of readdirSync(cwd)) {
      if (
        file.endsWith(".tsx") ||
        file.endsWith(".ts") ||
        file === "assets" ||
        file === "src"
      )
        cpSync(join(cwd, file), join(staging, file), { recursive: true });
    }
    if (updateEnabled) {
      const entry = command.indexOf("App.tsx", 1);
      if (entry === -1)
        throw new Error(
          "Use the Eta client App.tsx entry for updatable packages.",
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
        // Its paths are relative to nsh.json, which is written elsewhere here.
        icon: Object.fromEntries(
          Object.entries(meta.icon).map(([platform, file]) => [
            platform,
            resolve(cwd, file),
          ]),
        ),
        ...(manifest
          ? {
              id: process.env.ETA_CLIENT_ID ?? meta.id,
              version: process.env.ETA_CLIENT_VERSION ?? meta.version,
            }
          : {}),
        updater: {
          url: endpoint,
          publicKey: updateKey,
          channels,
          ...packages,
        },
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
  if (!desktopTarget) throw new Error("Choose a desktop package target.");
  const platform = {
    macos: "darwin",
    linux: "linux",
    windows: "win32",
  }[desktopTarget];
  if (platform !== process.platform)
    throw new Error(
      `Build the ${desktopTarget} desktop package on a ${desktopTarget} runner.`,
    );
  const bundle = join(out, desktopTarget === "macos" ? `${name}.app` : name);
  const resources =
    desktopTarget === "macos"
      ? join(bundle, "Contents", "Resources", "nsh")
      : desktopTarget === "linux"
        ? join(bundle, "nsh")
        : bundle;
  const bundleDirectory =
    desktopTarget === "macos" ? resources : join(bundle, "nsh");
  const launcher = join(resources, desktopHostLauncherName(desktopTarget));
  const upstream = process.env.ETA_HOST_UPSTREAM;
  const define = upstream
    ? ["--define", `ETA_HOST_UPSTREAM=${JSON.stringify(upstream)}`]
    : [];
  const arch = option("--arch");

  if (
    desktopTarget === "macos" &&
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
  const expectedLauncher = desktopHostLauncherPath(
    desktopTarget,
    pathToFileURL(join(bundleDirectory, "bundle.nshc")),
  );
  if (
    !existsSync(bundleDirectory) ||
    !existsSync(launcher) ||
    !expectedLauncher ||
    resolve(expectedLauncher) !== resolve(launcher)
  )
    throw new Error(
      `${desktopTarget} package does not put ${launcher} where the app looks for it.`,
    );

  if (desktopTarget === "macos") {
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
  } else if (desktopTarget === "linux") {
    await run("tar", ["-czf", join(out, `${name}.tar.gz`), "-C", out, name]);
  } else {
    // Windows' own bsdtar: the GNU tar of Git's bash, first on a runner's PATH, reads `D:\…` as
    // a remote host, and cannot write a zip either.
    const tar = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "tar.exe",
    );
    await run(tar, ["-ac", "-f", join(out, `${name}.zip`), "-C", out, name]);
    // NSH may have emitted an Inno installer before the launcher was available.
    const setup = join(out, `${name}-setup.exe`);
    if (existsSync(setup)) rmSync(setup);
  }

  if (updateEnabled) {
    const version = option("--app-version") ?? meta.version;
    const prefix = `${name}-${version}-${desktopTarget}-`;
    const archive = readdirSync(out).find(
      (item) =>
        item.startsWith(prefix) &&
        (item.endsWith(".tar.gz") || item.endsWith(".zip")),
    );
    if (!archive) throw new Error("NSH did not emit a desktop update archive.");
    if (desktopTarget === "macos") {
      await run("tar", ["-czf", join(out, archive), "-C", out, `${name}.app`]);
    } else {
      copyFileSync(
        join(out, `${name}.${desktopTarget === "linux" ? "tar.gz" : "zip"}`),
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
