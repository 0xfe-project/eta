// The image's Codex plugins (its bundles' plugins, compiled into a local
// marketplace when the agent's image was built) installed into CODEX_HOME,
// which is on the agent's volume: Codex only loads installed copies. Every
// start installs them again from the image, and removes the ones an older
// image installed that this one lacks.

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Plugins' MCP configs (.mcp.json) are static files, and Codex expands no
// variables in them; these are filled in once a plugin is installed.
const VARIABLES = /\$\{(AXP_GATEWAY_URL|AXP_WORKSPACE_DIR)\}/g;
const ENABLED = /^\[plugins\."([^"]+)"\]/gm;

export interface PluginSettings {
  pluginsDir: string;
  codexHome: string;
  gatewayUrl: string;
  workspace: string;
}

interface Catalog {
  name: string;
  plugins: { name: string }[];
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function installPlugins(s: PluginSettings): Promise<string[]> {
  const text = await readOptional(
    join(s.pluginsDir, ".agents", "plugins", "marketplace.json"),
  );
  if (text === undefined) {
    return [];
  }
  const catalog = JSON.parse(text) as Catalog;
  const marketplace = catalog.name;
  const codex = [
    "--config",
    `marketplaces.${marketplace}.source_type="local"`,
    "--config",
    `marketplaces.${marketplace}.source=${JSON.stringify(s.pluginsDir)}`,
    "plugin",
  ];
  const env = { ...process.env, CODEX_HOME: s.codexHome };
  const wanted = catalog.plugins.map(
    (plugin) => `${plugin.name}@${marketplace}`,
  );
  const config = (await readOptional(join(s.codexHome, "config.toml"))) ?? "";
  const enabled = [...config.matchAll(ENABLED)].map((match) => match[1]!);
  for (const name of enabled) {
    if (name.endsWith(`@${marketplace}`) && !wanted.includes(name)) {
      await run("codex", [...codex, "remove", name], { env, timeout: 60_000 });
    }
  }
  const values: Record<string, string> = {
    AXP_GATEWAY_URL: s.gatewayUrl,
    AXP_WORKSPACE_DIR: s.workspace,
  };
  for (const plugin of catalog.plugins) {
    await run("codex", [...codex, "add", `${plugin.name}@${marketplace}`], {
      env,
      timeout: 60_000,
    });
    const installed = join(
      s.codexHome,
      "plugins",
      "cache",
      marketplace,
      plugin.name,
    );
    for (const version of await readdir(installed)) {
      const path = join(installed, version, ".mcp.json");
      const mcp = await readOptional(path);
      if (mcp !== undefined) {
        await writeFile(
          path,
          mcp.replace(VARIABLES, (_, name: string) => values[name]!),
        );
      }
    }
  }
  return wanted;
}
