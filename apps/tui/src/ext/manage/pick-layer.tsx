import type { LayerHandle } from "../../extensions/types";
import type { Row } from "../../ui/components/row-list";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { useActionGate } from "../../ui/components/layer-space";
import { useListHeight, useRowCursor } from "../../ui/components/row-cursor";
import { RowList } from "../../ui/components/row-list";
import { manageMessages } from "./messages";

/** A layer to choose one row from; choosing closes it before `onChoose` runs. */
export function PickLayer({
  title,
  rows,
  onChoose,
  handle,
}: {
  title: string;
  rows: readonly Row[];
  onChoose: (index: number) => void;
  handle: LayerHandle;
}) {
  const t = useMessages(manageMessages);
  const height = useListHeight();
  const gate = useActionGate();
  const cursor = useRowCursor(
    rows.length,
    (index) => {
      handle.close();
      onChoose(index);
    },
    handle.close,
    gate,
  );
  return (
    <LayerFrame title={title} footer={t("pickFooter")}>
      <RowList rows={rows} cursor={cursor} height={height} gate={gate} />
    </LayerFrame>
  );
}
