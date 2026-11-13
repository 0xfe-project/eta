import type { LayerHandle } from "../../extensions/types";
import { Text, useInput } from "ink";
import { useEffect } from "react";
import { useInputActive } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { agentMessages } from "./messages";

/**
 * The files that hold what the user wrote in edits that ended with their shell, each path in
 * full on its own line. `onShown` runs once it is on screen; any key closes it.
 */
export function KeptFilesLayer({
  paths,
  handle,
  onShown,
}: {
  paths: readonly string[];
  handle: LayerHandle;
  onShown: () => void;
}) {
  const t = useMessages(agentMessages);
  const active = useInputActive();
  useInput(() => handle.close(), { isActive: active });
  useEffect(onShown, [onShown]);
  return (
    <LayerFrame title={t("keptTitle")} footer={t("keptFooter")}>
      {paths.map((path) => (
        <Text key={path}>{path}</Text>
      ))}
    </LayerFrame>
  );
}
