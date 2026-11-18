import type { SkillFileArgs, SkillTarget } from "@eta/client-contracts";
import type { SkillFileService } from "./service";
import { productPlugin } from "../wire";

export function skillFilesPlugin(
  service: SkillFileService,
  applied: () => void,
) {
  return productPlugin(
    "skills",
    ({ wire }) => {
      const actions = [
        "list",
        "open",
        "directory",
        "read",
        "close",
        "create",
        "save",
        "planDelete",
        "delete",
      ] as const;
      const offs = actions.map((action) =>
        wire.handle("skills", action, async (call) => {
          const raw = call.args as
            | { target?: SkillTarget; input?: SkillFileArgs[typeof action] }
            | undefined;
          if (!raw?.target || !raw.input || typeof raw.input !== "object")
            throw new Error("skills: target and input required");
          return { result: await service.call(action, raw.target, raw.input) };
        }),
      );
      return () => {
        for (const off of offs) off();
      };
    },
    applied,
  );
}
