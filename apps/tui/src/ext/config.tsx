import type { ConnectionSetting } from "../config/types";
import type { Extension, SlashCommand } from "../extensions/types";
import { defineMessages, translatorFor } from "../i18n/messages";
import { ConfigProblemsLayer } from "../ui/config-problems";

export const configMessages = defineMessages({
  en: {
    cannotCreate: "Could not create {file}: {reason}",
    notJson: "the file is not valid JSON",
    reloaded: "Settings reloaded",
    connectionNextStart: "Connection changes take effect next start",
  },
  zh: {
    cannotCreate: "没能建立 {file}：{reason}",
    notJson: "文件不是合法的 JSON",
    reloaded: "设定已重新载入",
    connectionNextStart: "连接设定下次启动生效",
  },
});

function sameConnection(
  a: ConnectionSetting | undefined,
  b: ConnectionSetting | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const config: SlashCommand = {
  name: "config",
  args: [],
  summary: {
    en: "Open the settings file in your editor and apply it when the editor closes",
    zh: "用编辑器打开设定文件，关掉编辑器后立即生效",
  },
  examples: [
    { input: "/config", summary: { en: "Edit the settings", zh: "编辑设定" } },
  ],
  requiredOps: [],
  run: async (ctx) => {
    const t = () => translatorFor(configMessages, ctx.locale);
    const problem = await ctx.ensureConfigFile();
    if (problem) {
      const reason = problem.reason === "io" ? problem.detail : t()("notJson");
      ctx.notify(t()("cannotCreate", { file: problem.file, reason }), "error");
      return;
    }
    const { exitCode } = await ctx.editFile(ctx.paths.config);
    // Null: the editor did not start (already reported) or was killed; the file is not trusted.
    if (exitCode === null) return;
    const before = ctx.config.connection;
    const problems = await ctx.reloadConfig();
    if (problems.length > 0)
      ctx.openLayer((handle) => (
        <ConfigProblemsLayer problems={problems} handle={handle} />
      ));
    if (!sameConnection(before, ctx.config.connection))
      ctx.notify(t()("connectionNextStart"), "warning");
    else if (problems.length === 0) ctx.notify(t()("reloaded"));
  },
};

const extension: Extension = {
  id: "config",
  messages: configMessages,
  commands: [config],
};

export default extension;
