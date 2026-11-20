import type { LlmAccounts } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, Label, row } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

export function GatewayAccounts() {
  const host = useHost();
  const c = colors();
  const accounts = () => host.section<LlmAccounts>("llm", "accounts");
  return (
    <Each of={accounts()?.connections ?? []} key={(item) => item.id}>
      {(item) => (
        <View
          style={{
            ...row,
            minHeight: 55,
            paddingHorizontal: 16,
            gap: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label weight={500}>{item().label}</Label>
            <Label size={12} tone="muted">
              {`${item().connector} · ${item().state}`}
            </Label>
          </View>
          <Button
            label={
              item().state === "disabled" ? uiText("enable") : uiText("disable")
            }
            onPress={() =>
              void host.action(() =>
                host.call("llm", "setEnabled", {
                  id: item().id,
                  enabled: item().state === "disabled",
                }),
              )
            }
          />
        </View>
      )}
    </Each>
  );
}
