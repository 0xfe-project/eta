import type { ConfigProblem } from "../config/types";
import type { LayerHandle } from "../extensions/types";
import { Text, useInput } from "ink";
import { useInputActive } from "../extensions/react";
import { useMessages } from "../i18n/react";
import { LayerFrame } from "./components/layer-frame";
import { configProblemMessages } from "./shell/messages";

/** A layer listing what in the settings file was not used, one line per key; any key closes it. */
export function ConfigProblemsLayer({
  problems,
  handle,
}: {
  problems: readonly ConfigProblem[];
  handle: LayerHandle;
}) {
  const t = useMessages(configProblemMessages);
  const active = useInputActive();
  useInput(() => handle.close(), { isActive: active });
  return (
    <LayerFrame title={t("title")} footer={t("footer")}>
      {problems.map((problem) => {
        const reason = t(problem.reason);
        return (
          <Text key={`${problem.file}:${problem.key}:${problem.reason}`}>
            {t("line", {
              file: problem.file,
              key: problem.key === "" ? t("wholeFile") : problem.key,
              reason:
                problem.detail === undefined
                  ? reason
                  : t("withDetail", { reason, detail: problem.detail }),
            })}
          </Text>
        );
      })}
    </LayerFrame>
  );
}
