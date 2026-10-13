import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, test } from "bun:test";
import { installPlugins } from "./plugins.ts";

// A stand-in for `codex plugin add|remove`: it logs the call and, on add,
// copies the plugin's .mcp.json into CODEX_HOME's cache as Codex does.
const FAKE_CODEX = `#!/bin/sh
echo "$*" >> "$CODEX_HOME/calls"
for last; do :; done
name="\${last%@*}"
case "$*" in
  *" plugin add "*)
    mkdir -p "$CODEX_HOME/plugins/cache/axp/$name/1.0.0"
    cp "$PLUGINS/$name/.mcp.json" "$CODEX_HOME/plugins/cache/axp/$name/1.0.0/.mcp.json"
    printf '[plugins."%s"]\\nenabled = true\\n' "$last" >> "$CODEX_HOME/config.toml"
    ;;
esac
`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "axp-plugins-"));
  const pluginsDir = join(root, "plugins");
  const codexHome = join(root, "codex");
  const bin = join(root, "bin");
  await mkdir(join(pluginsDir, ".agents", "plugins"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(pluginsDir, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "axp",
      plugins: [{ name: "weather" }, { name: "tasks" }],
    }),
  );
  for (const name of ["weather", "tasks"]) {
    await mkdir(join(pluginsDir, name), { recursive: true });
    await writeFile(
      join(pluginsDir, name, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          [name]: {
            url: `\${AXP_GATEWAY_URL}/${name}/mcp`,
            bearer_token_env_var: "AXP_AGENT_KEY",
          },
        },
      }),
    );
  }
  await writeFile(join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PLUGINS = pluginsDir;
  const settings = {
    pluginsDir,
    codexHome,
    gatewayUrl: "http://runtime-gateway:8090",
    workspace: "/agent/workspace",
  };
  return { settings, codexHome };
}

test("a disabled plugin is left out, and removed once its config goes", async () => {
  const { settings, codexHome } = await setup();
  const configured = await installPlugins({ ...settings, disabledPlugins: [] });
  expect(configured).toEqual(["weather@axp", "tasks@axp"]);
  const mcp = JSON.parse(
    await readFile(
      join(codexHome, "plugins/cache/axp/weather/1.0.0/.mcp.json"),
      "utf8",
    ),
  );
  // Installed with the gateway filled in.
  expect(mcp.mcpServers.weather).toEqual({
    url: "http://runtime-gateway:8090/weather/mcp",
    bearer_token_env_var: "AXP_AGENT_KEY",
  });

  const unconfigured = await installPlugins({
    ...settings,
    disabledPlugins: ["weather"],
  });
  expect(unconfigured).toEqual(["tasks@axp"]);
  const calls = (await readFile(join(codexHome, "calls"), "utf8")).trim();
  expect(calls.split("\n").filter((c) => c.includes(" remove "))).toEqual([
    expect.stringContaining("plugin remove weather@axp"),
  ]);
});
