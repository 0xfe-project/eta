import type { ConnectionPhase } from "../../connection/types";
import type {
  Extension,
  ShellContext,
  SlashCommand,
} from "../../extensions/types";
import type { HostFile } from "./host-file";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { translatorFor } from "../../i18n/messages";
import { callErrorText } from "../kit/errors";
import { isHostFile } from "./host-file";
import { HostFilePicker, RemoteFileLayer } from "./layers";
import { homeOf, isLocalHost } from "./locality";
import { editHostConfigMessages } from "./messages";

export interface EditHostConfigOptions {
  /** The TUI's environment: its home is where a host on this computer keeps `.eta`. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Whether the connection's host runs on this computer; `isLocalHost` unless given. */
  isLocal?: (phase: ConnectionPhase) => boolean;
}

/** Where the editor (or `ssh -t`) ran, as the messages after it name the file. */
interface Opened {
  exitCode: number | null;
  program: string;
  path: string;
}

async function openLocally(
  ctx: ShellContext,
  file: HostFile,
  options: EditHostConfigOptions,
): Promise<Opened> {
  const t = translatorFor(editHostConfigMessages, ctx.locale);
  const home = homeOf(options.env, options.platform, homedir);
  const path = join(home, ".eta", file);
  const { phase } = ctx.connection.getState();
  // A resident host's own home cannot be asked; the TUI's stands in for it.
  const temporary = "temporary" in phase && phase.temporary;
  ctx.notify(t(temporary ? "opening" : "openingResident", { path }));
  const { exitCode } = await ctx.editFile(path);
  return { exitCode, program: "editor", path };
}

async function openOverSsh(
  ctx: ShellContext,
  file: HostFile,
  target: string,
): Promise<Opened> {
  const path = `~/.eta/${file}`;
  // Handed to ssh as they are: it joins what follows `--` into one line for the remote shell,
  // which expands `${EDITOR:-vi}` and `~` there.
  const { exitCode } = await ctx.runInteractive("ssh", [
    "-t",
    target,
    "--",
    // eslint-disable-next-line no-template-curly-in-string -- shell syntax for the remote shell
    "${EDITOR:-vi}",
    path,
  ]);
  return { exitCode, program: "ssh", path };
}

async function afterEditing(
  ctx: ShellContext,
  file: HostFile,
  opened: Opened,
): Promise<void> {
  const t = translatorFor(editHostConfigMessages, ctx.locale);
  const { exitCode, path } = opened;
  // Null: the program did not start (already reported) or was killed.
  if (exitCode === null) return;
  if (exitCode !== 0) {
    ctx.notify(
      t("exited", { program: opened.program, code: exitCode }),
      "warning",
    );
    return;
  }
  if (file === "mcp.json") {
    ctx.notify(t("mcpSaved", { path }));
    return;
  }
  if (!ctx.wire.can("providers.reload")) {
    ctx.notify(t("savedNoReload", { path }));
    return;
  }
  try {
    await ctx.wire.call("providers", "reload");
    ctx.notify(t("reloaded", { path }));
  } catch (error) {
    ctx.notify(
      t("reloadFailed", { path, error: callErrorText(error, ctx.locale) }),
      "error",
    );
  }
}

async function editHostFile(
  ctx: ShellContext,
  file: HostFile,
  options: EditHostConfigOptions,
): Promise<void> {
  const isLocal = options.isLocal ?? isLocalHost;
  if (isLocal(ctx.connection.getState().phase)) {
    await afterEditing(ctx, file, await openLocally(ctx, file, options));
    return;
  }
  const target = ctx.config.ssh.target;
  if (target === undefined || target === "") {
    ctx.openLayer((handle) => <RemoteFileLayer file={file} handle={handle} />);
    return;
  }
  // ssh reads an argument that starts with `-` as an option (`-oProxyCommand=…` runs a command).
  if (target.startsWith("-")) {
    ctx.notify(
      translatorFor(editHostConfigMessages, ctx.locale)("sshTargetOption", {
        target,
      }),
      "error",
    );
    return;
  }
  await afterEditing(ctx, file, await openOverSsh(ctx, file, target));
}

/** The feature, with the TUI's environment and the locality check it uses given. */
export function editHostConfigExtension(
  options: EditHostConfigOptions,
): Extension {
  const command: SlashCommand = {
    name: "edit-host-config",
    args: [
      {
        name: "file",
        required: false,
        summary: {
          en: "config.json or mcp.json; without it, a choice of the two",
          zh: "config.json 或 mcp.json；不给时从两者中选",
        },
      },
    ],
    summary: {
      en: "Edit the host's config.json or mcp.json in your editor",
      zh: "用编辑器修改 host 的 config.json 或 mcp.json",
    },
    examples: [
      {
        input: "/edit-host-config config.json",
        summary: {
          en: "Edit the host's model providers",
          zh: "修改 host 的模型 provider 设定",
        },
      },
      {
        input: "/edit-host-config mcp.json",
        summary: {
          en: "Edit the host's MCP servers",
          zh: "修改 host 的 MCP 服务器",
        },
      },
    ],
    requiredOps: [],
    run: async (ctx, argText) => {
      if (argText === "") {
        ctx.openLayer((handle) => (
          <HostFilePicker
            handle={handle}
            onPick={(file) => {
              handle.close();
              ctx.reportFailure(editHostFile(ctx, file, options));
            }}
          />
        ));
        return;
      }
      if (!isHostFile(argText)) {
        ctx.notify(
          translatorFor(editHostConfigMessages, ctx.locale)("unknownFile", {
            name: argText,
          }),
          "error",
        );
        return;
      }
      await editHostFile(ctx, argText, options);
    },
  };
  return {
    id: "edit-host-config",
    messages: editHostConfigMessages,
    commands: [command],
  };
}

export default editHostConfigExtension({
  env: process.env,
  platform: process.platform,
});
