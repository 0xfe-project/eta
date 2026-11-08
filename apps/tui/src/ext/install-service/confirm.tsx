import type { UpgradeBusy } from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import { Box, Text, useInput } from "ink";
import { useInputActive } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { installServiceMessages } from "./messages";

const KINDS = [
  "reply",
  "task",
  "routine",
] as const satisfies readonly UpgradeBusy["kind"][];

export function ConfirmHandover({
  busy,
  handle,
  onConfirm,
}: {
  busy: UpgradeBusy[] | undefined;
  handle: LayerHandle;
  onConfirm: () => void;
}) {
  const t = useMessages(installServiceMessages);
  const active = useInputActive();
  useInput(
    (_, key) => {
      if (key.return) {
        handle.close();
        onConfirm();
      } else if (key.escape) {
        handle.close();
      }
    },
    { isActive: active },
  );
  return (
    <LayerFrame title={t("title")} footer={t("confirm")}>
      {busy === undefined ? (
        <Text>{t("mayInterrupt")}</Text>
      ) : (
        <>
          <Text>{t("willInterrupt")}</Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {KINDS.map((kind) => {
              const count = busy.filter((b) => b.kind === kind).length;
              return count === 0 ? null : (
                <Text key={kind}>{t(kind, { count })}</Text>
              );
            })}
          </Box>
        </>
      )}
    </LayerFrame>
  );
}
