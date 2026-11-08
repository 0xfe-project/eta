import type { LayerHandle } from "../../extensions/types";
import type { HostFile } from "./host-file";
import { Text, useInput } from "ink";
import { useInputActive } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { ChoiceList } from "../../ui/components/choice-list";
import { LayerFrame } from "../../ui/components/layer-frame";
import { HOST_FILES } from "./host-file";
import { editHostConfigMessages } from "./messages";

/** Asks which of the host's files to edit, with a line about each; Esc closes it. */
export function HostFilePicker({
  handle,
  onPick,
}: {
  handle: LayerHandle;
  onPick: (file: HostFile) => void;
}) {
  const t = useMessages(editHostConfigMessages);
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) handle.close();
    },
    { isActive: active },
  );
  const hints: Record<HostFile, string> = {
    "config.json": t("configHint"),
    "mcp.json": t("mcpHint"),
  };
  return (
    <LayerFrame title={t("pickTitle")} footer={t("pickFooter")}>
      <ChoiceList
        choices={HOST_FILES.map((file) => ({ label: file, hint: hints[file] }))}
        onChoose={(index) => {
          const file = HOST_FILES[index];
          if (file !== undefined) onPick(file);
        }}
      />
    </LayerFrame>
  );
}

/** Where a remote host's file is, and how to edit it from here; any key closes it. */
export function RemoteFileLayer({
  file,
  handle,
}: {
  file: HostFile;
  handle: LayerHandle;
}) {
  const t = useMessages(editHostConfigMessages);
  const active = useInputActive();
  useInput(() => handle.close(), { isActive: active });
  return (
    <LayerFrame title={t("remoteTitle", { file })} footer={t("remoteFooter")}>
      <Text>{t("remoteWhere", { file })}</Text>
      <Text>{t("remoteHow")}</Text>
    </LayerFrame>
  );
}
