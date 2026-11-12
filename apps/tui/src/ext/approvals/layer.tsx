import type { ApprovalList } from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import { Text } from "ink";
import { useState } from "react";
import { useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { useHostCall } from "../kit/host-call";
import { PickList } from "../kit/pick-list";
import { TextPrompt } from "../kit/text-prompt";
import { useTarget } from "../kit/wire-hooks";
import { approvalsMessages } from "./messages";

/** What `inbox.setApprovals` takes for one name, as the host counts it. */
const MAX_TOOL_NAME = 200;

/** The tools that ask first: the list, and a prompt to add one. */
export function ApprovalsLayer({ handle }: { handle: LayerHandle }) {
  const t = useMessages(approvalsMessages);
  const theme = useTheme();
  const { wire } = useShell();
  const tools = (
    useTarget("inbox")?.sections.approvals as ApprovalList | undefined
  )?.tools;
  const [adding, setAdding] = useState(false);
  const { busy, error, setError, run } = useHostCall();

  const save = (next: string[], done?: () => void) =>
    run(async () => wire.call("inbox", "setApprovals", { tools: next }), done);

  const add = (name: string) => {
    if (tools === undefined) return;
    if (name.length > MAX_TOOL_NAME) {
      setError(t("tooLong", { max: MAX_TOOL_NAME }));
      return;
    }
    if (tools.includes(name)) {
      setError(t("duplicate", { name }));
      return;
    }
    save([...tools, name], () => setAdding(false));
  };

  const leaveAdding = () => {
    setError(undefined);
    setAdding(false);
  };

  if (adding)
    return (
      <LayerFrame title={t("title")} footer={t("addFooter")}>
        <TextPrompt
          label={t("addLabel")}
          onSubmit={add}
          onCancel={leaveAdding}
          error={error}
          busy={busy ? t("saving") : undefined}
        />
      </LayerFrame>
    );

  return (
    <LayerFrame title={t("title")} footer={t("listFooter")}>
      <Text color={inkColor(theme.muted)}>{t("explain")}</Text>
      <Text> </Text>
      <PickList
        items={(tools ?? []).map((tool) => ({ key: tool, label: tool }))}
        empty={tools === undefined ? t("loading") : t("empty")}
        onPick={() => undefined}
        onKey={(input, key, marked) => {
          if (key.escape) {
            handle.close();
            return true;
          }
          if (tools === undefined) return false;
          if (input === "a") {
            setError(undefined);
            setAdding(true);
            return true;
          }
          if ((input === "d" || key.delete) && marked !== undefined) {
            save(tools.filter((tool) => tool !== marked));
            return true;
          }
          return false;
        }}
      />
      {busy && <Text color={inkColor(theme.muted)}>{t("saving")}</Text>}
      {error !== undefined && (
        <Text color={inkColor(theme.error)}>{error}</Text>
      )}
    </LayerFrame>
  );
}
