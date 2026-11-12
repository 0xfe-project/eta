import type { LayerHandle } from "../../extensions/types";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { providersMessages } from "./messages";
import { ProvidersPanel } from "./providers-panel";

/** `/providers`: the accounts panel in a layer of its own, closed by Esc on the list. */
export function ProvidersLayer({ handle }: { handle: LayerHandle }) {
  const t = useMessages(providersMessages);
  return (
    <LayerFrame title={t("title")}>
      <ProvidersPanel onLeave={handle.close} />
    </LayerFrame>
  );
}
