import type { Extension, SlashCommand } from "../../extensions/types";
import { translatorFor } from "../../i18n/messages";
import { ConfirmHandover } from "./confirm";
import { installServiceMessages } from "./messages";

const installService: SlashCommand = {
  name: "install-service",
  args: [],
  summary: {
    en: "Install a resident host and move to it from the temporary host",
    zh: "装常驻 host，从临时 host 换过去",
  },
  examples: [
    {
      input: "/install-service",
      summary: {
        en: "Keep agents running after eta quits",
        zh: "退出 eta 后 agent 继续运行",
      },
    },
  ],
  requiredOps: [],
  run: async (ctx) => {
    const { phase } = ctx.connection.getState();
    if (phase.name !== "connected" || !phase.temporary) {
      ctx.notify(
        translatorFor(installServiceMessages, ctx.locale)("alreadyResident"),
      );
      return;
    }
    const busy = await ctx.connection.handoverBusy();
    if (busy !== undefined && busy.length === 0) {
      await ctx.connection.handover();
      return;
    }
    const handover = () => ctx.reportFailure(ctx.connection.handover());
    ctx.openLayer((handle) => (
      <ConfirmHandover busy={busy} handle={handle} onConfirm={handover} />
    ));
  },
};

const extension: Extension = {
  id: "install-service",
  messages: installServiceMessages,
  commands: [installService],
};

export default extension;
